import { bot } from './bot.js';
import { prisma } from '../../lib/prisma.js';
import { appEvents, AppEvent } from '../events.js';

export interface AdminCheckResult {
  isAdmin: boolean;
  hasPostPermission: boolean;
  hasEditPermission: boolean;
  hasDeletePermission: boolean;
  canManageChannel: boolean;
}

/**
 * Verify if bot is admin in a channel with required permissions
 */
export async function verifyChannelBotStatus(
  channelUsername: string,
): Promise<AdminCheckResult> {
  try {
    const chatId = channelUsername.startsWith('@')
      ? channelUsername
      : `@${channelUsername}`;

    // Get chat administrators
    const admins = await bot.api.getChatAdministrators(chatId);

    // Find our bot in the admin list
    const botUser = await bot.api.getMe();
    const botAdmin = admins.find((admin) => admin.user.id === botUser.id);

    if (!botAdmin) {
      return {
        isAdmin: false,
        hasPostPermission: false,
        hasEditPermission: false,
        hasDeletePermission: false,
        canManageChannel: false,
      };
    }

    // Check permissions
    const canPost =
      botAdmin.status === 'creator' ||
      (botAdmin.status === 'administrator' && botAdmin.can_post_messages === true);

    const canEdit =
      botAdmin.status === 'creator' ||
      (botAdmin.status === 'administrator' && botAdmin.can_edit_messages === true);

    const canDelete =
      botAdmin.status === 'creator' ||
      (botAdmin.status === 'administrator' && botAdmin.can_delete_messages === true);

    const canManage =
      botAdmin.status === 'creator' ||
      (botAdmin.status === 'administrator' && botAdmin.can_manage_chat === true);

    return {
      isAdmin: true,
      hasPostPermission: canPost,
      hasEditPermission: canEdit,
      hasDeletePermission: canDelete,
      canManageChannel: canManage,
    };
  } catch (error: any) {
    console.error('Error verifying bot admin status:', error);

    // Handle specific errors
    if (error.error_code === 400 && error.description?.includes('chat not found')) {
      throw new Error('Channel not found. Please check the username.');
    }

    if (error.error_code === 400 && error.description?.includes('CHAT_ADMIN_REQUIRED')) {
      throw new Error('Bot needs to be added as administrator to the channel.');
    }

    return {
      isAdmin: false,
      hasPostPermission: false,
      hasEditPermission: false,
      hasDeletePermission: false,
      canManageChannel: false,
    };
  }
}

/**
 * Verify channel admin status and update database
 */
export async function checkAndUpdateChannelStatus(channelId: string): Promise<void> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
  });

  if (!channel) {
    throw new Error('Channel not found');
  }

  if (!channel.username) {
    throw new Error('Channel username is missing');
  }

  try {
    const adminStatus = await verifyChannelBotStatus(channel.username);

    const wasVerified = channel.botIsAdmin;
    const isNowVerified = adminStatus.isAdmin && adminStatus.hasPostPermission;
    const activatedAt = isNowVerified && !channel.verifiedAt ? new Date() : channel.verifiedAt;
    const nextStatus = isNowVerified && channel.status !== 'REMOVED' ? 'ACTIVE' : channel.status;

    // Update channel status
    await prisma.channel.update({
      where: { id: channelId },
      data: {
        botIsAdmin: isNowVerified,
        isVerified: isNowVerified,
        verifiedAt: activatedAt,
        status: nextStatus,
        botPermissions: {
          canPost: adminStatus.hasPostPermission,
          canEdit: adminStatus.hasEditPermission,
          canDelete: adminStatus.hasDeletePermission,
          canManage: adminStatus.canManageChannel,
        },
      },
    });

    // Emit event if status changed
    if (wasVerified && !isNowVerified) {
      appEvents.emit(AppEvent.CHANNEL_ADMIN_STATUS_LOST, {
        channelId: channel.id,
        ownerId: channel.ownerId,
      });
    } else if (!wasVerified && isNowVerified) {
      appEvents.emit(AppEvent.CHANNEL_VERIFIED, {
        channelId: channel.id,
        ownerId: channel.ownerId,
      });
    }
  } catch (error) {
    console.error(`Failed to verify channel ${channelId}:`, error);
    // Mark as unverified on error
    await prisma.channel.update({
      where: { id: channelId },
      data: {
        botIsAdmin: false,
      },
    });
    throw error;
  }
}

/**
 * Batch verify all active channels
 */
export async function recheckAllChannelAdminStatus(): Promise<void> {
  console.log('Starting batch admin status verification...');

  const activeChannels = await prisma.channel.findMany({
    where: {
      status: 'ACTIVE',
    },
    select: {
      id: true,
      username: true,
    },
  });

  let verified = 0;
  let failed = 0;

  for (const channel of activeChannels) {
    try {
      await checkAndUpdateChannelStatus(channel.id);
      verified++;
      
      // Rate limiting: wait 100ms between checks
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`Failed to verify channel ${channel.username}:`, error);
      failed++;
    }
  }

  console.log(
    `Admin status verification complete: ${verified} verified, ${failed} failed out of ${activeChannels.length} channels`,
  );
}

/**
 * Verify admin status before critical operations
 */
export async function verifyAdminBeforeOperation(channelId: string): Promise<void> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      username: true,
      botIsAdmin: true,
      updatedAt: true,
    },
  });

  if (!channel) {
    throw new Error('Channel not found');
  }

  // Check if we need to re-verify (if last check was more than 1 hour ago)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const needsRecheck = channel.updatedAt < oneHourAgo;

  if (needsRecheck || !channel.botIsAdmin) {
    await checkAndUpdateChannelStatus(channelId);
    
    // Re-fetch channel to get updated status
    const updatedChannel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { botIsAdmin: true },
    });

    if (!updatedChannel?.botIsAdmin) {
      throw new Error(
        'Bot is not an administrator in this channel or lacks required permissions. Please add the bot as admin with post messages permission.',
      );
    }
  } else if (!channel.botIsAdmin) {
    throw new Error(
      'Bot is not an administrator in this channel. Please add the bot as admin.',
    );
  }
}

/**
 * Check if user is channel admin
 */
export async function verifyUserChannelAdmin(
  channelUsername: string,
  userId: bigint,
): Promise<boolean> {
  try {
    const chatId = channelUsername.startsWith('@')
      ? channelUsername
      : `@${channelUsername}`;

    const admins = await bot.api.getChatAdministrators(chatId);
    return admins.some((admin) => admin.user.id === Number(userId));
  } catch (error) {
    console.error('Error verifying user admin status:', error);
    return false;
  }
}
