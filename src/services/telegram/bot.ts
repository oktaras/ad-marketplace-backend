import { Bot, Context, session, SessionFlavor } from 'grammy';
import { DealChatStatus } from '@prisma/client';
import { config } from '../../config/index.js';
import { prisma } from '../../lib/prisma.js';
import { buildTemplatedTelegramNotification } from '../notifications/telegram.js';
import { dealChatService } from '../deal-chat/index.js';

interface SessionData {
  dealId?: string;
  step?: string;
}

type BotContext = Context & SessionFlavor<SessionData>;

type ChatIdLike = string | number | bigint;
type DealChatParticipantSide = 'ADVERTISER' | 'PUBLISHER';
type DealTopicSide = 'advertiser' | 'publisher';
type DealTopicTarget = {
  side: DealTopicSide;
  chatId: bigint;
  threadId: bigint;
};
type TopicThreadParamKey = 'message_thread_id' | 'direct_messages_topic_id';
type TopicApiCapabilities = {
  createForumTopic: boolean;
  editForumTopic: boolean;
  deleteForumTopic: boolean;
};

let deleteTopicCapabilityWarningShown = false;
let topicApiCapabilities: TopicApiCapabilities | null = null;
const topicThreadParamPreference = new Map<string, TopicThreadParamKey>();
const TOPIC_THREAD_PARAM_KEYS: TopicThreadParamKey[] = ['message_thread_id', 'direct_messages_topic_id'];

const RESEND_AFTER_RESTORE_MESSAGE =
  'Message not delivered because counterparty topic was unavailable. We restored the chat. Please resend.';
const DIRECT_MESSAGE_TOPIC_ONLY_NOTICE =
  'Please use deal-related topics for chat. Direct messages are not relayed.';
