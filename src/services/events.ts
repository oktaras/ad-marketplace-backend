import { EventEmitter } from 'eventemitter3';
import { NotificationChannel, NotificationType } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { telegramBot } from './telegram/bot.js';
import { buildTemplatedTelegramNotification, type NotificationActionContext } from './notifications/telegram.js';
import type { ChatActionKey, ChatTemplateId, ChatTemplateParams } from './notifications/catalog.js';
import { isTemplateDeliveryEnabled, projectUserNotificationSettings } from './notifications/preferences.js';
import { config } from '../config/index.js';

export enum AppEvent {
  // Deal lifecycle events
  DEAL_CREATED = 'deal.created',
  DEAL_STATUS_CHANGED = 'deal.status.changed',
  DEAL_ACCEPTED = 'deal.accepted',
  DEAL_CANCELLED = 'deal.cancelled',
  DEAL_COMPLETED = 'deal.completed',
  
  // Payment events
  PAYMENT_RECEIVED = 'payment.received',
  PAYMENT_RELEASED = 'payment.released',
  PAYMENT_REFUNDED = 'payment.refunded',
  
  // Creative events
  CREATIVE_SUBMITTED = 'creative.submitted',
  CREATIVE_APPROVED = 'creative.approved',
  CREATIVE_REVISION_REQUESTED = 'creative.revision.requested',
  
  // Posting events
  POST_SCHEDULED = 'post.scheduled',
  POST_PUBLISHED = 'post.published',
  POST_VERIFIED = 'post.verified',
  POST_VIOLATION_DETECTED = 'post.violation.detected',
  
  // Channel events
  CHANNEL_CREATED = 'channel.created',
  CHANNEL_VERIFIED = 'channel.verified',
  CHANNEL_ADMIN_STATUS_LOST = 'channel.admin.status.lost',
  
  // Brief application events
  BRIEF_APPLICATION_SUBMITTED = 'brief.application.submitted',
  BRIEF_APPLICATION_ACCEPTED = 'brief.application.accepted',
  BRIEF_APPLICATION_REJECTED = 'brief.application.rejected',
  
  // Stats events
  STATS_UPDATED = 'stats.updated',
  
  // Timeout events
  DEAL_TIMEOUT_WARNING = 'deal.timeout.warning',
  DEAL_TIMED_OUT = 'deal.timed.out',
}

export interface EventPayload {
  // Deal events
  'deal.created': { dealId: string; channelOwnerId: string; advertiserId: string };
  'deal.status.changed': { dealId: string; oldStatus: string; newStatus: string; userId: string };
  'deal.accepted': { dealId: string; channelOwnerId: string; advertiserId: string };
  'deal.cancelled': { dealId: string; reason: string; cancelledBy: string };
  'deal.completed': { dealId: string; channelOwnerId: string; advertiserId: string };
  
  // Payment events
  'payment.received': { dealId: string; amount: string; transactionHash: string };
  'payment.released': { dealId: string; recipientId: string; amount: string; transactionHash: string };
  'payment.refunded': { dealId: string; recipientId: string; amount: string; reason: string };
  
  // Creative events
  'creative.submitted': { dealId: string; creativeId: string; channelOwnerId: string; advertiserId: string };
  'creative.approved': { dealId: string; creativeId: string; advertiserId: string; scheduledTime?: Date };
  'creative.revision.requested': { dealId: string; creativeId: string; feedback: string; advertiserId: string };
  
  // Posting events
  'post.scheduled': { dealId: string; scheduledTime: Date };
  'post.published': { dealId: string; messageId: number; channelId: string };
  'post.verified': { dealId: string; verificationDuration: number };
  'post.violation.detected': { dealId: string; violationType: 'deleted' | 'edited' | 'hidden'; detectedAt: Date };
  
  // Channel events
  'channel.created': { channelId: string; ownerId: string };
  'channel.verified': { channelId: string; ownerId: string };
  'channel.admin.status.lost': { channelId: string; ownerId: string };
  
