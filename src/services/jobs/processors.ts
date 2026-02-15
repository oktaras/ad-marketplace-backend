import { Job } from 'bullmq';
import { jobQueue, JobType, JobData } from './index.js';
import { updateChannelStats, refreshAllChannelStats } from '../telegram/stats.js';
import {
  checkAndUpdateChannelStatus,
  recheckAllChannelAdminStatus,
} from '../telegram/verification.js';
import { publishDealCreative } from '../telegram/posting.js';
import { monitorDealPost, scheduledVerificationCheck } from '../telegram/monitor.js';
import { prisma } from '../../lib/prisma.js';
import { DealStatus } from '@prisma/client';
import { appEvents, AppEvent } from '../events.js';
import { dealService } from '../deal/index.js';

/**
 * Register all job processors
 */
export function registerJobProcessors() {
  console.log('Registering job processors...');

  // Stats refresh processors
  jobQueue.registerWorker(JobType.REFRESH_CHANNEL_STATS, processRefreshChannelStats);
  jobQueue.registerWorker(JobType.REFRESH_ALL_STATS, processRefreshAllStats);

  // Post publishing processors
  jobQueue.registerWorker(JobType.PUBLISH_POST, processPublishPost);

  // Post verification processors
  jobQueue.registerWorker(JobType.VERIFY_POST, processVerifyPost);
  jobQueue.registerWorker(JobType.MONITOR_POST, processMonitorPost);

  // Deal timeout processors
  jobQueue.registerWorker(JobType.CHECK_DEAL_TIMEOUTS, processCheckDealTimeouts);
  jobQueue.registerWorker(JobType.SEND_TIMEOUT_WARNING, processSendTimeoutWarning);
  jobQueue.registerWorker(JobType.EXPIRE_DEAL, processExpireDeal);

  // Channel verification processors
  jobQueue.registerWorker(JobType.VERIFY_CHANNEL_ADMIN, processVerifyChannelAdmin);
  jobQueue.registerWorker(JobType.RECHECK_ALL_ADMIN_STATUS, processRecheckAllAdminStatus);

  console.log('All job processors registered');
}

// ============================================================================
// STATS PROCESSORS
// ============================================================================

async function processRefreshChannelStats(job: Job<JobData[JobType.REFRESH_CHANNEL_STATS]>) {
  const { channelId } = job.data;
  await updateChannelStats(channelId);
}

async function processRefreshAllStats(job: Job<JobData[JobType.REFRESH_ALL_STATS]>) {
  await refreshAllChannelStats();
}

// ============================================================================
// POSTING PROCESSORS
// ============================================================================

async function processPublishPost(job: Job<JobData[JobType.PUBLISH_POST]>) {
  const { dealId, creativeId } = job.data;

  try {
    // Move SCHEDULED -> POSTING through transition service so status history stays complete.
    // If the deal is already POSTING (retry case), continue with publish attempt.
    const postingTransition = await dealService.updateStatus(dealId, DealStatus.POSTING, 'SYSTEM', {
      reason: 'Auto posting started',
    });

    if (!postingTransition._transitioned && postingTransition.status !== DealStatus.POSTING) {
      if (postingTransition.postedMessageId) {
        console.log(`⏭️ Deal ${dealId} already posted (messageId: ${postingTransition.postedMessageId}), skipping`);
      } else {
        console.log(`⏭️ Deal ${dealId} is in status ${postingTransition.status}, skipping publish`);
      }
      return;
    }

    // This will post and update deal status to POSTED
    await publishDealCreative(dealId, creativeId);

    // Get deal to check post info for scheduling verification
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: {
        postedMessageId: true,
        channelId: true,
        postedAt: true,
      },
    });

    if (deal?.postedMessageId && deal.channelId && deal.postedAt) {
      // Schedule immediate verification
      await jobQueue.addJob(JobType.VERIFY_POST, {
        dealId,
        messageId: Number(deal.postedMessageId),
        channelId: deal.channelId,
      });

      // Schedule ongoing monitoring (check every hour for 24 hours)
      // TODO: Temporarily set to 1 minute for testing (check immediately after 1 minute)
      const verificationEndTime = new Date(deal.postedAt.getTime() + 1 * 60 * 1000);
      
      // Schedule a single verification check after the verification period
      await jobQueue.addJob(
        JobType.MONITOR_POST,
        {
          dealId,
          messageId: Number(deal.postedMessageId),
          channelId: deal.channelId,
          verificationEndTime,
        },
        { delay: 1 * 60 * 1000 }, // Check after 1 minute
      );
    }
  } catch (error) {
    console.error(`Failed to publish post for deal ${dealId}:`, error);

    const maxAttempts = typeof job.opts.attempts === 'number' && job.opts.attempts > 0
      ? job.opts.attempts
      : 1;
    const currentAttempt = job.attemptsMade + 1;
    const isFinalAttempt = currentAttempt >= maxAttempts;

    if (isFinalAttempt) {
      const reason = `Auto-posting failed after ${currentAttempt} attempt(s): ${(error as Error).message}`;

      try {
        await dealService.updateStatus(dealId, DealStatus.CANCELLED, 'SYSTEM', { reason });
      } catch (statusError) {
        console.error(`Failed to set deal ${dealId} to CANCELLED on final posting failure:`, statusError);
      }

      await prisma.deal.update({
        where: { id: dealId },
        data: {
          notes: reason,
        },
      });
    } else {
      console.warn(
        `Publish retry scheduled for deal ${dealId} (${currentAttempt}/${maxAttempts})`,
      );
    }

    throw error;
  }
}

// ============================================================================
// VERIFICATION PROCESSORS
// ============================================================================

async function processVerifyPost(job: Job<JobData[JobType.VERIFY_POST]>) {
  const { dealId } = job.data;
  await monitorDealPost(dealId);
}

