import { appEvents, AppEvent } from './events.js';
import { releaseFunds, refundFunds } from './escrow/index.js';
import { jobQueue, JobType } from './jobs/index.js';
import { prisma } from '../lib/prisma.js';
import { telegramBot } from './telegram/bot.js';
import { buildTemplatedTelegramNotification } from './notifications/telegram.js';
import { DealStatus } from '@prisma/client';
import { dealChatService } from './deal-chat/index.js';

const TERMINAL_DEAL_STATUSES_FOR_CHAT_CLOSE = new Set<string>([
  DealStatus.CANCELLED,
  DealStatus.COMPLETED,
  DealStatus.EXPIRED,
  DealStatus.REFUNDED,
  DealStatus.RESOLVED,
]);

let listenersInitialized = false;

/**
 * Setup event listeners for automated escrow and workflow actions
 */
export function setupEventListeners() {
  if (listenersInitialized) {
    return;
  }

  listenersInitialized = true;
  console.log('Setting up event listeners...');
  const publishRetryOptions = {
    attempts: 4,
    backoff: {
      type: 'exponential' as const,
      delay: 15000,
    },
  };

  // ========================================================================
  // ESCROW AUTOMATION
  // ========================================================================

  // Auto-release funds when deal is completed
  appEvents.on(AppEvent.DEAL_COMPLETED, async (data) => {
    console.log(`Triggering fund release for completed deal: ${data.dealId}`);
    
    try {
      const deal = await prisma.deal.findUnique({
        where: { id: data.dealId },
        include: {
          escrowWallet: true,
          channel: { include: { owner: true } },
        },
      });

      if (!deal || !deal.escrowWallet) {
        console.error(`No escrow wallet found for deal ${data.dealId}`);
        return;
      }

      if (deal.escrowStatus !== 'HELD') {
        console.warn(`Escrow not in HELD status for deal ${data.dealId}, status: ${deal.escrowStatus}`);
        return;
      }

      // Release funds to channel owner
      await releaseFunds(deal.id);
    } catch (error) {
      console.error(`Failed to release funds for deal ${data.dealId}:`, error);
    }
  });

  // Auto-refund when post is violated
  appEvents.on(AppEvent.POST_VIOLATION_DETECTED, async (data) => {
    console.log(`Triggering refund for violated post: ${data.dealId}`);
    
    try {
      const deal = await prisma.deal.findUnique({
        where: { id: data.dealId },
        include: {
          escrowWallet: true,
          advertiser: true,
        },
      });

      if (!deal || !deal.escrowWallet) {
        console.error(`No escrow wallet found for deal ${data.dealId}`);
        return;
      }

      if (deal.escrowStatus !== 'HELD') {
        console.warn(`Escrow not in HELD status for deal ${data.dealId}`);
        return;
      }

      // Refund to advertiser
      await refundFunds(deal.id);
    } catch (error) {
      console.error(`Failed to refund for deal ${data.dealId}:`, error);
    }
  });

  // Auto-refund when deal is cancelled with payment
  appEvents.on(AppEvent.DEAL_CANCELLED, async (data) => {
    console.log(`Checking refund for cancelled deal: ${data.dealId}`);
    
    try {
      const deal = await prisma.deal.findUnique({
        where: { id: data.dealId },
        include: {
          escrowWallet: true,
        },
      });

      if (!deal || !deal.escrowWallet) {
        return; // No escrow, nothing to refund
      }

      if (deal.escrowStatus === 'HELD') {
        await refundFunds(deal.id);
      }
    } catch (error) {
      console.error(`Failed to refund for cancelled deal ${data.dealId}:`, error);
    }
  });

  // Auto-refund when deal times out
  appEvents.on(AppEvent.DEAL_TIMED_OUT, async (data) => {
    console.log(`Triggering refund for timed out deal: ${data.dealId}`);
    
    try {
      const deal = await prisma.deal.findUnique({
        where: { id: data.dealId },
        include: {
          escrowWallet: true,
        },
      });

      if (!deal || !deal.escrowWallet) {
        return;
      }

      if (deal.escrowStatus === 'HELD') {
        await refundFunds(deal.id);
      }
    } catch (error) {
      console.error(`Failed to refund for timed out deal ${data.dealId}:`, error);
    }
  });

  // Close deal chat bridge and finalize Telegram topics for terminal states.
  appEvents.on(AppEvent.DEAL_STATUS_CHANGED, async (data) => {
    if (!TERMINAL_DEAL_STATUSES_FOR_CHAT_CLOSE.has(data.newStatus)) {
      return;
    }

    console.log(`Finalizing deal chat for terminal deal status: ${data.dealId} -> ${data.newStatus}`);

    try {
      await dealChatService.closeDealChatBySystem({ dealId: data.dealId });
      await telegramBot.finalizeDealTopicsOnClose(data.dealId);
    } catch (error) {
      console.error(`Failed to finalize deal chat for terminal deal ${data.dealId}:`, error);
    }
  });

  // ========================================================================
  // BRIEF APPLICATION NOTIFICATIONS
  // ========================================================================

  // Notify advertiser when someone applies to their brief
  appEvents.on(AppEvent.BRIEF_APPLICATION_SUBMITTED, async (data) => {
    console.log(`Notifying advertiser about new application: ${data.applicationId}`);
    
    try {
      const advertiser = await prisma.user.findUnique({
        where: { id: data.advertiserId },
        select: { telegramId: true },
      });

      if (!advertiser?.telegramId) {
        console.warn(`Advertiser ${data.advertiserId} has no telegramId`);
        return;
      }

      const notification = buildTemplatedTelegramNotification(
        'B01',
        { briefTitle: data.briefTitle },
        { briefId: data.briefId },
      );

      await telegramBot.sendNotification(
        advertiser.telegramId,
        notification.text,
        {
          parseMode: notification.parseMode,
          replyMarkup: notification.replyMarkup,
        }
      );
    } catch (error) {
      console.error(`Failed to notify advertiser about application ${data.applicationId}:`, error);
    }
  });

  // Notify channel owner when their application is accepted
  appEvents.on(AppEvent.BRIEF_APPLICATION_ACCEPTED, async (data) => {
    console.log(`Notifying channel owner about accepted application: ${data.applicationId}`);
    
    try {
      const channelOwner = await prisma.user.findUnique({
        where: { id: data.channelOwnerId },
        select: { telegramId: true },
      });

      if (!channelOwner?.telegramId) {
        console.warn(`Channel owner ${data.channelOwnerId} has no telegramId`);
        return;
      }

      const notification = buildTemplatedTelegramNotification(
        'B02',
        { briefTitle: data.briefTitle, dealNumber: data.dealNumber },
        { dealId: data.dealId, briefId: data.briefId },
      );

      await telegramBot.sendNotification(
        channelOwner.telegramId,
        notification.text,
        {
          parseMode: notification.parseMode,
          replyMarkup: notification.replyMarkup,
        }
      );
    } catch (error) {
      console.error(`Failed to notify channel owner about accepted application ${data.applicationId}:`, error);
    }
  });

  // Notify channel owner when their application is rejected
  appEvents.on(AppEvent.BRIEF_APPLICATION_REJECTED, async (data) => {
    console.log(`Notifying channel owner about rejected application: ${data.applicationId}`);
    
    try {
      const channelOwner = await prisma.user.findUnique({
        where: { id: data.channelOwnerId },
        select: { telegramId: true },
      });

      if (!channelOwner?.telegramId) {
        console.warn(`Channel owner ${data.channelOwnerId} has no telegramId`);
        return;
      }

      const notification = buildTemplatedTelegramNotification(
        'B03',
        { reason: data.reason, briefTitle: data.briefTitle },
        { briefId: data.briefId },
      );

      await telegramBot.sendNotification(
        channelOwner.telegramId,
        notification.text,
        {
          parseMode: notification.parseMode,
          replyMarkup: notification.replyMarkup,
        }
      );
    } catch (error) {
      console.error(`Failed to notify channel owner about rejected application ${data.applicationId}:`, error);
    }
  });

  // ========================================================================
  // AUTO-POSTING WORKFLOW
  // ========================================================================

  // Schedule auto-posting when creative is approved
  appEvents.on(AppEvent.CREATIVE_APPROVED, async (data) => {
    console.log(`Scheduling post for deal: ${data.dealId}`);
    
    try {
      const deal = await prisma.deal.findUnique({
        where: { id: data.dealId },
        select: {
          status: true,
          scheduledTime: true,
        },
      });

      if (!deal) return;
      if (deal.status !== 'SCHEDULED') {
        console.log(`Skipping auto-post schedule for deal ${data.dealId}: status is ${deal.status}`);
        return;
      }

      // Schedule post job
      const postTime = data.scheduledTime || deal.scheduledTime || new Date();
      const delay = postTime.getTime() - Date.now();

      if (delay > 0) {
        // Schedule for future
        await jobQueue.addJob(
          JobType.PUBLISH_POST,
          {
            dealId: data.dealId,
            creativeId: data.creativeId,
          },
          {
            delay,
            jobId: `publish:${data.dealId}:${data.creativeId}`,
            ...publishRetryOptions,
          },
        );
      } else {
        // Publish immediately
        await jobQueue.addJob(
          JobType.PUBLISH_POST,
          {
            dealId: data.dealId,
            creativeId: data.creativeId,
          },
          {
            jobId: `publish:${data.dealId}:${data.creativeId}`,
            ...publishRetryOptions,
          },
        );
      }
    } catch (error) {
      console.error(`Failed to schedule post for deal ${data.dealId}:`, error);
    }
  });

  // ========================================================================
  // CHANNEL VERIFICATION
  // ========================================================================

  // Schedule admin verification when channel is created
  appEvents.on(AppEvent.CHANNEL_CREATED, async (data) => {
    console.log(`Scheduling admin verification for channel: ${data.channelId}`);
    
    await jobQueue.addJob(JobType.VERIFY_CHANNEL_ADMIN, {
      channelId: data.channelId,
    });
  });

  // Deactivate channel when admin status is lost
  appEvents.on(AppEvent.CHANNEL_ADMIN_STATUS_LOST, async (data) => {
    console.log(`Admin status lost for channel: ${data.channelId}`);
    
    try {
      await prisma.channel.update({
        where: { id: data.channelId },
        data: {
          status: 'SUSPENDED',
        },
      });
    } catch (error) {
      console.error(`Failed to suspend channel ${data.channelId}:`, error);
    }
  });

  // ========================================================================
  // STATS UPDATES
  // ========================================================================

  // Refresh stats when channel is verified
  appEvents.on(AppEvent.CHANNEL_VERIFIED, async (data) => {
    console.log(`Refreshing stats for newly verified channel: ${data.channelId}`);
    
    await jobQueue.addJob(JobType.REFRESH_CHANNEL_STATS, {
      channelId: data.channelId,
    });
  });

  console.log('Event listeners setup complete');
}