const TOPIC_RECENT_GRACE_MS = 2 * 60 * 1000;
const MAX_TOPIC_ENSURE_ATTEMPTS = 2;
const MISSING_TOPIC_ERROR_TOKENS = [
  'message thread not found',
  'message_thread_not_found',
  'forum topic not found',
  'topic not found',
  'topic deleted',
  'topic_deleted',
  'thread not found',
  'message thread is not found',
  'message thread is invalid',
  'invalid message thread id',
  'invalid message_thread_id',
  'message thread id invalid',
  'topic_id_invalid',
  'direct_messages_topic_id_invalid',
  'direct messages topic not found',
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecentDateWithinMs(value: Date | null, windowMs: number): boolean {
  if (!value) {
    return false;
  }
  return Date.now() - value.getTime() <= windowMs;
}

function formatDealStatus(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatParticipantRoleLabel(side: DealChatParticipantSide): string {
  return side === 'ADVERTISER' ? 'Advertiser' : 'Publisher';
}

function withRolePrefix(roleLabel: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return `${roleLabel}:`;
  }
  return `${roleLabel}: ${normalized}`;
}

function extractRelayTextFromMessage(message: unknown, roleLabel: string): string | null {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const payload = message as Record<string, unknown>;
  const text = typeof payload.text === 'string' ? payload.text : null;
  if (text !== null) {
    return withRolePrefix(roleLabel, text);
  }

  return null;
}

function extractRelayCaptionFromMessage(message: unknown, roleLabel: string): string | null {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const payload = message as Record<string, unknown>;
  const caption = typeof payload.caption === 'string' ? payload.caption : null;
  if (caption === null) {
    return null;
  }

  return withRolePrefix(roleLabel, caption);
}

function parsePositiveBigInt(value: unknown, fieldName: string): bigint {
  try {
    const parsed = BigInt(value as string | number | bigint);
    if (parsed <= 0n) {
      throw new Error('non-positive');
    }
    return parsed;
  } catch {
    throw new Error(`Invalid ${fieldName}`);
  }
}

function toChatIdString(chatId: ChatIdLike): string {
  return typeof chatId === 'bigint' ? chatId.toString() : String(chatId);
}

function toMessageThreadIdNumber(threadId: bigint): number {
  const asNumber = Number(threadId);
  if (!Number.isSafeInteger(asNumber) || asNumber <= 0) {
    throw new Error('Invalid message_thread_id');
  }
  return asNumber;
}

function parseOptionalPositiveBigInt(value: unknown): bigint | null {
  try {
    return parsePositiveBigInt(value, 'topic_thread_id');
  } catch {
    return null;
  }
}

function extractIncomingThreadId(message: unknown): bigint | null {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const payload = message as Record<string, unknown>;
  const directTopic = payload.direct_messages_topic as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    payload.message_thread_id,
    payload.direct_messages_topic_id,
    directTopic?.topic_id,
    directTopic?.id,
  ];

  for (const candidate of candidates) {
    const parsed = parseOptionalPositiveBigInt(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function getTopicThreadParamOrder(chatId: bigint): TopicThreadParamKey[] {
  const key = chatId.toString();
  const preferred = topicThreadParamPreference.get(key);
  if (!preferred) {
    return TOPIC_THREAD_PARAM_KEYS;
  }

  return [preferred, ...TOPIC_THREAD_PARAM_KEYS.filter((candidate) => candidate !== preferred)];
}

function buildTopicThreadParam(
  paramKey: TopicThreadParamKey,
  threadId: bigint,
): Record<TopicThreadParamKey, number> {
  const payload = {} as Record<TopicThreadParamKey, number>;
  payload[paramKey] = toMessageThreadIdNumber(threadId);
  return payload;
}

async function callWithTopicThreadParamFallback<T>(params: {
  chatId: bigint;
  threadId: bigint;
  operation: (topicParam: Record<TopicThreadParamKey, number>) => Promise<T>;
}): Promise<T> {
  let lastError: unknown = null;

  for (const paramKey of getTopicThreadParamOrder(params.chatId)) {
    try {
      const result = await params.operation(buildTopicThreadParam(paramKey, params.threadId));
      topicThreadParamPreference.set(params.chatId.toString(), paramKey);
      return result;
    } catch (error) {
      lastError = error;
      if (isMissingTopicError(error)) {
        continue;
      }
      throw error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('Unable to send message to topic');
}

function parseForumTopicThreadId(payload: unknown): bigint {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid createForumTopic response');
  }

  const rawThreadId = (payload as Record<string, unknown>).message_thread_id;
  if (rawThreadId === undefined || rawThreadId === null) {
    throw new Error('createForumTopic response missing message_thread_id');
  }

  return parsePositiveBigInt(rawThreadId, 'message_thread_id');
}

function extractErrorText(error: unknown): string {
  if (!error || typeof error !== 'object') {
    return String(error ?? '');
  }

  const typed = error as {
    message?: unknown;
    description?: unknown;
    response?: { description?: unknown };
    error?: { description?: unknown };
  };

  const parts = [
    typed.message,
    typed.description,
    typed.response?.description,
    typed.error?.description,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (parts.length > 0) {
    return parts.join(' | ');
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function extractErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const typed = error as {
    error_code?: unknown;
    code?: unknown;
    response?: { error_code?: unknown };
    error?: { error_code?: unknown; code?: unknown };
  };

  const candidates = [
    typed.error_code,
    typed.code,
    typed.response?.error_code,
    typed.error?.error_code,
    typed.error?.code,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function isMissingTopicError(error: unknown): boolean {
  const normalized = extractErrorText(error).toLowerCase();
  const hasMissingToken = MISSING_TOPIC_ERROR_TOKENS.some((token) => normalized.includes(token));
  if (hasMissingToken) {
    return true;
  }

  const code = extractErrorCode(error);
  if (code !== 400) {
    return false;
  }

  return normalized.includes('message thread')
    || normalized.includes('forum topic')
    || normalized.includes('topic_id')
    || normalized.includes('direct_messages_topic');
}

async function isThreadReachable(chatId: bigint, threadId: bigint): Promise<boolean> {
  try {
    await callWithTopicThreadParamFallback({
      chatId,
      threadId,
      operation: (topicParam) => bot.api.sendChatAction(chatId.toString(), 'typing', topicParam as any),
    });
    return true;
  } catch (error) {
    if (isMissingTopicError(error)) {
      return false;
    }

    throw error;
  }
}

async function canDeliverToThread(chatId: bigint, threadId: bigint): Promise<boolean> {
  try {
    const probe = await callWithTopicThreadParamFallback({
      chatId,
      threadId,
      operation: (topicParam) => bot.api.sendMessage(
        chatId.toString(),
        '\u2063',
        {
          ...(topicParam as any),
          disable_notification: true,
        } as any,
      ),
    });
    const probePayload = probe as unknown as Record<string, unknown>;

    const deliveredThreadId = extractIncomingThreadId(probePayload);
    const deliveredToExpectedThread = deliveredThreadId !== null && deliveredThreadId === threadId;
    if (!deliveredToExpectedThread) {
      console.warn(
        `[deal-chat] probe mismatch chatId=${chatId.toString()} expectedThreadId=${threadId.toString()} actualThreadId=${deliveredThreadId?.toString() ?? 'null'}`,
      );
      topicThreadParamPreference.delete(chatId.toString());
    }

    const probeMessageId = typeof probePayload.message_id === 'number' && Number.isFinite(probePayload.message_id)
      ? probePayload.message_id
      : null;
    if (probeMessageId !== null) {
      try {
        await bot.api.deleteMessage(chatId.toString(), probeMessageId);
      } catch (cleanupError) {
        console.warn(
          `[deal-chat] probe cleanup failed chatId=${chatId.toString()} threadId=${threadId.toString()}`,
          cleanupError,
        );
      }
    }

    return deliveredToExpectedThread;
  } catch (error) {
    if (isMissingTopicError(error)) {
      return false;
    }

    throw error;
  }
}

function getRawBotApi(): Record<string, (params: Record<string, unknown>) => Promise<unknown>> {
  return bot.api.raw as unknown as Record<string, (params: Record<string, unknown>) => Promise<unknown>>;
}

function detectTopicApiCapabilities(): TopicApiCapabilities {
  const rawApi = getRawBotApi();
  return {
    createForumTopic: typeof rawApi.createForumTopic === 'function',
    editForumTopic: typeof rawApi.editForumTopic === 'function',
    deleteForumTopic: typeof rawApi.deleteForumTopic === 'function',
  };
}

function getTopicApiCapabilities(): TopicApiCapabilities {
  if (topicApiCapabilities === null) {
    topicApiCapabilities = detectTopicApiCapabilities();
  }

  return topicApiCapabilities;
}

function hasDeleteForumTopicMethod(): boolean {
  return getTopicApiCapabilities().deleteForumTopic;
}

async function sendDealTopicWelcomeMessage(params: {
  chatId: bigint;
  threadId: bigint;
  dealNumber: number;
}): Promise<void> {
  try {
    await sendTopicMessageWithRetry({
      chatId: params.chatId,
      threadId: params.threadId,
      text: `Deal #${params.dealNumber} chat opened.\nMessages here are relayed anonymously.`,
      context: `welcome:${params.dealNumber}`,
    });
  } catch (error) {
    console.warn(
      `[deal-chat] non-critical welcome message failed dealNumber=${params.dealNumber} chatId=${params.chatId.toString()} threadId=${params.threadId.toString()}`,
      error,
    );
  }
}

async function sendDealTopicRestoredMessage(params: {
  chatId: bigint;
  threadId: bigint;
  dealNumber: number;
}): Promise<void> {
  try {
    await sendTopicMessageWithRetry({
      chatId: params.chatId,
      threadId: params.threadId,
      text: 'Your deal chat was restored. Continue here.',
      context: `restored:${params.dealNumber}`,
    });
  } catch (error) {
    console.warn(
      `[deal-chat] non-critical restored message failed dealNumber=${params.dealNumber} chatId=${params.chatId.toString()} threadId=${params.threadId.toString()}`,
      error,
    );
  }
}

async function sendCounterpartyConnectedMessages(params: {
  dealId: string;
  openedBySide: 'ADVERTISER' | 'PUBLISHER';
  openerThreadId: bigint;
  counterpartyThreadId: bigint;
}): Promise<void> {
  const deal = await prisma.deal.findUnique({
    where: { id: params.dealId },
    select: {
      advertiser: {
        select: { telegramId: true },
      },
      channelOwner: {
        select: { telegramId: true },
      },
    },
  });

  const advertiserChatId = deal?.advertiser.telegramId ?? null;
  const publisherChatId = deal?.channelOwner.telegramId ?? null;

  if (!advertiserChatId || !publisherChatId) {
    return;
  }

  const advertiserThreadId = params.openedBySide === 'ADVERTISER'
    ? params.openerThreadId
    : params.counterpartyThreadId;
  const publisherThreadId = params.openedBySide === 'PUBLISHER'
    ? params.openerThreadId
    : params.counterpartyThreadId;

  const connectedMessage = 'Counterparty connected - you can chat here.';

  const connectedTargets = [
    {
      side: 'advertiser' as const,
      chatId: advertiserChatId,
      threadId: advertiserThreadId,
    },
    {
      side: 'publisher' as const,
      chatId: publisherChatId,
      threadId: publisherThreadId,
    },
  ];

  await Promise.all(connectedTargets.map(async (target) => {
    try {
      await callWithTopicThreadParamFallback({
        chatId: target.chatId,
        threadId: target.threadId,
        operation: (topicParam) => bot.api.sendMessage(
          target.chatId.toString(),
          connectedMessage,
          topicParam as any,
        ),
      });
    } catch (error) {
      console.warn(
        `[deal-chat] non-critical connected message failed dealId=${params.dealId} side=${target.side} chatId=${target.chatId.toString()} threadId=${target.threadId.toString()}`,
        error,
      );
    }
  }));
}

async function sendCounterpartyOpenDealChatPrompt(params: {
  dealId: string;
  openedBySide: 'ADVERTISER' | 'PUBLISHER';
}): Promise<void> {
  const counterpartySide = params.openedBySide === 'ADVERTISER' ? 'PUBLISHER' : 'ADVERTISER';
  const counterpartyChatId = await resolveCounterpartyChatId(params.dealId, counterpartySide);

  if (!counterpartyChatId) {
    console.warn(`Cannot send open chat prompt for deal ${params.dealId}: counterparty has no telegramId`);
    return;
  }

  await sendNotification(
    counterpartyChatId,
    'Your counterparty opened the deal chat. Tap below to open your side.',
    {
      parseMode: 'HTML',
      replyMarkup: {
        inline_keyboard: [[
          {
            text: 'Open deal chat',
            callback_data: `open_deal_chat:${params.dealId}`,
          },
        ]],
      },
    },
  );
}

async function notifySenderResendAfterTopicRecovery(params: {
  chatId: bigint;
  threadId: bigint;
}): Promise<void> {
  await sendTopicMessageWithRetry({
    chatId: params.chatId,
    threadId: params.threadId,
    text: RESEND_AFTER_RESTORE_MESSAGE,
    context: 'resend-after-recovery',
  });
}

async function sendCriticalTopicMessage(params: {
  chatId: bigint;
  threadId: bigint;
  text: string;
  context: string;
}): Promise<void> {
  try {
    await sendTopicMessageWithRetry(params);
  } catch (error) {
    console.error(
      `[deal-chat] critical topic message failed context=${params.context} chatId=${params.chatId.toString()} threadId=${params.threadId.toString()}`,
      error,
    );
  }
}

async function sendTopicMessageWithRetry(params: {
  chatId: bigint;
  threadId: bigint;
  text: string;
  context: string;
  maxAttempts?: number;
}): Promise<void> {
  const maxAttempts = Math.max(1, params.maxAttempts ?? 4);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await callWithTopicThreadParamFallback({
        chatId: params.chatId,
        threadId: params.threadId,
        operation: (topicParam) => bot.api.sendMessage(
          params.chatId.toString(),
          params.text,
          topicParam as any,
        ),
      });
      return;
    } catch (error) {
      lastError = error;
      const isMissingThread = isMissingTopicError(error);
      const canRetryMissing = isMissingThread && attempt < maxAttempts;
      if (canRetryMissing) {
        const delayMs = Math.min(1200, 150 * attempt);
        await sleep(delayMs);
        continue;
      }
      break;
    }
  }

  console.warn(
    `[deal-chat] failed to send topic message context=${params.context} chatId=${params.chatId.toString()} threadId=${params.threadId.toString()}`,
    lastError,
  );
  throw lastError instanceof Error ? lastError : new Error('Failed to send topic message');
}

async function sendTopicMessageBestEffort(params: {
  chatId: bigint;
  threadId: bigint;
  text: string;
  context: string;
  maxAttempts?: number;
}): Promise<boolean> {
  try {
    await sendTopicMessageWithRetry(params);
    return true;
  } catch (error) {
    console.warn(
      `[deal-chat] best-effort topic message failed context=${params.context} chatId=${params.chatId.toString()} threadId=${params.threadId.toString()}`,
      error,
    );
    return false;
  }
}

function buildStaleDuplicateTopicName(dealNumber: number): string {
  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
  return `Deal #${dealNumber} (Stale duplicate ${timestamp})`;
}

async function renameStaleDuplicateTopic(params: {
  dealId: string;
  side: DealChatParticipantSide;
  chatId: bigint;
  threadId: bigint;
  dealNumber: number;
}): Promise<void> {
  try {
    await renamePrivateDealTopic(
      params.chatId,
      params.threadId,
      buildStaleDuplicateTopicName(params.dealNumber),
    );
    console.warn(
      `[deal-chat] orphan-rename result=ok dealId=${params.dealId} side=${params.side} threadId=${params.threadId.toString()} action=rename-stale-duplicate`,
    );
  } catch (error) {
    console.warn(
      `[deal-chat] orphan-rename result=failed dealId=${params.dealId} side=${params.side} threadId=${params.threadId.toString()} action=rename-stale-duplicate`,
      error,
    );
  }
}

async function renamePrivateDealTopic(chatId: bigint, threadId: bigint, topicName: string): Promise<void> {
  const safeTopicName = topicName.trim();
  if (!safeTopicName) {
    return;
  }

  const rawApi = getRawBotApi();
  const capabilities = getTopicApiCapabilities();
  if (!capabilities.editForumTopic) {
    throw new Error('Bot API method editForumTopic is unavailable');
  }
  const editForumTopic = rawApi.editForumTopic;

  await editForumTopic.call(rawApi, {
    chat_id: chatId.toString(),
    ...buildTopicThreadParam('message_thread_id', threadId),
    name: safeTopicName,
  });
}

async function deletePrivateDealTopic(chatId: bigint, threadId: bigint): Promise<void> {
  const rawApi = getRawBotApi();
  const deleteForumTopic = rawApi.deleteForumTopic;
  if (typeof deleteForumTopic !== 'function') {
    throw new Error('Bot API method deleteForumTopic is unavailable');
  }

  await deleteForumTopic.call(rawApi, {
    chat_id: chatId.toString(),
    ...buildTopicThreadParam('message_thread_id', threadId),
  });
}

async function copyMessageToTopic(params: {
  destinationChatId: bigint;
  destinationThreadId: bigint;
  sourceChatId: bigint;
  sourceMessageId: number;
  caption?: string;
}): Promise<void> {
  await callWithTopicThreadParamFallback({
    chatId: params.destinationChatId,
    threadId: params.destinationThreadId,
    operation: (topicParam) => bot.api.copyMessage(
      params.destinationChatId.toString(),
      params.sourceChatId.toString(),
      params.sourceMessageId,
      {
        ...(topicParam as any),
        ...(params.caption !== undefined ? { caption: params.caption } : {}),
      },
    ),
  });
}

async function sendRelayTextMessage(params: {
  destinationChatId: bigint;
  destinationThreadId: bigint;
  text: string;
}): Promise<void> {
  await callWithTopicThreadParamFallback({
    chatId: params.destinationChatId,
    threadId: params.destinationThreadId,
    operation: (topicParam) => bot.api.sendMessage(
      params.destinationChatId.toString(),
      params.text,
      topicParam as any,
    ),
  });
}

async function relayIncomingMessageToTopic(params: {
  message: NonNullable<BotContext['message']>;
  fromSide: DealChatParticipantSide;
  sourceChatId: bigint;
  destinationChatId: bigint;
  destinationThreadId: bigint;
}): Promise<void> {
  const roleLabel = formatParticipantRoleLabel(params.fromSide);
  const relayText = extractRelayTextFromMessage(params.message, roleLabel);
  if (relayText !== null) {
    await sendRelayTextMessage({
      destinationChatId: params.destinationChatId,
      destinationThreadId: params.destinationThreadId,
      text: relayText,
    });
    return;
  }

  const relayCaption = extractRelayCaptionFromMessage(params.message, roleLabel);
  await copyMessageToTopic({
    destinationChatId: params.destinationChatId,
    destinationThreadId: params.destinationThreadId,
    sourceChatId: params.sourceChatId,
    sourceMessageId: params.message.message_id,
    ...(relayCaption !== null ? { caption: relayCaption } : {}),
  });
}

type RelayRecoveryDestination = {
  chatId: bigint;
  threadId: bigint;
  recreated: boolean;
};

export function buildRecoveryEnsureParticipantTopicParams(
  dealId: string,
  toSide: DealChatParticipantSide,
): {
  dealId: string;
  side: DealChatParticipantSide;
  recreateOnUnreachable: true;
  bypassRecentGraceWindow: true;
} {
  return {
    dealId,
    side: toSide,
    recreateOnUnreachable: true,
    bypassRecentGraceWindow: true,
  };
}

export async function recoverRelayAndRetryOnce(params: {
  dealId: string;
  fromThreadId: bigint;
  toSide: DealChatParticipantSide;
  ensureDestinationTopic: () => Promise<RelayRecoveryDestination>;
  retryRelayToDestination: (destination: RelayRecoveryDestination) => Promise<void>;
  notifySenderResend: () => Promise<void>;
}): Promise<'retry_succeeded' | 'resend_notified' | 'recovery_failed'> {
  console.info(
    `[deal-chat] recovery attempt dealId=${params.dealId} fromThreadId=${params.fromThreadId.toString()} toSide=${params.toSide}`,
  );

  try {
    const recoveredDestination = await params.ensureDestinationTopic();
    console.info(
      `[deal-chat] recovery result=ok dealId=${params.dealId} recoveredThreadId=${recoveredDestination.threadId.toString()} recreated=${recoveredDestination.recreated ? 'true' : 'false'}`,
    );

    try {
      console.info(
        `[deal-chat] auto-retry attempt dealId=${params.dealId} destinationThreadId=${recoveredDestination.threadId.toString()}`,
      );
      await params.retryRelayToDestination(recoveredDestination);
      console.info(
        `[deal-chat] auto-retry result=ok dealId=${params.dealId} destinationThreadId=${recoveredDestination.threadId.toString()}`,
      );
      return 'retry_succeeded';
    } catch (retryError) {
      console.error(
        `[deal-chat] auto-retry result=failed dealId=${params.dealId} destinationThreadId=${recoveredDestination.threadId.toString()}`,
        retryError,
      );
      console.error(`Failed to relay after destination recovery for deal ${params.dealId}:`, retryError);

      try {
        await params.notifySenderResend();
      } catch (notifyError) {
        console.error(
          `[deal-chat] failed to send resend-after-recovery notice dealId=${params.dealId} fromThreadId=${params.fromThreadId.toString()}`,
          notifyError,
        );
      }
      return 'resend_notified';
    }
  } catch (recoveryError) {
    console.error(
      `[deal-chat] recovery result=failed dealId=${params.dealId} fromThreadId=${params.fromThreadId.toString()} toSide=${params.toSide}`,
      recoveryError,
    );
    console.error(`Failed to recover destination topic after relay error for deal ${params.dealId}:`, recoveryError);
    return 'recovery_failed';
  }
}

function buildDealTopicTargets(deal: {
  advertiser: { telegramId: bigint | null };
  channelOwner: { telegramId: bigint | null };
  dealChatBridge: {
    advertiserThreadId: bigint | null;
    publisherThreadId: bigint | null;
  } | null;
}): DealTopicTarget[] {
  const targets: DealTopicTarget[] = [];
  if (!deal.dealChatBridge) {
    return targets;
  }

  if (deal.advertiser.telegramId && deal.dealChatBridge.advertiserThreadId) {
    targets.push({
      side: 'advertiser',
      chatId: deal.advertiser.telegramId,
      threadId: deal.dealChatBridge.advertiserThreadId,
    });
  }

  if (deal.channelOwner.telegramId && deal.dealChatBridge.publisherThreadId) {
    targets.push({
      side: 'publisher',
      chatId: deal.channelOwner.telegramId,
      threadId: deal.dealChatBridge.publisherThreadId,
    });
  }

  return targets;
}

async function finalizeDealTopicsByRename(params: {
  dealId: string;
  dealNumber: number;
  targets: DealTopicTarget[];
}): Promise<void> {
  const closedTopicName = `Deal #${params.dealNumber} (Closed)`;

  for (const target of params.targets) {
    try {
      await renamePrivateDealTopic(target.chatId, target.threadId, closedTopicName);
      console.info(
        `[deal-chat] topic finalize dealId=${params.dealId} side=${target.side} action=rename result=ok`,
      );
    } catch (error) {
      console.warn(
        `[deal-chat] topic finalize dealId=${params.dealId} side=${target.side} action=rename result=failed`,
        error,
      );
    }
  }
}

export async function finalizeDealTopicsOnClose(dealId: string): Promise<void> {
  const normalizedDealId = dealId.trim();
  if (!normalizedDealId) {
    return;
  }

  const deal = await prisma.deal.findUnique({
    where: { id: normalizedDealId },
    select: {
      id: true,
      dealNumber: true,
      advertiser: {
        select: { telegramId: true },
      },
      channelOwner: {
        select: { telegramId: true },
      },
      dealChatBridge: {
        select: {
          id: true,
          advertiserThreadId: true,
          publisherThreadId: true,
        },
      },
    },
  });

  if (!deal || !deal.dealChatBridge) {
    return;
  }

  const targets = buildDealTopicTargets(deal);
  if (targets.length === 0) {
    return;
  }

  const canDeleteTopics = config.dealChat.deleteTopicsOnClose && hasDeleteForumTopicMethod();
  if (!canDeleteTopics) {
    if (config.dealChat.deleteTopicsOnClose && !deleteTopicCapabilityWarningShown) {
      deleteTopicCapabilityWarningShown = true;
      console.warn(
        '[deal-chat] deleteForumTopic is unavailable. Falling back to topic rename on close.',
      );
    }

    await finalizeDealTopicsByRename({
      dealId: deal.id,
      dealNumber: deal.dealNumber,
      targets,
    });
    return;
  }

  const updateData: {
    advertiserThreadId?: null;
    publisherThreadId?: null;
  } = {};

  for (const target of targets) {
    try {
      await deletePrivateDealTopic(target.chatId, target.threadId);
      if (target.side === 'advertiser') {
        updateData.advertiserThreadId = null;
      } else {
        updateData.publisherThreadId = null;
      }
      console.info(
        `[deal-chat] topic finalize dealId=${deal.id} side=${target.side} action=delete result=ok`,
      );
    } catch (error) {
      if (isMissingTopicError(error)) {
        if (target.side === 'advertiser') {
          updateData.advertiserThreadId = null;
        } else {
          updateData.publisherThreadId = null;
        }
        console.info(
          `[deal-chat] topic finalize dealId=${deal.id} side=${target.side} action=delete result=missing`,
        );
        continue;
      }

      console.warn(
        `[deal-chat] topic finalize dealId=${deal.id} side=${target.side} action=delete result=failed`,
        error,
      );
    }
  }

  if (Object.keys(updateData).length > 0) {
    await prisma.dealChatBridge.update({
      where: { id: deal.dealChatBridge.id },
      data: updateData,
    });
  }
}

function isBotCommandMessage(ctx: BotContext): boolean {
  const message = ctx.message;
  if (!message) {
    return false;
  }

  const text = 'text' in message && typeof message.text === 'string' ? message.text : null;
  const caption = 'caption' in message && typeof message.caption === 'string' ? message.caption : null;
  const entities = 'entities' in message && Array.isArray(message.entities) ? message.entities : [];
  const captionEntities = 'caption_entities' in message && Array.isArray(message.caption_entities)
    ? message.caption_entities
    : [];

  const hasLeadingCommandEntity = [...entities, ...captionEntities].some((entity) => (
    entity.type === 'bot_command' && entity.offset === 0
  ));

  if (hasLeadingCommandEntity) {
    return true;
  }

  const commandCandidate = (text ?? caption ?? '').trim();
  return commandCandidate.startsWith('/');
}

function isContactSharingMessage(ctx: BotContext): boolean {
  const message = ctx.message;
  if (!message) {
    return false;
  }
  return (
    'contact' in message
    || 'users_shared' in message
    || 'chat_shared' in message
  );
}

async function resolveCounterpartyChatId(
  dealId: string,
  toSide: 'ADVERTISER' | 'PUBLISHER',
): Promise<bigint | null> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: {
      advertiser: {
        select: { telegramId: true },
      },
      channelOwner: {
        select: { telegramId: true },
      },
    },
  });

  if (!deal) {
    return null;
  }

  return toSide === 'ADVERTISER'
    ? deal.advertiser.telegramId
    : deal.channelOwner.telegramId;
}

function extractDealIdFromOpenCallback(data: string): string | null {
  if (data.startsWith('open_deal_chat:')) {
    const dealId = data.slice('open_deal_chat:'.length).trim();
    return dealId || null;
  }

  if (data.startsWith('open_deal_chat_')) {
    const dealId = data.slice('open_deal_chat_'.length).trim();
    return dealId || null;
  }

  return null;
}

function extractDealIdFromOpenStartParam(startParam: string | undefined): string | null {
  if (!startParam || !startParam.startsWith('open_deal_')) {
    return null;
  }

  const dealId = startParam.slice('open_deal_'.length).trim();
  return dealId || null;
}

function parseDealIdFromCommandArg(arg: string | undefined): string | null {
  if (!arg) {
    return null;
  }

  const trimmed = arg.trim();
  if (!trimmed) {
    return null;
  }

  const [dealId] = trimmed.split(/\s+/);
  return dealId || null;
}

function buildOpenDealChatStatusText(result: Awaited<ReturnType<typeof openDealChatInPrivateTopic>>): string {
  if (result.topicCreated) {
    return 'Deal chat opened. Continue in the new topic.';
  }

  if (result.status === DealChatStatus.ACTIVE) {
    return 'Deal chat is active.';
  }

  if (result.status === DealChatStatus.CLOSED) {
    return 'Deal chat is closed.';
  }

  return 'Deal chat is ready. Waiting for counterparty to open their side.';
}

function buildDealChatDiagnosticsText(params: {
  dealId: string;
  status: DealChatStatus;
  participantSide: DealChatParticipantSide;
  threadId: bigint | null;
  counterpartyThreadId: bigint | null;
  needsThreadCreation: boolean;
  myTopicDeliverability: 'ok' | 'missing' | 'error' | 'not_set';
  myTopicDeliverabilityDetail: string | null;
}): string {
  const lines = [
    'Deal chat diagnostics:',
    `Deal ID: ${params.dealId}`,
    `Side: ${params.participantSide}`,
    `Status: ${params.status}`,
    `My topic thread: ${params.threadId?.toString() ?? 'null'}`,
    `My topic deliverability: ${params.myTopicDeliverability}`,
    `Counterparty thread: ${params.counterpartyThreadId?.toString() ?? 'null'}`,
    `Needs topic creation: ${params.needsThreadCreation ? 'yes' : 'no'}`,
  ];

  if (params.myTopicDeliverabilityDetail) {
    lines.push(`My topic check detail: ${params.myTopicDeliverabilityDetail}`);
  }

  if (params.myTopicDeliverability === 'missing' && !params.needsThreadCreation) {
    lines.push('Diagnosis: DB still points to a missing topic. Use /repairchat <deal_id>.');
  }

  return lines.join('\n');
}

async function handleOpenDealChatEntry(params: {
  dealId: string;
  telegramUserId: ChatIdLike;
}) {
  const result = await openDealChatInPrivateTopic({
    dealId: params.dealId,
    telegramUserId: params.telegramUserId,
  });

  return {
    result,
    statusText: buildOpenDealChatStatusText(result),
  };
}

export async function createPrivateDealTopic(chatId: ChatIdLike, topicName: string): Promise<bigint> {
  const safeTopicName = topicName.trim();
  if (!safeTopicName) {
    throw new Error('Topic name is required');
  }

  const rawApi = getRawBotApi();
  const capabilities = getTopicApiCapabilities();
  if (!capabilities.createForumTopic) {
    throw new Error('Bot API method createForumTopic is unavailable');
  }
  const createForumTopic = rawApi.createForumTopic;

  const response = await createForumTopic.call(rawApi, {
    chat_id: toChatIdString(chatId),
    name: safeTopicName,
  });

  return parseForumTopicThreadId(response);
}

async function ensureParticipantTopic(params: {
  dealId: string;
  side: DealChatParticipantSide;
  recreateOnUnreachable?: boolean;
  bypassRecentGraceWindow?: boolean;
}): Promise<{
  chatId: bigint;
  threadId: bigint;
  recreated: boolean;
  reachable: boolean;
  status: DealChatStatus;
  counterpartyThreadId: bigint | null;
}> {
  const normalizedDealId = params.dealId.trim();
  if (!normalizedDealId) {
    throw new Error('Deal ID is required');
  }

  const shouldRecreateOnUnreachable = params.recreateOnUnreachable ?? true;
  const bypassRecentGraceWindow = params.bypassRecentGraceWindow ?? false;

  for (let attempt = 1; attempt <= MAX_TOPIC_ENSURE_ATTEMPTS; attempt += 1) {
    const deal = await prisma.deal.findUnique({
      where: { id: normalizedDealId },
      select: {
        dealNumber: true,
        advertiser: {
          select: { telegramId: true },
        },
        channelOwner: {
          select: { telegramId: true },
        },
        dealChatBridge: {
          select: {
            status: true,
            advertiserThreadId: true,
            publisherThreadId: true,
            advertiserOpenedAt: true,
            publisherOpenedAt: true,
          },
        },
      },
    });

    if (!deal) {
      throw new Error('Deal not found');
    }

    const isAdvertiserSide = params.side === 'ADVERTISER';
    const chatId = isAdvertiserSide
      ? deal.advertiser.telegramId
      : deal.channelOwner.telegramId;
    const existingThreadId = isAdvertiserSide
      ? deal.dealChatBridge?.advertiserThreadId ?? null
      : deal.dealChatBridge?.publisherThreadId ?? null;
    const existingOpenedAt = isAdvertiserSide
      ? deal.dealChatBridge?.advertiserOpenedAt ?? null
      : deal.dealChatBridge?.publisherOpenedAt ?? null;
    const counterpartyThreadId = isAdvertiserSide
      ? deal.dealChatBridge?.publisherThreadId ?? null
      : deal.dealChatBridge?.advertiserThreadId ?? null;
    const status = deal.dealChatBridge?.status ?? DealChatStatus.PENDING_OPEN;

    if (!chatId) {
      throw new Error(`Missing Telegram ID for deal participant side: ${params.side}`);
    }

    if (existingThreadId !== null) {
      // For creation/recovery paths, verify real deliverability (send + cleanup probe),
      // because chat-action checks can report false positives for deleted topics.
      const reachable = shouldRecreateOnUnreachable
        ? await canDeliverToThread(chatId, existingThreadId)
        : await isThreadReachable(chatId, existingThreadId);
      const withinRecentGraceWindow = !bypassRecentGraceWindow
        && isRecentDateWithinMs(existingOpenedAt, TOPIC_RECENT_GRACE_MS);
      if (!reachable && shouldRecreateOnUnreachable && withinRecentGraceWindow) {
        return {
          chatId,
          threadId: existingThreadId,
          recreated: false,
          reachable: false,
          status,
          counterpartyThreadId,
        };
      }
      if (reachable || !shouldRecreateOnUnreachable) {
        return {
          chatId,
          threadId: existingThreadId,
          recreated: false,
          reachable,
          status,
          counterpartyThreadId,
        };
      }
    }

    console.info(
      `[deal-chat] topic-create attempt dealId=${normalizedDealId} side=${params.side} attempt=${attempt} expectedThreadId=${existingThreadId?.toString() ?? 'null'}`,
    );
    let createdThreadId: bigint;
    try {
      createdThreadId = await createPrivateDealTopic(
        chatId,
        `Deal #${deal.dealNumber}`,
      );
    } catch (error) {
      console.error(
        `[deal-chat] topic-create result=failed dealId=${normalizedDealId} side=${params.side} attempt=${attempt}`,
        error,
      );
      throw error;
    }
    console.info(
      `[deal-chat] topic-create result=ok dealId=${normalizedDealId} side=${params.side} threadId=${createdThreadId.toString()} attempt=${attempt}`,
    );

    const bindResult = await dealChatService.bindThreadForParticipantWithExpectation({
      dealId: normalizedDealId,
      side: params.side,
      candidateThreadId: createdThreadId,
      expectedThreadId: existingThreadId,
    });
    console.info(
      `[deal-chat] cas-bind result=${bindResult.applied ? 'applied' : 'missed'} dealId=${normalizedDealId} side=${params.side} candidateThreadId=${createdThreadId.toString()} expectedThreadId=${existingThreadId?.toString() ?? 'null'} currentThreadId=${bindResult.threadId?.toString() ?? 'null'}`,
    );

    if (bindResult.applied) {
      if (existingThreadId !== null) {
        await sendDealTopicRestoredMessage({
          chatId,
          threadId: createdThreadId,
          dealNumber: deal.dealNumber,
        });
      } else {
        await sendDealTopicWelcomeMessage({
          chatId,
          threadId: createdThreadId,
          dealNumber: deal.dealNumber,
        });
      }

      return {
        chatId,
        threadId: createdThreadId,
        recreated: true,
        reachable: true,
        status: bindResult.status,
        counterpartyThreadId: bindResult.counterpartyThreadId,
      };
    }

    await renameStaleDuplicateTopic({
      dealId: normalizedDealId,
      side: params.side,
      chatId,
      threadId: createdThreadId,
      dealNumber: deal.dealNumber,
    });

    // On CAS miss, force a re-read pass to pick the canonical state after the winner writes.
    if (attempt < MAX_TOPIC_ENSURE_ATTEMPTS) {
      continue;
    }

    if (bindResult.threadId !== null) {
      const reachable = shouldRecreateOnUnreachable
        ? await canDeliverToThread(chatId, bindResult.threadId)
        : await isThreadReachable(chatId, bindResult.threadId);
      if (reachable || !shouldRecreateOnUnreachable) {
        return {
          chatId,
          threadId: bindResult.threadId,
          recreated: false,
          reachable,
          status: bindResult.status,
          counterpartyThreadId: bindResult.counterpartyThreadId,
        };
      }
    } else {
      throw new Error(`Unable to ensure participant topic for deal ${normalizedDealId}`);
    }
  }

  throw new Error(`Unable to ensure participant topic for deal ${normalizedDealId}`);
}

export async function openDealChatInPrivateTopic(params: {
  dealId: string;
  telegramUserId: ChatIdLike;
  forceRecovery?: boolean;
}) {
  const telegramUserId = parsePositiveBigInt(params.telegramUserId, 'telegramUserId');
  const initial = await dealChatService.openDealChatForUser({
    dealId: params.dealId,
    telegramUserId,
  });
  const participantSide = initial.participantSide as DealChatParticipantSide;

  console.info(
    `[deal-chat] open-flow state dealId=${params.dealId} user=${telegramUserId.toString()} side=${participantSide} status=${initial.status} threadId=${initial.threadId?.toString() ?? 'null'} counterpartyThreadId=${initial.counterpartyThreadId?.toString() ?? 'null'} forceRecovery=${params.forceRecovery ? 'true' : 'false'}`,
  );

  let finalState = initial;
  let topicCreated = false;

  if (initial.status !== DealChatStatus.CLOSED) {
    let ensured: Awaited<ReturnType<typeof ensureParticipantTopic>>;
    if (params.forceRecovery) {
      console.warn(
        `[deal-chat] open-flow manual forced recovery dealId=${params.dealId} side=${participantSide}`,
      );
      ensured = await ensureParticipantTopic(
        buildRecoveryEnsureParticipantTopicParams(params.dealId, participantSide),
      );
    } else {
      ensured = await ensureParticipantTopic({
        dealId: params.dealId,
        side: participantSide,
      });

      // If open-chat sees a known unreachable thread (typically deleted topic) that is still inside
      // the grace window, force one recovery pass so users don't get "chat is active" with no topic.
      if (!ensured.reachable && ensured.threadId !== null) {
        console.warn(
          `[deal-chat] open-flow forcing topic recovery dealId=${params.dealId} side=${initial.participantSide} staleThreadId=${ensured.threadId.toString()}`,
        );
        ensured = await ensureParticipantTopic(
          buildRecoveryEnsureParticipantTopicParams(params.dealId, participantSide),
        );
      }

      if (ensured.threadId !== null && !ensured.recreated) {
        try {
          const deliverable = await canDeliverToThread(ensured.chatId, ensured.threadId);
          if (!deliverable) {
            console.warn(
              `[deal-chat] open-flow probe forcing topic recovery dealId=${params.dealId} side=${initial.participantSide} staleThreadId=${ensured.threadId.toString()}`,
            );
            ensured = await ensureParticipantTopic(
              buildRecoveryEnsureParticipantTopicParams(params.dealId, participantSide),
            );
          }
        } catch (probeError) {
          console.error(
            `[deal-chat] open-flow topic probe failed dealId=${params.dealId} side=${initial.participantSide}`,
            probeError,
          );
        }
      }
    }

    topicCreated = ensured.recreated;

    finalState = await dealChatService.openDealChatForUser({
      dealId: params.dealId,
      telegramUserId,
    });
  }

  const becameActive = initial.status !== DealChatStatus.ACTIVE
    && finalState.status === DealChatStatus.ACTIVE
    && finalState.threadId !== null
    && finalState.counterpartyThreadId !== null;

  if (becameActive && finalState.threadId !== null && finalState.counterpartyThreadId !== null) {
    await sendCounterpartyConnectedMessages({
      dealId: params.dealId,
      openedBySide: finalState.participantSide,
      openerThreadId: finalState.threadId,
      counterpartyThreadId: finalState.counterpartyThreadId,
    });
  }

  const shouldPromptCounterparty = finalState.status === DealChatStatus.PENDING_OPEN
    && finalState.counterpartyThreadId === null
    && topicCreated;

  if (shouldPromptCounterparty) {
    try {
      await sendCounterpartyOpenDealChatPrompt({
        dealId: params.dealId,
        openedBySide: finalState.participantSide,
      });
    } catch (error) {
      console.error(`Failed to prompt counterparty to open deal chat for deal ${params.dealId}:`, error);
    }
  }

  return {
    ...finalState,
    topicCreated,
  };
}

// Initialize bot
const bot = new Bot<BotContext>(config.telegramBotToken || 'placeholder');

// Session middleware
bot.use(session({
  initial: (): SessionData => ({}),
}));

// Start command
bot.command('start', async (ctx) => {
  const startParam = ctx.match;

  const openDealId = extractDealIdFromOpenStartParam(startParam);
  if (openDealId) {
    console.log(`Received open deal /start for deal ${openDealId} from user ${ctx.from?.id ?? 'unknown'}`);
    try {
      if (!ctx.from?.id) {
        throw new Error('Telegram user is not available');
      }

      const opened = await handleOpenDealChatEntry({
        dealId: openDealId,
        telegramUserId: ctx.from.id,
      });

      await ctx.reply(opened.statusText);
    } catch (error) {
      console.error(`Failed to open deal chat from /start for deal ${openDealId}:`, error);
      await ctx.reply('Failed to open deal chat.');
    }
    return;
  }
  
  if (startParam?.startsWith('deal_')) {
    // Deep link to deal
    const dealId = startParam.replace('deal_', '');
    ctx.session.dealId = dealId;

    const notification = buildTemplatedTelegramNotification('B24', {}, { dealId });
    await ctx.reply(notification.text, {
      parse_mode: notification.parseMode,
      reply_markup: notification.replyMarkup as any,
    });
  } else if (startParam?.startsWith('channel_')) {
    // Deep link to add bot to channel
    const channelId = startParam.replace('channel_', '');

    const notification = buildTemplatedTelegramNotification('B25', {}, { channelId });
    await ctx.reply(notification.text, {
      parse_mode: notification.parseMode,
      reply_markup: notification.replyMarkup as any,
    });
  } else {
    const notification = buildTemplatedTelegramNotification('B23', {}, {});
    await ctx.reply(notification.text, {
      parse_mode: notification.parseMode,
      reply_markup: notification.replyMarkup as any,
    });
  }
});

bot.command('openchat', async (ctx) => {
  const dealId = parseDealIdFromCommandArg(ctx.match);
  if (!dealId) {
    await ctx.reply('Usage: /openchat <deal_id>');
    return;
  }

  try {
    if (!ctx.from?.id) {
      throw new Error('Telegram user is not available');
    }

    console.info(`[deal-chat] manual /openchat dealId=${dealId} user=${ctx.from.id}`);
    const opened = await handleOpenDealChatEntry({
      dealId,
      telegramUserId: ctx.from.id,
    });
    await ctx.reply(opened.statusText);
  } catch (error) {
    console.error(`Failed to open deal chat from /openchat for deal ${dealId}:`, error);
    await ctx.reply('Failed to open deal chat.');
  }
});

bot.command('repairchat', async (ctx) => {
  const dealId = parseDealIdFromCommandArg(ctx.match);
  if (!dealId) {
    await ctx.reply('Usage: /repairchat <deal_id>');
    return;
  }

  try {
    if (!ctx.from?.id) {
      throw new Error('Telegram user is not available');
    }

    console.info(`[deal-chat] manual /repairchat dealId=${dealId} user=${ctx.from.id}`);
    const repaired = await openDealChatInPrivateTopic({
      dealId,
      telegramUserId: ctx.from.id,
      forceRecovery: true,
    });
    const repairText = repaired.topicCreated
      ? 'Recovery action: topic recreated.'
      : 'Recovery action: no recreate needed.';
    await ctx.reply(`${buildOpenDealChatStatusText(repaired)}\n${repairText}`);
  } catch (error) {
    console.error(`Failed to repair deal chat from /repairchat for deal ${dealId}:`, error);
    await ctx.reply('Failed to repair deal chat.');
  }
});

bot.command('chatdiag', async (ctx) => {
  if (!ctx.chat || ctx.chat.type !== 'private') {
    await ctx.reply('Use /chatdiag in a private chat with the bot.');
    return;
  }

  const dealId = parseDealIdFromCommandArg(ctx.match);
  if (!dealId) {
    await ctx.reply('Usage: /chatdiag <deal_id>');
    return;
  }

  try {
    if (!ctx.from?.id) {
      throw new Error('Telegram user is not available');
    }

    const state = await dealChatService.openDealChatForUser({
      dealId,
      telegramUserId: ctx.from.id,
    });
    const myChatId = parsePositiveBigInt(ctx.chat.id, 'chatId');
    let myTopicDeliverability: 'ok' | 'missing' | 'error' | 'not_set' = 'not_set';
    let myTopicDeliverabilityDetail: string | null = null;

    if (state.threadId !== null) {
      try {
        const deliverable = await canDeliverToThread(myChatId, state.threadId);
        myTopicDeliverability = deliverable ? 'ok' : 'missing';
      } catch (probeError) {
        myTopicDeliverability = 'error';
        myTopicDeliverabilityDetail = extractErrorText(probeError);
      }
    }

    await ctx.reply(buildDealChatDiagnosticsText({
      dealId,
      status: state.status,
      participantSide: state.participantSide as DealChatParticipantSide,
      threadId: state.threadId,
      counterpartyThreadId: state.counterpartyThreadId,
      needsThreadCreation: state.needsThreadCreation,
      myTopicDeliverability,
      myTopicDeliverabilityDetail,
    }));
  } catch (error) {
    console.error(`Failed to load deal chat diagnostics from /chatdiag for deal ${dealId}:`, error);
    await ctx.reply('Failed to load deal chat diagnostics.');
  }
});

// Check deal status
bot.command('status', async (ctx) => {
  const dealId = ctx.session.dealId;
  
  if (!dealId) {
    const notification = buildTemplatedTelegramNotification('B26', {}, {});
    await ctx.reply(notification.text, {
      parse_mode: notification.parseMode,
      reply_markup: notification.replyMarkup as any,
    });
    return;
  }

  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: {
      channel: true,
      adFormat: true,
    },
  });

  if (!deal) {
    const notification = buildTemplatedTelegramNotification('B27', {}, {});
    await ctx.reply(notification.text, {
      parse_mode: notification.parseMode,
      reply_markup: notification.replyMarkup as any,
    });
    return;
  }

  const statusEmoji: Record<string, string> = {
    CREATED: '🆕',
    NEGOTIATING: '💬',
    TERMS_AGREED: '🤝',
    AWAITING_PAYMENT: '💰',
    FUNDED: '✅',
    AWAITING_CREATIVE: '📝',
    CREATIVE_SUBMITTED: '📤',
    CREATIVE_APPROVED: '👍',
    SCHEDULED: '📅',
    POSTED: '📢',
    VERIFIED: '✔️',
    COMPLETED: '🎉',
    CANCELLED: '❌',
    DISPUTED: '⚠️',
  };

  const statusLabel = formatDealStatus(deal.status);
  const statusWithEmoji = `${statusEmoji[deal.status] || '❓'} ${statusLabel}`;
  const summary = [
    `Deal #${deal.dealNumber}`,
    `Channel: ${deal.channel.title}`,
    `Format: ${deal.adFormat.name}`,
    `Amount: ${deal.agreedPrice} ${deal.currency}`,
    `Status: ${statusWithEmoji}`,
    '',
    'Open deal details for next step.',
  ].join('\n');

  const notification = buildTemplatedTelegramNotification(
    'B28',
    { dealSummary: summary },
    { dealId },
  );

  await ctx.reply(notification.text, {
    parse_mode: notification.parseMode,
    reply_markup: notification.replyMarkup as any,
  });
});

// Verify channel bot admin status
bot.command('verify', async (ctx) => {
  const channelId = ctx.match;
  
  if (!channelId) {
    const usage = buildTemplatedTelegramNotification(
      'B29',
      { verifyExample: '`/verify <channel_id>`' },
      {},
    );
    await ctx.reply(usage.text, {
      parse_mode: usage.parseMode,
      reply_markup: usage.replyMarkup as any,
    });
    return;
  }

  // This would be called after bot is added to channel
  const checking = buildTemplatedTelegramNotification('B30', {}, { channelId });
  await ctx.reply(checking.text, {
    parse_mode: checking.parseMode,
    reply_markup: checking.replyMarkup as any,
  });

  // TODO: Verify bot is admin in the channel
  // await verifyChannelBotStatus(channelId);

  const success = buildTemplatedTelegramNotification('B31', {}, { channelId });
  await ctx.reply(success.text, {
    parse_mode: success.parseMode,
    reply_markup: success.replyMarkup as any,
  });
});

bot.command('close', async (ctx) => {
  if (!ctx.chat || ctx.chat.type !== 'private' || !ctx.message || !ctx.from || ctx.from.is_bot) {
    return;
  }

  const incomingThreadId = extractIncomingThreadId(ctx.message);
  if (incomingThreadId === null) {
    await ctx.reply('Use /close inside the deal chat topic.');
    return;
  }

  const routing = await dealChatService.resolveRouteByIncomingThread({
    telegramUserId: ctx.from.id,
    messageThreadId: incomingThreadId,
  });

  if (!routing) {
    await sendTopicMessageBestEffort({
      chatId: BigInt(ctx.chat.id),
      threadId: incomingThreadId,
      text: 'This topic is not linked to a deal chat.',
      context: 'close-untracked-topic',
    });
    return;
  }

  try {
    const wasAlreadyClosed = routing.status === DealChatStatus.CLOSED;

    if (!wasAlreadyClosed) {
      await dealChatService.closeDealChat({
        dealId: routing.dealId,
        closedByTelegramUserId: ctx.from.id,
      });
    }

    await finalizeDealTopicsOnClose(routing.dealId);

    await sendTopicMessageBestEffort({
      chatId: BigInt(ctx.chat.id),
      threadId: routing.fromThreadId,
      text: wasAlreadyClosed ? 'Deal chat is already closed.' : 'Deal chat closed.',
      context: 'close-success',
    });
  } catch (error) {
    console.error(`Failed to close deal chat for deal ${routing.dealId}:`, error);
    await sendTopicMessageBestEffort({
      chatId: BigInt(ctx.chat.id),
      threadId: routing.fromThreadId,
      text: 'Failed to close deal chat.',
      context: 'close-failed',
    });
  }
});

// Handle callback queries
bot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;

  const openDealId = extractDealIdFromOpenCallback(data);
  if (openDealId) {
    console.log(`Received open deal callback for deal ${openDealId} from user ${ctx.from?.id ?? 'unknown'}`);
    try {
      if (!ctx.from?.id) {
        throw new Error('Telegram user is not available');
      }

      const opened = await handleOpenDealChatEntry({
        dealId: openDealId,
        telegramUserId: ctx.from.id,
      });

      await ctx.answerCallbackQuery({
        text: opened.statusText.slice(0, 180),
      });
      await ctx.reply(opened.statusText);
    } catch (error) {
      console.error(`Failed to open deal chat from callback for deal ${openDealId}:`, error);
      await ctx.answerCallbackQuery({
        text: 'Failed to open deal chat',
        show_alert: true,
      });
    }
    return;
  }

  if (data.startsWith('approve_creative_')) {
    const dealId = data.replace('approve_creative_', '');
    const notification = buildTemplatedTelegramNotification('B32', {}, { dealId });
    await ctx.answerCallbackQuery({ text: notification.template.message.slice(0, 180) });
    await ctx.reply(notification.text, {
      parse_mode: notification.parseMode,
      reply_markup: notification.replyMarkup as any,
    });
  }

  if (data.startsWith('reject_creative_')) {
    const dealId = data.replace('reject_creative_', '');
    const notification = buildTemplatedTelegramNotification('B33', {}, { dealId });
    await ctx.answerCallbackQuery({ text: notification.template.message.slice(0, 180) });
    await ctx.reply(notification.text, {
      parse_mode: notification.parseMode,
      reply_markup: notification.replyMarkup as any,
    });
  }
});