  // Brief application events
  'brief.application.submitted': { applicationId: string; briefId: string; briefTitle: string; channelOwnerId: string; advertiserId: string };
  'brief.application.accepted': { applicationId: string; briefId: string; briefTitle: string; dealId: string; dealNumber: number; channelOwnerId: string; advertiserId: string };
  'brief.application.rejected': { applicationId: string; briefId: string; briefTitle: string; reason?: string; channelOwnerId: string; advertiserId: string };
  
  // Stats events
  'stats.updated': { channelId: string; subscriberCount: number; avgViews: number };
  
  // Timeout events
  'deal.timeout.warning': { dealId: string; hoursRemaining: number };
  'deal.timed.out': { dealId: string; currentStatus: string };
}

type EventMap = {
  [K in AppEvent]: EventPayload[K];
};

type TemplatedNotificationContent = {
  title: string;
  message: string;
  templateId: ChatTemplateId;
  primaryActionKey?: ChatActionKey;
  secondaryActionKey?: ChatActionKey;
  telegramText: string;
  telegramParseMode: 'HTML';
  telegramReplyMarkup?: unknown;
};

function buildTemplatedNotificationContent(
  templateId: ChatTemplateId,
  params: ChatTemplateParams,
  context: NotificationActionContext,
): TemplatedNotificationContent {
  const telegramPayload = buildTemplatedTelegramNotification(templateId, params, context);
  return {
    title: telegramPayload.template.title,
    message: telegramPayload.template.message,
    templateId: telegramPayload.template.templateId,
    primaryActionKey: telegramPayload.template.primaryActionKey,
    secondaryActionKey: telegramPayload.template.secondaryActionKey,
    telegramText: telegramPayload.text,
    telegramParseMode: telegramPayload.parseMode,
    telegramReplyMarkup: telegramPayload.replyMarkup,
  };
}