async function processMonitorPost(job: Job<JobData[JobType.MONITOR_POST]>) {
  const { dealId, verificationEndTime } = job.data;

  // Check if verification period has ended
  if (new Date() >= verificationEndTime) {
    // Final verification
    await monitorDealPost(dealId);
  } else {
    // Ongoing monitoring
    await monitorDealPost(dealId);
  }
}

// ============================================================================
// DEAL TIMEOUT PROCESSORS
// ============================================================================

async function processCheckDealTimeouts(job: Job<JobData[JobType.CHECK_DEAL_TIMEOUTS]>) {
  console.log('Checking for deal timeouts...');

  const TIMEOUT_HOURS = 7 * 24; // 7 days
  const WARNING_HOURS = 24; // Warn 24 hours before timeout

  const now = new Date();
  const timeoutThreshold = new Date(now.getTime() - TIMEOUT_HOURS * 60 * 60 * 1000);
  const warningThreshold = new Date(now.getTime() - (TIMEOUT_HOURS - WARNING_HOURS) * 60 * 60 * 1000);

  // Find deals that should be timed out
  const dealsToTimeout = await prisma.deal.findMany({
    where: {
      status: {
        in: [
          DealStatus.CREATED,
          DealStatus.NEGOTIATING,
          DealStatus.TERMS_AGREED,
          DealStatus.AWAITING_PAYMENT,
          DealStatus.AWAITING_CREATIVE,
          DealStatus.CREATIVE_REVISION,
          DealStatus.AWAITING_POSTING_PLAN,
          DealStatus.POSTING_PLAN_AGREED,
          DealStatus.SCHEDULED,
          DealStatus.AWAITING_MANUAL_POST,
        ],
      },
      updatedAt: {
        lte: timeoutThreshold,
      },
    },
  });

  // Find deals that need a warning
  const dealsToWarn = await prisma.deal.findMany({
    where: {
      status: {
        in: [
          DealStatus.CREATED,
          DealStatus.NEGOTIATING,
          DealStatus.TERMS_AGREED,
          DealStatus.AWAITING_PAYMENT,
          DealStatus.AWAITING_CREATIVE,
          DealStatus.CREATIVE_REVISION,
          DealStatus.AWAITING_POSTING_PLAN,
          DealStatus.POSTING_PLAN_AGREED,
          DealStatus.SCHEDULED,
          DealStatus.AWAITING_MANUAL_POST,
        ],
      },
      updatedAt: {
        lte: warningThreshold,
        gt: timeoutThreshold,
      },
    },
  });

  // Schedule timeout jobs
  for (const deal of dealsToTimeout) {
    await jobQueue.addJob(JobType.EXPIRE_DEAL, { dealId: deal.id });
  }

  // Schedule warning jobs
  for (const deal of dealsToWarn) {
    await jobQueue.addJob(JobType.SEND_TIMEOUT_WARNING, { dealId: deal.id });
  }

  console.log(`Found ${dealsToTimeout.length} deals to timeout, ${dealsToWarn.length} to warn`);
}

async function processSendTimeoutWarning(job: Job<JobData[JobType.SEND_TIMEOUT_WARNING]>) {
  const { dealId } = job.data;

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
  });

  if (!deal) return;

  // Emit warning event
  appEvents.emit(AppEvent.DEAL_TIMEOUT_WARNING, {
    dealId,
    hoursRemaining: 24,
  });

  // Mark warning as sent
  await prisma.deal.update({
    where: { id: dealId },
    data: {
      metadata: {
        ...(deal.metadata as object),
        timeoutWarningSent: new Date().toISOString(),
      },
    },
  });
}

async function processExpireDeal(job: Job<JobData[JobType.EXPIRE_DEAL]>) {
  const { dealId } = job.data;

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { escrowWallet: true },
  });

  if (!deal) return;

  // Skip if deal is no longer in an active state
  const activeStatuses = [
    DealStatus.CREATED,
    DealStatus.NEGOTIATING,
    DealStatus.TERMS_AGREED,
    DealStatus.AWAITING_PAYMENT,
    DealStatus.AWAITING_CREATIVE,
    DealStatus.CREATIVE_REVISION,
    DealStatus.AWAITING_POSTING_PLAN,
    DealStatus.POSTING_PLAN_AGREED,
    DealStatus.SCHEDULED,
    DealStatus.AWAITING_MANUAL_POST,
  ] as const;
  
  if (!activeStatuses.includes(deal.status as any)) {
    return;
  }

  console.log(`⏱️  Timing out deal ${dealId}`);

  // Move timed-out deals to EXPIRED through transition service.
  await dealService.updateStatus(dealId, DealStatus.EXPIRED, 'SYSTEM', {
    reason: 'Deal timed out due to inactivity',
  });

  await prisma.deal.update({
    where: { id: dealId },
    data: {
      notes: 'Deal timed out due to inactivity',
    },
  });

  // Emit timeout event
  appEvents.emit(AppEvent.DEAL_TIMED_OUT, {
    dealId,
    currentStatus: deal.status,
  });

  // If payment was made, trigger refund
  if (deal.escrowWallet && deal.escrowStatus === 'HELD') {
    // Refund will be handled by the event listener
  }
}

// ============================================================================
// CHANNEL VERIFICATION PROCESSORS
// ============================================================================

async function processVerifyChannelAdmin(job: Job<JobData[JobType.VERIFY_CHANNEL_ADMIN]>) {
  const { channelId } = job.data;
  await checkAndUpdateChannelStatus(channelId);
}

async function processRecheckAllAdminStatus(job: Job<JobData[JobType.RECHECK_ALL_ADMIN_STATUS]>) {
  await recheckAllChannelAdminStatus();
}