// Relay deal chat messages between private forum topics.
bot.on('message', async (ctx) => {
  if (!ctx.chat || ctx.chat.type !== 'private') {
    return;
  }

  if (!ctx.message || !ctx.from || ctx.from.is_bot) {
    return;
  }

  if (isBotCommandMessage(ctx)) {
    return;
  }

  // Do not auto-reply to contact-sharing payloads.
  if (isContactSharingMessage(ctx)) {
    return;
  }

  const incomingThreadId = extractIncomingThreadId(ctx.message);
  if (incomingThreadId === null) {
    await bot.api.sendMessage(
      ctx.chat.id.toString(),
      DIRECT_MESSAGE_TOPIC_ONLY_NOTICE,
    );
    return;
  }

  const routing = await dealChatService.resolveRouteByIncomingThread({
    telegramUserId: ctx.from.id,
    messageThreadId: incomingThreadId,
  });

  if (!routing) {
    // Not a tracked deal topic.
    return;
  }

  if (routing.status === DealChatStatus.CLOSED) {
    await sendTopicMessageBestEffort({
      chatId: BigInt(ctx.chat.id),
      threadId: routing.fromThreadId,
      text: 'Deal chat is closed.',
      context: 'relay-chat-closed',
    });
    return;
  }

  if (!routing.canRelay || routing.toThreadId === null) {
    await sendTopicMessageBestEffort({
      chatId: BigInt(ctx.chat.id),
      threadId: routing.fromThreadId,
      text: "Counterparty hasn't opened deal chat yet.",
      context: 'relay-counterparty-not-opened',
    });
    return;
  }

  const counterpartyChatId = await resolveCounterpartyChatId(routing.dealId, routing.toSide);
  if (!counterpartyChatId) {
    await sendTopicMessageBestEffort({
      chatId: BigInt(ctx.chat.id),
      threadId: routing.fromThreadId,
      text: "Counterparty hasn't opened deal chat yet.",
      context: 'relay-counterparty-chat-missing',
    });
    return;
  }

  let destinationTopic: Awaited<ReturnType<typeof ensureParticipantTopic>>;
  try {
    destinationTopic = await ensureParticipantTopic({
      dealId: routing.dealId,
      side: routing.toSide,
      recreateOnUnreachable: false,
    });
  } catch (error) {
    console.error(`Failed to verify destination topic for deal ${routing.dealId}:`, error);
    await sendCriticalTopicMessage({
      chatId: BigInt(ctx.chat.id),
      threadId: routing.fromThreadId,
      text: 'Failed to relay message. Please try again.',
      context: 'relay-verify-topic-failed',
    });
    return;
  }

  try {
    await relayIncomingMessageToTopic({
      message: ctx.message,
      fromSide: routing.fromSide,
      sourceChatId: BigInt(ctx.chat.id),
      destinationChatId: destinationTopic.chatId,
      destinationThreadId: destinationTopic.threadId,
    });
  } catch (error) {
    if (isMissingTopicError(error)) {
      const recoveryResult = await recoverRelayAndRetryOnce({
        dealId: routing.dealId,
        fromThreadId: routing.fromThreadId,
        toSide: routing.toSide,
        ensureDestinationTopic: () => ensureParticipantTopic(
          buildRecoveryEnsureParticipantTopicParams(routing.dealId, routing.toSide),
        ),
        retryRelayToDestination: (recoveredDestination) => relayIncomingMessageToTopic({
          message: ctx.message,
          fromSide: routing.fromSide,
          sourceChatId: BigInt(ctx.chat.id),
          destinationChatId: recoveredDestination.chatId,
          destinationThreadId: recoveredDestination.threadId,
        }),
        notifySenderResend: () => notifySenderResendAfterTopicRecovery({
          chatId: BigInt(ctx.chat.id),
          threadId: routing.fromThreadId,
        }),
      });
      if (recoveryResult !== 'recovery_failed') {
        return;
      }
    }

    console.error(`Failed to relay deal chat message for deal ${routing.dealId}:`, error);
    await sendCriticalTopicMessage({
      chatId: BigInt(ctx.chat.id),
      threadId: routing.fromThreadId,
      text: 'Failed to relay message. Please try again.',
      context: 'relay-failed',
    });
  }
});

