import { prisma } from '../../lib/prisma.js';
import { appEvents, AppEvent } from '../events.js';
import { DealStatus } from '@prisma/client';
import { dealService } from '../deal/index.js';
import { fetchChannelPostSnapshotFromMtproto } from './mtproto.js';

export interface VerificationResult {
  exists: boolean;
  isEdited: boolean;
  isDeleted: boolean;
  violationType?: 'deleted' | 'edited' | 'hidden';
}

function isVerificationPrerequisiteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('mtproto is not configured')
    || message.includes('mtproto user session is not connected')
    || message.includes('mtproto user session is unavailable')
    || message.includes('deal has no agreed posting guarantee term')
  );
}

function resolveVerificationWindowHours(
  postingGuaranteeTermHours: number | null,
  durationHours: number,
): number {
  if (
    typeof postingGuaranteeTermHours === 'number'
    && Number.isFinite(postingGuaranteeTermHours)
    && postingGuaranteeTermHours > 0
  ) {
    return postingGuaranteeTermHours;
  }

  // Legacy fallback for deals created before posting-plan guarantee term existed.
  if (Number.isFinite(durationHours) && durationHours > 0) {
    return durationHours;
  }

  throw new Error('Deal has no agreed posting guarantee term');
}

/**
 * Verify a posted message meets requirements
 */
export async function verifyPost(
  channelUsername: string,
  messageId: number,
  ownerId: string,
): Promise<VerificationResult> {
  try {
    const postSnapshot = await fetchChannelPostSnapshotFromMtproto({
      ownerId,
      channelUsername,
      messageId,
    });

    if (!postSnapshot.exists) {
      return {
        exists: false,
        isEdited: false,
        isDeleted: true,
        violationType: 'deleted',
      };
    }

    const isEdited = !!postSnapshot.editDate;

    return {
      exists: true,
      isEdited,
      isDeleted: false,
      violationType: isEdited ? 'edited' : undefined,
    };
  } catch (error) {
    console.error('Error verifying post:', error);
    throw error;
  }
}

/**
 * Monitor a deal's post for violations during verification period
 */
export async function monitorDealPost(dealId: string): Promise<void> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      channel: true,
    },
  });

  if (!deal) {
    throw new Error('Deal not found');
  }

  if (deal.status !== DealStatus.POSTED) {
    return;
  }

  if (!deal.postedMessageId) {
    throw new Error('Deal has no posted message');
  }

  if (!deal.postedAt) {
    throw new Error('Post time not recorded');
  }

  if (!deal.channel.username) {
    throw new Error('Channel username is missing');
  }

  try {
    // Verify the post
    const verification = await verifyPost(
      deal.channel.username,
      Number(deal.postedMessageId),
      deal.channel.ownerId,
    );

    if (verification.isDeleted) {
      // Post was deleted - violation!
      await handlePostViolation(dealId, 'deleted');
      return;
    }

    if (verification.isEdited) {
      // Post was edited - violation!
      await handlePostViolation(dealId, 'edited');
      return;
    }

    // Check if verification period has passed.
    const verificationDuration = resolveVerificationWindowHours(
      deal.postingGuaranteeTermHours,
      deal.durationHours,
    );
    const verificationEndTime = new Date(
      deal.postedAt.getTime() + verificationDuration * 60 * 60 * 1000,
    );

    if (new Date() >= verificationEndTime) {
      // Verification period complete, post is valid
      await completeDealVerification(dealId);
    }
  } catch (error) {
    if (isVerificationPrerequisiteError(error)) {
      console.warn(
        `Skipping post verification for deal ${dealId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    console.error(`Error monitoring deal ${dealId}:`, error);
    throw error;
  }
}

/**
 * Handle post violation (deletion or unauthorized edit)
 */
async function handlePostViolation(
  dealId: string,
  violationType: 'deleted' | 'edited' | 'hidden',
): Promise<void> {
  console.log(`🚨 Post violation detected for deal ${dealId}: ${violationType}`);

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      escrowWallet: true,
    },
  });

  if (!deal) return;

  if (deal.status !== DealStatus.POSTED && deal.status !== DealStatus.VERIFIED) {
    return;
  }

  // Emit violation event
  appEvents.emit(AppEvent.POST_VIOLATION_DETECTED, {
    dealId,
    violationType,
    detectedAt: new Date(),
  });

  await dealService.updateStatus(dealId, DealStatus.REFUNDED, 'SYSTEM', {
    reason: `Post ${violationType} during verification period`,
    violationType,
  });

  await prisma.deal.update({
    where: { id: dealId },
    data: {
      notes: `Post ${violationType} during verification period`,
      deletedAt: violationType === 'deleted' ? new Date() : undefined,
    },
  });

  // Trigger refund (this will be handled by escrow service)
  // The event listener will handle the refund process
}

/**
 * Complete deal verification and trigger fund release
 */
async function completeDealVerification(dealId: string): Promise<void> {
  console.log(`✅ Verification complete for deal ${dealId}`);

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: {
      postedAt: true,
      status: true,
    },
  });

  if (!deal || !deal.postedAt || deal.status !== DealStatus.POSTED) return;

  // Calculate verification duration
  const verificationDuration = (new Date().getTime() - deal.postedAt.getTime()) / (1000 * 60 * 60);

  // Emit verification complete event
  appEvents.emit(AppEvent.POST_VERIFIED, {
    dealId,
    verificationDuration,
  });

  const verifiedTransition = await dealService.updateStatus(dealId, DealStatus.VERIFIED, 'SYSTEM', {
    verificationDuration,
  });

  if (!verifiedTransition._transitioned && verifiedTransition.status !== DealStatus.VERIFIED) {
    return;
  }

  await dealService.updateStatus(dealId, DealStatus.COMPLETED, 'SYSTEM', {
    verificationDuration,
  });
}

/**
 * Get post stats (views, reactions, etc.)
 * Note: This requires channel to be added to bot's channel list
 * and may not be available for all channels
 */
export async function getPostStats(channelUsername: string, messageId: number) {
  try {
    // Telegram Bot API doesn't provide view counts directly
    // This would require MTProto access or the channel owner
    // to use bot father to grant stats access
    
    // For now, return placeholder
    return {
      views: null,
      forwards: null,
      reactions: null,
      message: 'Stats require MTProto access or bot stats permission',
    };
  } catch (error) {
    console.error('Error getting post stats:', error);
    return null;
  }
}

/**
 * Schedule periodic verification checks
 * This will be called by the job queue
 */
export async function scheduledVerificationCheck(): Promise<void> {
  console.log('Running scheduled post verification checks...');

  // Find all deals in POSTED status
  const activeDeals = await prisma.deal.findMany({
    where: {
      status: DealStatus.POSTED,
      postedMessageId: { not: null },
      postedAt: { not: null },
    },
    include: {
      channel: true,
    },
  });

  for (const deal of activeDeals) {
    try {
      await monitorDealPost(deal.id);
      
      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      console.error(`Failed to verify deal ${deal.id}:`, error);
    }
  }

  console.log(`Verified ${activeDeals.length} active posts`);
}