function formatWorkflowStatus(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatViolationType(violationType: EventPayload['post.violation.detected']['violationType']): string {
  switch (violationType) {
    case 'deleted':
      return 'Deleted';
    case 'edited':
      return 'Edited';
    case 'hidden':
      return 'Hidden';
    default:
      return violationType;
  }
}

function toNotificationMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

class AppEventEmitter extends EventEmitter<EventMap> {
  private notificationEnabled = true;

  constructor() {
    super();
    this.setupEventListeners();
  }

  /**
   * Setup event listeners for automatic notifications
   */
  private setupEventListeners() {
    // Deal notifications
    this.on(AppEvent.DEAL_CREATED, (data: EventPayload[AppEvent.DEAL_CREATED]) => this.notifyDealCreated(data));
    this.on(AppEvent.DEAL_STATUS_CHANGED, (data: EventPayload[AppEvent.DEAL_STATUS_CHANGED]) => this.notifyStatusChange(data));
    this.on(AppEvent.DEAL_ACCEPTED, (data: EventPayload[AppEvent.DEAL_ACCEPTED]) => this.notifyDealAccepted(data));
    this.on(AppEvent.DEAL_CANCELLED, (data: EventPayload[AppEvent.DEAL_CANCELLED]) => this.notifyDealCancelled(data));
    this.on(AppEvent.DEAL_COMPLETED, (data: EventPayload[AppEvent.DEAL_COMPLETED]) => this.notifyDealCompleted(data));

    // Brief application notifications
    this.on(
      AppEvent.BRIEF_APPLICATION_SUBMITTED,
      (data: EventPayload[AppEvent.BRIEF_APPLICATION_SUBMITTED]) => this.notifyBriefApplicationSubmitted(data),
    );
    this.on(
      AppEvent.BRIEF_APPLICATION_ACCEPTED,
      (data: EventPayload[AppEvent.BRIEF_APPLICATION_ACCEPTED]) => this.notifyBriefApplicationAccepted(data),
    );
    this.on(
      AppEvent.BRIEF_APPLICATION_REJECTED,
      (data: EventPayload[AppEvent.BRIEF_APPLICATION_REJECTED]) => this.notifyBriefApplicationRejected(data),
    );
    
    // Creative notifications
    this.on(AppEvent.CREATIVE_SUBMITTED, (data: EventPayload[AppEvent.CREATIVE_SUBMITTED]) => this.notifyCreativeSubmitted(data));
    this.on(AppEvent.CREATIVE_APPROVED, (data: EventPayload[AppEvent.CREATIVE_APPROVED]) => this.notifyCreativeApproved(data));
    this.on(AppEvent.CREATIVE_REVISION_REQUESTED, (data: EventPayload[AppEvent.CREATIVE_REVISION_REQUESTED]) => this.notifyRevisionRequested(data));
    
    // Payment notifications
    this.on(AppEvent.PAYMENT_RECEIVED, (data: EventPayload[AppEvent.PAYMENT_RECEIVED]) => this.notifyPaymentReceived(data));
    this.on(AppEvent.PAYMENT_RELEASED, (data: EventPayload[AppEvent.PAYMENT_RELEASED]) => this.notifyPaymentReleased(data));
    this.on(AppEvent.PAYMENT_REFUNDED, (data: EventPayload[AppEvent.PAYMENT_REFUNDED]) => this.notifyPaymentRefunded(data));
    
    // Posting notifications
    this.on(AppEvent.POST_PUBLISHED, (data: EventPayload[AppEvent.POST_PUBLISHED]) => this.notifyPostPublished(data));
    this.on(AppEvent.POST_VIOLATION_DETECTED, (data) => this.notifyViolationDetected(data));
    
    // Timeout notifications
    this.on(AppEvent.DEAL_TIMEOUT_WARNING, (data) => this.notifyTimeoutWarning(data));
    this.on(AppEvent.DEAL_TIMED_OUT, (data) => this.notifyTimedOut(data));
  }

  /**
   * Emit event and create notification records
   */
  async emitWithNotification<K extends keyof EventPayload>(
    event: K,
    payload: EventPayload[K],
  ): Promise<void> {
    this.emit(event as AppEvent, payload);
  }

  // Notification handlers
  private async notifyDealCreated(data: EventPayload['deal.created']) {
    const deal = await prisma.deal.findUnique({
      where: { id: data.dealId },
      include: { channel: true },
    });

    if (!deal) return;

    const channelOwnerContent = buildTemplatedNotificationContent(
      'B04',
      { channelTitle: deal.channel.title },
      { dealId: data.dealId },
    );
    const advertiserContent = buildTemplatedNotificationContent(
      'B05',
      { channelTitle: deal.channel.title },
      { dealId: data.dealId },
    );

    await this.sendNotifications([
      {
        userId: data.channelOwnerId,
        type: NotificationType.DEAL_CREATED,
        ...channelOwnerContent,
        metadata: { dealId: data.dealId },
      },
      {
        userId: data.advertiserId,
        type: NotificationType.DEAL_CREATED,
        ...advertiserContent,
        metadata: { dealId: data.dealId },
      },
    ]);

    // Additional bot-native action for lazy topic opening.
    // Keep template notifications unchanged; this is an extra CTA message.
    await this.sendOpenDealChatButtons(data.dealId, {
      channelOwnerId: data.channelOwnerId,
      advertiserId: data.advertiserId,
    });
  }

  private async sendOpenDealChatButtons(
    dealId: string,
    participants: {
      channelOwnerId: string;
      advertiserId: string;
    },
  ) {
    const recipientConfigs: Array<{
      userId: string;
      templateId: ChatTemplateId;
      roleLabel: string;
    }> = [];

    if (participants.channelOwnerId.trim().length > 0) {
      recipientConfigs.push({
        userId: participants.channelOwnerId,
        templateId: 'B04',
        roleLabel: 'channel owner',
      });
    }

    if (participants.advertiserId.trim().length > 0) {
      recipientConfigs.push({
        userId: participants.advertiserId,
        templateId: 'B05',
        roleLabel: 'advertiser',
      });
    }

    if (recipientConfigs.length === 0) {
      return;
    }

    const uniqueUserIds = [...new Set(recipientConfigs.map((config) => config.userId))];
    const users = await prisma.user.findMany({
      where: {
        id: { in: uniqueUserIds },
      },
      select: {
        id: true,
        telegramId: true,
        notifyAdvertiserMessages: true,
        notifyPublisherMessages: true,
        notifyPaymentMessages: true,
        notifySystemMessages: true,
      },
    });
    const userById = new Map(users.map((user) => [user.id, user]));

    const resolvedUserIds = new Set(userById.keys());
    const unresolvedUserIds = uniqueUserIds.filter((userId) => !resolvedUserIds.has(userId));
    if (unresolvedUserIds.length > 0) {
      console.warn(
        `Open deal chat button skipped for deal ${dealId}: unknown users ${unresolvedUserIds.join(', ')}`,
      );
    }

    const inlineKeyboard = {
      inline_keyboard: [[
        {
          text: 'Open deal chat',
          callback_data: `open_deal_chat:${dealId}`,
        },
      ]],
    };

    const deliveryTasks = recipientConfigs.map(async (recipientConfig) => {
      const user = userById.get(recipientConfig.userId);
      if (!user) {
        return;
      }

      const deliveryEnabled = isTemplateDeliveryEnabled(
        projectUserNotificationSettings(user),
        recipientConfig.templateId,
      );
      if (!deliveryEnabled) {
        return;
      }

      if (!user.telegramId) {
        console.warn(
          `Open deal chat button skipped for deal ${dealId}: ${recipientConfig.roleLabel} ${user.id} has no telegramId`,
        );
        return;
      }

      try {
        await telegramBot.sendNotification(
          user.telegramId,
          'Open your private deal chat to start messaging the counterparty.',
          {
            parseMode: 'HTML',
            replyMarkup: inlineKeyboard,
          },
        );
      } catch (error) {
        // Best effort: if one DM fails, deal chat bridge stays PENDING_OPEN
        // and user can still open via app deep link.
        console.error(`Failed to send Open deal chat button to user ${user.id}:`, error);
      }
    });

    await Promise.all(deliveryTasks);
  }

  private async notifyStatusChange(data: EventPayload['deal.status.changed']) {
    const deal = await prisma.deal.findUnique({
      where: { id: data.dealId },
      include: { channel: { include: { owner: true } }, advertiser: true },
    });

    if (!deal) return;

    const statusLabel = formatWorkflowStatus(data.newStatus);
    const includeDeleteWarning =
      data.newStatus === 'CANCELLED' && config.dealChat.deleteTopicsOnClose;
    const content = buildTemplatedNotificationContent(
      'B06',
      {
        statusLabel,
        ...(includeDeleteWarning ? { dealChatDeleted: true } : {}),
      },
      { dealId: data.dealId },
    );
    
    await this.sendNotifications([
      {
        userId: deal.channel.ownerId,
        type: NotificationType.SYSTEM_ALERT,
        ...content,
        metadata: { dealId: data.dealId, newStatus: data.newStatus },
      },
      {
        userId: deal.advertiserId,
        type: NotificationType.SYSTEM_ALERT,
        ...content,
        metadata: { dealId: data.dealId, newStatus: data.newStatus },
      },
    ]);
  }

  private async notifyDealAccepted(data: EventPayload['deal.accepted']) {
    const content = buildTemplatedNotificationContent('B07', {}, { dealId: data.dealId });

    await this.sendNotifications([
      {
        userId: data.advertiserId,
        type: NotificationType.DEAL_ACCEPTED,
        ...content,
        metadata: { dealId: data.dealId },
      },
    ]);
  }

  private async notifyDealCancelled(data: EventPayload['deal.cancelled']) {
    const deal = await prisma.deal.findUnique({
      where: { id: data.dealId },
      include: { channel: true },
    });

    if (!deal) return;

    const recipients = [deal.channel.ownerId, deal.advertiserId].filter(id => id !== data.cancelledBy);
    const content = buildTemplatedNotificationContent(
      'B08',
      {
        reason: data.reason,
        ...(config.dealChat.deleteTopicsOnClose ? { dealChatDeleted: true } : {}),
      },
      { dealId: data.dealId },
    );

    await this.sendNotifications(
      recipients.map(userId => ({
        userId,
        type: NotificationType.DEAL_CANCELLED,
        ...content,
        metadata: { dealId: data.dealId, reason: data.reason },
      })),
    );
  }

  private async notifyDealCompleted(data: EventPayload['deal.completed']) {
    const deal = await prisma.deal.findUnique({
      where: { id: data.dealId },
      include: { channel: true },
    });

    if (!deal) return;

    const channelOwnerContent = buildTemplatedNotificationContent('B09', {}, { dealId: data.dealId });
    const advertiserContent = buildTemplatedNotificationContent('B10', {}, { dealId: data.dealId });

    await this.sendNotifications([
      {
        userId: data.channelOwnerId,
        type: NotificationType.DEAL_COMPLETED,
        ...channelOwnerContent,
        metadata: { dealId: data.dealId },
      },
      {
        userId: data.advertiserId,
        type: NotificationType.DEAL_COMPLETED,
        ...advertiserContent,
        metadata: { dealId: data.dealId },
      },
    ]);
  }

  private async notifyCreativeSubmitted(data: EventPayload['creative.submitted']) {
    const content = buildTemplatedNotificationContent('B11', {}, { dealId: data.dealId });

    await this.sendNotifications([
      {
        userId: data.advertiserId,
        type: NotificationType.CREATIVE_SUBMITTED,
        ...content,
        metadata: { dealId: data.dealId, creativeId: data.creativeId },
      },
    ]);
  }

  private async notifyCreativeApproved(data: EventPayload['creative.approved']) {
    const deal = await prisma.deal.findUnique({
      where: { id: data.dealId },
      include: { channel: { include: { owner: true } } },
    });

    if (!deal) return;

    const content = buildTemplatedNotificationContent(
      'B12',
      { scheduledAt: data.scheduledTime },
      { dealId: data.dealId },
    );

    await this.sendNotifications([
      {
        userId: deal.channel.ownerId,
        type: NotificationType.CREATIVE_APPROVED,
        ...content,
        metadata: { dealId: data.dealId, creativeId: data.creativeId },
      },
    ]);
  }

  private async notifyRevisionRequested(data: EventPayload['creative.revision.requested']) {
    const deal = await prisma.deal.findUnique({
      where: { id: data.dealId },
      include: { channel: { include: { owner: true } } },
    });

    if (!deal) return;

    const content = buildTemplatedNotificationContent(
      'B13',
      { feedback: data.feedback },
      { dealId: data.dealId },
    );

    await this.sendNotifications([
      {
        userId: deal.channel.ownerId,
        type: NotificationType.CREATIVE_REVISION,
        ...content,
        metadata: { dealId: data.dealId, feedback: data.feedback },
      },
    ]);
  }

  private async notifyPaymentReceived(data: EventPayload['payment.received']) {
    const deal = await prisma.deal.findUnique({
      where: { id: data.dealId },
      include: { channel: { include: { owner: true } } },
    });

    if (!deal) return;

    const content = buildTemplatedNotificationContent(
      'B14',
      { amount: data.amount },
      { dealId: data.dealId },
    );

    await this.sendNotifications([
      {
        userId: deal.channel.ownerId,
        type: NotificationType.PAYMENT_RECEIVED,
        ...content,
        metadata: { dealId: data.dealId, amount: data.amount },
      },
    ]);
  }

  private async notifyPaymentReleased(data: EventPayload['payment.released']) {
    const content = buildTemplatedNotificationContent(
      'B15',
      { amount: data.amount },
      { dealId: data.dealId },
    );

    await this.sendNotifications([
      {
        userId: data.recipientId,
        type: NotificationType.PAYMENT_RELEASED,
        ...content,
        metadata: { dealId: data.dealId, amount: data.amount },
      },
    ]);
  }

  private async notifyPaymentRefunded(data: EventPayload['payment.refunded']) {
    const content = buildTemplatedNotificationContent(
      'B16',
      { amount: data.amount, reason: data.reason },
      { dealId: data.dealId },
    );

    await this.sendNotifications([
      {
        userId: data.recipientId,
        type: NotificationType.PAYMENT_REFUNDED,
        ...content,
        metadata: { dealId: data.dealId, amount: data.amount, reason: data.reason },
      },
    ]);
  }

  private async notifyPostPublished(data: EventPayload['post.published']) {
    const deal = await prisma.deal.findUnique({
      where: { id: data.dealId },
      include: { advertiser: true },
    });

    if (!deal) return;

    const content = buildTemplatedNotificationContent('B17', {}, { dealId: data.dealId });

    await this.sendNotifications([
      {
        userId: deal.advertiserId,
        type: NotificationType.POST_PUBLISHED,
        ...content,
        metadata: { dealId: data.dealId, messageId: data.messageId },
      },
    ]);
  }

  private async notifyViolationDetected(data: EventPayload['post.violation.detected']) {
    const deal = await prisma.deal.findUnique({
      where: { id: data.dealId },
      include: { channel: { include: { owner: true } }, advertiser: true },
    });

    if (!deal) return;

    const violationLabel = formatViolationType(data.violationType);
    const channelOwnerContent = buildTemplatedNotificationContent(
      'B18',
      { violationLabel },
      { dealId: data.dealId },
    );
    const advertiserContent = buildTemplatedNotificationContent(
      'B19',
      { violationLabel },
      { dealId: data.dealId },
    );

    await this.sendNotifications([
      {
        userId: deal.channel.ownerId,
        type: NotificationType.SYSTEM_ALERT,
        ...channelOwnerContent,
        metadata: { dealId: data.dealId, violationType: data.violationType },
      },
      {
        userId: deal.advertiserId,
        type: NotificationType.SYSTEM_ALERT,
        ...advertiserContent,
        metadata: { dealId: data.dealId, violationType: data.violationType },
      },
    ]);
  }

  private async notifyTimeoutWarning(data: EventPayload['deal.timeout.warning']) {
    const deal = await prisma.deal.findUnique({
      where: { id: data.dealId },
      include: { channel: { include: { owner: true } }, advertiser: true },
    });

    if (!deal) return;

    const content = buildTemplatedNotificationContent(
      'B20',
      { hoursRemaining: data.hoursRemaining },
      { dealId: data.dealId },
    );

    await this.sendNotifications([
      {
        userId: deal.channel.ownerId,
        type: NotificationType.SYSTEM_ALERT,
        ...content,
        metadata: { dealId: data.dealId, hoursRemaining: data.hoursRemaining },
      },
      {
        userId: deal.advertiserId,
        type: NotificationType.SYSTEM_ALERT,
        ...content,
        metadata: { dealId: data.dealId, hoursRemaining: data.hoursRemaining },
      },
    ]);
  }

  private async notifyTimedOut(data: EventPayload['deal.timed.out']) {
    const deal = await prisma.deal.findUnique({
      where: { id: data.dealId },
      include: { channel: { include: { owner: true } }, advertiser: true },
    });

    if (!deal) return;

    const channelOwnerContent = buildTemplatedNotificationContent('B21', {}, { dealId: data.dealId });
    const advertiserContent = buildTemplatedNotificationContent('B22', {}, { dealId: data.dealId });

    await this.sendNotifications([
      {
        userId: deal.channel.ownerId,
        type: NotificationType.DEAL_CANCELLED,
        ...channelOwnerContent,
        metadata: { dealId: data.dealId, reason: 'timeout' },
      },
      {
        userId: deal.advertiserId,
        type: NotificationType.DEAL_CANCELLED,
        ...advertiserContent,
        metadata: { dealId: data.dealId, reason: 'timeout' },
      },
    ]);
  }

  private async notifyBriefApplicationSubmitted(data: EventPayload['brief.application.submitted']) {
    const content = buildTemplatedNotificationContent(
      'B01',
      { briefTitle: data.briefTitle },
      { briefId: data.briefId },
    );

    await this.sendNotifications([
      {
        userId: data.advertiserId,
        type: NotificationType.BRIEF_APPLICATION,
        ...content,
        metadata: {
          applicationId: data.applicationId,
          briefId: data.briefId,
          briefTitle: data.briefTitle,
          channelOwnerId: data.channelOwnerId,
        },
      },
    ]);
  }

  private async notifyBriefApplicationAccepted(data: EventPayload['brief.application.accepted']) {
    const content = buildTemplatedNotificationContent(
      'B02',
      { briefTitle: data.briefTitle, dealNumber: data.dealNumber },
      { dealId: data.dealId, briefId: data.briefId },
    );

    await this.sendNotifications([
      {
        userId: data.channelOwnerId,
        type: NotificationType.APPLICATION_ACCEPTED,
        ...content,
        metadata: {
          applicationId: data.applicationId,
          briefId: data.briefId,
          briefTitle: data.briefTitle,
          dealId: data.dealId,
          dealNumber: data.dealNumber,
          advertiserId: data.advertiserId,
        },
      },
    ]);
  }

  private async notifyBriefApplicationRejected(data: EventPayload['brief.application.rejected']) {
    const content = buildTemplatedNotificationContent(
      'B03',
      { reason: data.reason, briefTitle: data.briefTitle },
      { briefId: data.briefId },
    );

    await this.sendNotifications([
      {
        userId: data.channelOwnerId,
        type: NotificationType.APPLICATION_REJECTED,
        ...content,
        metadata: {
          applicationId: data.applicationId,
          briefId: data.briefId,
          briefTitle: data.briefTitle,
          reason: data.reason,
          advertiserId: data.advertiserId,
        },
      },
    ]);
  }

  /**
   * Send notifications to users via multiple channels
   */
  private async sendNotifications(
    notifications: Array<{
      userId: string;
      type: NotificationType;
      title: string;
      message: string;
      metadata?: any;
      templateId?: ChatTemplateId;
      primaryActionKey?: ChatActionKey;
      secondaryActionKey?: ChatActionKey;
      telegramText?: string;
      telegramParseMode?: 'HTML' | 'Markdown';
      telegramReplyMarkup?: unknown;
    }>,
  ) {
    if (!this.notificationEnabled) return;

    const uniqueUserIds = [...new Set(notifications.map((notif) => notif.userId))];
    const users = uniqueUserIds.length > 0
      ? await prisma.user.findMany({
          where: {
            id: { in: uniqueUserIds },
          },
          select: {
            id: true,
            telegramId: true,
            notifyAdvertiserMessages: true,
            notifyPublisherMessages: true,
            notifyPaymentMessages: true,
            notifySystemMessages: true,
          },
        })
      : [];
    const userById = new Map(users.map((user) => [user.id, user]));

    for (const notif of notifications) {
      try {
        const recipient = userById.get(notif.userId);
        const deliveryEnabled = isTemplateDeliveryEnabled(
          recipient ? projectUserNotificationSettings(recipient) : undefined,
          notif.templateId,
        );
        const baseMetadata = toNotificationMetadata(notif.metadata);
        const deliverySuppressedByPreference = !deliveryEnabled;

        // Create notification record
        await prisma.notification.create({
          data: {
            userId: notif.userId,
            type: notif.type,
            channel: NotificationChannel.TELEGRAM,
            title: notif.title,
            body: notif.message,
            data: {
              ...baseMetadata,
              templateId: notif.templateId,
              primaryActionKey: notif.primaryActionKey,
              secondaryActionKey: notif.secondaryActionKey,
              ...(deliverySuppressedByPreference
                ? {
                    telegramDeliverySuppressed: true,
                    telegramDeliverySuppressedReason: 'user_preferences',
                  }
                : {}),
            },
          },
        });

        if (deliverySuppressedByPreference) {
          continue;
        }

        // Send via Telegram bot
        if (recipient?.telegramId) {
          try {
            await telegramBot.sendNotification(
              recipient.telegramId,
              notif.telegramText || `${notif.title}\n\n${notif.message}`,
              {
                parseMode: notif.telegramParseMode || 'HTML',
                replyMarkup: notif.telegramReplyMarkup,
              },
            );
          } catch (error) {
            console.error('Failed to send Telegram notification:', error);
          }
        }
      } catch (error) {
        console.error('Failed to send notification:', error);
      }
    }
  }

  /**
   * Disable automatic notifications (useful for testing)
   */
  disableNotifications() {
    this.notificationEnabled = false;
  }

  /**
   * Enable automatic notifications
   */
  enableNotifications() {
    this.notificationEnabled = true;
  }
}

// Singleton instance
export const appEvents = new AppEventEmitter();