// Error handler
bot.catch((err) => {
  console.error('Bot error:', err);
});

/**
 * Send notification to user via bot
 */
export async function sendNotification(
  telegramId: bigint,
  message: string,
  options?: {
    parseMode?: 'HTML' | 'Markdown';
    replyMarkup?: unknown;
  },
) {
  try {
    await bot.api.sendMessage(telegramId.toString(), message, {
      parse_mode: options?.parseMode || 'HTML',
      reply_markup: options?.replyMarkup as any,
    });
  } catch (error) {
    console.error(`Failed to send notification to ${telegramId}:`, error);
    throw error;
  }
}

/**
 * Post content to channel
 */
export async function postToChannel(
  channelId: bigint,
  content: {
    text?: string;
    mediaUrls?: string[];
    buttons?: Array<{ text: string; url: string }>;
  },
): Promise<bigint | null> {
  try {
    // TODO: Implement actual posting with media support
    const message = await bot.api.sendMessage(channelId.toString(), content.text || '', {
      parse_mode: 'HTML',
      reply_markup: content.buttons
        ? {
            inline_keyboard: [content.buttons.map((b) => ({ text: b.text, url: b.url }))],
          }
        : undefined,
    });

    return BigInt(message.message_id);
  } catch (error) {
    console.error(`Failed to post to channel ${channelId}:`, error);
    return null;
  }
}

