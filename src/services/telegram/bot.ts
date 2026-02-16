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

function isMissingTopicError(error: unknown): boolean {
  const normalized = extractErrorText(error).toLowerCase();
  return [
    'message thread not found',
    'message_thread_not_found',
    'forum topic not found',
    'topic not found',
    'topic deleted',
    'topic_deleted',
    'thread not found',
    'message thread is not found',
  ].some((token) => normalized.includes(token));
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
  await sendTopicMessageWithRetry({
    chatId: params.chatId,
    threadId: params.threadId,
    text: `Deal #${params.dealNumber} chat opened.\nMessages here are relayed anonymously.`,
    context: `welcome:${params.dealNumber}`,
  });
}

async function sendDealTopicRestoredMessage(params: {
  chatId: bigint;
  threadId: bigint;
  dealNumber: number;
}): Promise<void> {
  await sendTopicMessageWithRetry({
    chatId: params.chatId,
    threadId: params.threadId,
    text: 'Your deal chat was restored. Continue here.',
    context: `restored:${params.dealNumber}`,
  });
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

  await Promise.allSettled([
    callWithTopicThreadParamFallback({
      chatId: advertiserChatId,
      threadId: advertiserThreadId,
      operation: (topicParam) => bot.api.sendMessage(
        advertiserChatId.toString(),
        connectedMessage,
        topicParam as any,
      ),
    }),
    callWithTopicThreadParamFallback({
      chatId: publisherChatId,
      threadId: publisherThreadId,
      operation: (topicParam) => bot.api.sendMessage(
        publisherChatId.toString(),
        connectedMessage,
        topicParam as any,
      ),
    }),
  ]);
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

async function sendTopicMessageWithRetry(params: {
  chatId: bigint;
  threadId: bigint;
  text: string;
  context: string;
  maxAttempts?: number;
}): Promise<void> {
  const maxAttempts = Math.max(1, params.maxAttempts ?? 4);

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
      const isMissingThread = isMissingTopicError(error);
      const canRetryMissing = isMissingThread && attempt < maxAttempts;
      if (canRetryMissing) {
        const delayMs = Math.min(1200, 150 * attempt);
        await sleep(delayMs);
        continue;
      }

      console.warn(
        `[deal-chat] failed to send topic message context=${params.context} chatId=${params.chatId.toString()} threadId=${params.threadId.toString()}`,
        error,
      );
      return;
    }
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

  if (!chatId) {
    throw new Error(`Missing Telegram ID for deal participant side: ${params.side}`);
  }

  if (existingThreadId !== null) {
    const reachable = await isThreadReachable(chatId, existingThreadId);
    const shouldRecreateOnUnreachable = params.recreateOnUnreachable ?? true;
    const withinRecentGraceWindow = isRecentDateWithinMs(existingOpenedAt, TOPIC_RECENT_GRACE_MS);
    if (!reachable && shouldRecreateOnUnreachable && withinRecentGraceWindow) {
      return {
        chatId,
        threadId: existingThreadId,
        recreated: false,
        reachable: false,
        status: deal.dealChatBridge?.status ?? DealChatStatus.PENDING_OPEN,
        counterpartyThreadId,
      };
    }
    if (reachable || !shouldRecreateOnUnreachable) {
      return {
        chatId,
        threadId: existingThreadId,
        recreated: false,
        reachable,
        status: deal.dealChatBridge?.status ?? DealChatStatus.PENDING_OPEN,
        counterpartyThreadId,
      };
    }
  }

  const createdThreadId = await createPrivateDealTopic(
    chatId,
    `Deal #${deal.dealNumber}`,
  );

  const rebound = await dealChatService.rebindThreadForParticipant({
    dealId: normalizedDealId,
    side: params.side,
    threadId: createdThreadId,
  });

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
    status: rebound.status,
    counterpartyThreadId: rebound.counterpartyThreadId,
  };
}

export async function openDealChatInPrivateTopic(params: {
  dealId: string;
  telegramUserId: ChatIdLike;
}) {
  const telegramUserId = parsePositiveBigInt(params.telegramUserId, 'telegramUserId');
  const initial = await dealChatService.openDealChatForUser({
    dealId: params.dealId,
    telegramUserId,
  });

  let finalState = initial;
  let topicCreated = false;

  if (initial.status !== DealChatStatus.CLOSED) {
    const ensured = await ensureParticipantTopic({
      dealId: params.dealId,
      side: initial.participantSide as DealChatParticipantSide,
    });
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
    await sendTopicMessageWithRetry({
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

    await sendTopicMessageWithRetry({
      chatId: BigInt(ctx.chat.id),
      threadId: routing.fromThreadId,
      text: wasAlreadyClosed ? 'Deal chat is already closed.' : 'Deal chat closed.',
      context: 'close-success',
    });
  } catch (error) {
    console.error(`Failed to close deal chat for deal ${routing.dealId}:`, error);
    await sendTopicMessageWithRetry({
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
    await sendTopicMessageWithRetry({
      chatId: BigInt(ctx.chat.id),
      threadId: routing.fromThreadId,
      text: 'Deal chat is closed.',
      context: 'relay-chat-closed',
    });
    return;
  }

  if (!routing.canRelay || routing.toThreadId === null) {
    await sendTopicMessageWithRetry({
      chatId: BigInt(ctx.chat.id),
      threadId: routing.fromThreadId,
      text: "Counterparty hasn't opened deal chat yet.",
      context: 'relay-counterparty-not-opened',
    });
    return;
  }

  const counterpartyChatId = await resolveCounterpartyChatId(routing.dealId, routing.toSide);
  if (!counterpartyChatId) {
    await sendTopicMessageWithRetry({
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
    await sendTopicMessageWithRetry({
      chatId: BigInt(ctx.chat.id),
      threadId: routing.fromThreadId,
      text: 'Failed to relay message. Please try again.',
      context: 'relay-verify-topic-failed',
    });
    return;
  }

  if (destinationTopic.recreated) {
    await notifySenderResendAfterTopicRecovery({
      chatId: BigInt(ctx.chat.id),
      threadId: routing.fromThreadId,
    });
    return;
  }

  try {
    const roleLabel = formatParticipantRoleLabel(routing.fromSide);
    const relayText = extractRelayTextFromMessage(ctx.message, roleLabel);
    if (relayText !== null) {
      await sendRelayTextMessage({
        destinationChatId: destinationTopic.chatId,
        destinationThreadId: destinationTopic.threadId,
        text: relayText,
      });
      return;
    }

    const relayCaption = extractRelayCaptionFromMessage(ctx.message, roleLabel);

    await copyMessageToTopic({
      destinationChatId: destinationTopic.chatId,
      destinationThreadId: destinationTopic.threadId,
      sourceChatId: BigInt(ctx.chat.id),
      sourceMessageId: ctx.message.message_id,
      ...(relayCaption !== null ? { caption: relayCaption } : {}),
    });
  } catch (error) {
    if (isMissingTopicError(error)) {
      try {
        const recoveredDestination = await ensureParticipantTopic({
          dealId: routing.dealId,
          side: routing.toSide,
        });

        if (recoveredDestination.recreated) {
          await notifySenderResendAfterTopicRecovery({
            chatId: BigInt(ctx.chat.id),
            threadId: routing.fromThreadId,
          });
          return;
        }
      } catch (recoveryError) {
        console.error(`Failed to recover destination topic after relay error for deal ${routing.dealId}:`, recoveryError);
      }
    }

    console.error(`Failed to relay deal chat message for deal ${routing.dealId}:`, error);
    await sendTopicMessageWithRetry({
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