/**
 * Check if post still exists in channel
 */
export async function verifyPostExists(
  channelId: bigint,
  messageId: bigint,
): Promise<boolean> {
  try {
    // Try to forward the message to check if it exists
    // This is a workaround since Telegram doesn't have a direct "getMessage" method
    // In production, you might want to use a different approach
    
    // For now, just return true as a stub
    console.log(`Verifying post ${messageId} in channel ${channelId}`);
    return true;
  } catch (error) {
    console.error(`Post verification failed:`, error);
    return false;
  }
}

/**
 * Get channel info via bot
 */
export async function getChannelInfo(channelId: bigint) {
  try {
    const chat = await bot.api.getChat(channelId.toString());
    const memberCount = await bot.api.getChatMemberCount(channelId.toString());

    return {
      id: chat.id,
      title: 'title' in chat ? chat.title : '',
      username: 'username' in chat ? chat.username : undefined,
      description: 'description' in chat ? chat.description : undefined,
      memberCount,
      photo: 'photo' in chat ? chat.photo : undefined,
    };
  } catch (error) {
    console.error(`Failed to get channel info for ${channelId}:`, error);
    return null;
  }
}

/**
 * Start the bot (for standalone use)
 */
export function startBot() {
  if (!config.telegramBotToken) {
    console.warn('⚠️ TELEGRAM_BOT_TOKEN not set, bot disabled');
    return;
  }

  void (async () => {
    try {
      // Long polling worker must not compete with webhook mode.
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch (error) {
      console.warn('⚠️ Failed to clear Telegram webhook before polling start:', error);
    }

    topicApiCapabilities = detectTopicApiCapabilities();
    if (!topicApiCapabilities.createForumTopic) {
      console.warn('⚠️ Bot API method createForumTopic is unavailable. Deal chat topic creation will fail.');
    }
    if (!topicApiCapabilities.editForumTopic) {
      console.warn('⚠️ Bot API method editForumTopic is unavailable. Topic rename fallback may fail.');
    }
    if (!topicApiCapabilities.deleteForumTopic && !deleteTopicCapabilityWarningShown) {
      deleteTopicCapabilityWarningShown = true;
      console.warn('[deal-chat] Bot API method deleteForumTopic is unavailable. Using rename fallback on close.');
    }

    await bot.start({
      onStart: (info) => {
        console.log(`🤖 Bot started: @${info.username}`);
      },
    });
  })().catch((error) => {
    console.error('❌ Telegram bot failed to start:', error);
  });
}

export const telegramBot = {
  bot,
  sendNotification,
  createPrivateDealTopic,
  openDealChatInPrivateTopic,
  finalizeDealTopicsOnClose,
  postToChannel,
  verifyPostExists,
  getChannelInfo,
  startBot,
};

// Export bot instance directly
export { bot };
