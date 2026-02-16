import { DealChatStatus, DealStatus, type Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../middleware/error.js';

type ParticipantSide = 'ADVERTISER' | 'PUBLISHER';

type IdLike = string | number | bigint;

type DealPartyRecord = {
  id: string;
  advertiserId: string;
  channelOwnerId: string;
  status: DealStatus;
};

type DealChatBridgeRecord = {
  id: string;
  dealId: string;
  status: DealChatStatus;
  advertiserThreadId: bigint | null;
  publisherThreadId: bigint | null;
  advertiserOpenedAt: Date | null;
  publisherOpenedAt: Date | null;
  closedAt: Date | null;
  closedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ParticipantContext = {
  userId: string;
  side: ParticipantSide;
  deal: DealPartyRecord;
};

export type OpenDealChatForUserInput = {
  dealId: string;
  telegramUserId: IdLike;
  // Optional for future bot wiring: when provided, service can persist first-open thread.
  messageThreadId?: IdLike;
};

export type OpenDealChatForUserResult = {
  dealId: string;
  participantSide: ParticipantSide;
  status: DealChatStatus;
  threadId: bigint | null;
  counterpartyThreadId: bigint | null;
  reusedExistingThread: boolean;
  needsThreadCreation: boolean;
};

export type ResolveRouteByIncomingThreadInput = {
  telegramUserId: IdLike;
  messageThreadId: IdLike;
};

export type ResolveRouteByIncomingThreadResult = {
  dealId: string;
  status: DealChatStatus;
  fromSide: ParticipantSide;
  toSide: ParticipantSide;
  fromThreadId: bigint;
  toThreadId: bigint | null;
  canRelay: boolean;
} | null;

type CloseDealChatInput = {
  dealId: string;
  closedByTelegramUserId: IdLike;
};

type CloseDealChatBySystemInput = {
  dealId: string;
};

export type RebindThreadForParticipantInput = {
  dealId: string;
  side: ParticipantSide;
  threadId: IdLike;
};

export type RebindThreadForParticipantResult = {
  dealId: string;
  side: ParticipantSide;
  status: DealChatStatus;
  threadId: bigint;
  counterpartyThreadId: bigint | null;
};

export type BindThreadForParticipantWithExpectationInput = {
  dealId: string;
  side: ParticipantSide;
  candidateThreadId: IdLike;
  expectedThreadId: IdLike | null;
};

export type BindThreadForParticipantWithExpectationResult = {
  dealId: string;
  side: ParticipantSide;
  status: DealChatStatus;
  threadId: bigint | null;
  counterpartyThreadId: bigint | null;
  applied: boolean;
};

const LOCK_SIDE_KEY: Record<ParticipantSide | 'GLOBAL', number> = {
  GLOBAL: 11,
  ADVERTISER: 101,
  PUBLISHER: 202,
};

const TERMINAL_DEAL_STATUSES = new Set<DealStatus>([
  DealStatus.COMPLETED,
  DealStatus.CANCELLED,
  DealStatus.EXPIRED,
  DealStatus.REFUNDED,
  DealStatus.RESOLVED,
]);

function parsePositiveBigInt(value: IdLike, fieldName: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) {
      throw new Error('non-positive');
    }
    return parsed;
  } catch {
    throw new ValidationError(`Invalid ${fieldName}`);
  }
}

function hashToSignedInt32(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return hash;
}

async function lockDealSide(
  tx: Prisma.TransactionClient,
  dealId: string,
  side: ParticipantSide | 'GLOBAL',
): Promise<void> {
  const dealKey = hashToSignedInt32(dealId);
  const sideKey = LOCK_SIDE_KEY[side];
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(CAST(${dealKey} AS integer), CAST(${sideKey} AS integer))`;
}

function deriveStatusFromThreads(
  dealStatus: DealStatus,
  currentStatus: DealChatStatus,
  advertiserThreadId: bigint | null,
  publisherThreadId: bigint | null,
): DealChatStatus {
  if (TERMINAL_DEAL_STATUSES.has(dealStatus)) {
    return DealChatStatus.CLOSED;
  }

  if (currentStatus === DealChatStatus.CLOSED) {
    return DealChatStatus.CLOSED;
  }

  if (advertiserThreadId !== null && publisherThreadId !== null) {
    return DealChatStatus.ACTIVE;
  }

  return DealChatStatus.PENDING_OPEN;
}

async function getDealOrThrow(
  tx: Prisma.TransactionClient,
  dealId: string,
): Promise<DealPartyRecord> {
  const deal = await tx.deal.findUnique({
    where: { id: dealId },
    select: {
      id: true,
      advertiserId: true,
      channelOwnerId: true,
      status: true,
    },
  });

  if (!deal) {
    throw new NotFoundError('Deal');
  }

  return deal;
}

async function resolveParticipantContext(
  tx: Prisma.TransactionClient,
  dealId: string,
  telegramUserId: bigint,
): Promise<ParticipantContext> {
  const [deal, user] = await Promise.all([
    getDealOrThrow(tx, dealId),
    tx.user.findUnique({
      where: { telegramId: telegramUserId },
      select: { id: true },
    }),
  ]);

  if (!user) {
    throw new ForbiddenError('Telegram user is not linked to marketplace user');
  }

  if (deal.advertiserId === user.id) {
    return { userId: user.id, side: 'ADVERTISER', deal };
  }

  if (deal.channelOwnerId === user.id) {
    return { userId: user.id, side: 'PUBLISHER', deal };
  }

  throw new ForbiddenError('User is not a participant of this deal');
}

async function getOrCreateBridgeTx(
  tx: Prisma.TransactionClient,
  dealId: string,
): Promise<DealChatBridgeRecord> {
  return tx.dealChatBridge.upsert({
    where: { dealId },
    update: {},
    create: {
      dealId,
      status: DealChatStatus.PENDING_OPEN,
    },
  });
}

function getThreadFieldBySide(side: ParticipantSide): 'advertiserThreadId' | 'publisherThreadId' {
  return side === 'ADVERTISER' ? 'advertiserThreadId' : 'publisherThreadId';
}

function getOpenedAtFieldBySide(side: ParticipantSide): 'advertiserOpenedAt' | 'publisherOpenedAt' {
  return side === 'ADVERTISER' ? 'advertiserOpenedAt' : 'publisherOpenedAt';
}

function getCounterpartyThreadId(bridge: DealChatBridgeRecord, side: ParticipantSide): bigint | null {
  return side === 'ADVERTISER' ? bridge.publisherThreadId : bridge.advertiserThreadId;
}

export async function getOrCreateBridge(dealId: string): Promise<DealChatBridgeRecord> {
  if (!dealId.trim()) {
    throw new ValidationError('Deal ID is required');
  }

  return prisma.$transaction(async (tx) => {
    await lockDealSide(tx, dealId, 'GLOBAL');
    const deal = await getDealOrThrow(tx, dealId);
    const bridge = await getOrCreateBridgeTx(tx, dealId);
    const canonicalStatus = deriveStatusFromThreads(
      deal.status,
      bridge.status,
      bridge.advertiserThreadId,
      bridge.publisherThreadId,
    );

    if (canonicalStatus !== bridge.status) {
      return tx.dealChatBridge.update({
        where: { id: bridge.id },
        data: { status: canonicalStatus },
      });
    }

    return bridge;
  });
}

export async function openDealChatForUser(
  input: OpenDealChatForUserInput,
): Promise<OpenDealChatForUserResult> {
  if (!input.dealId.trim()) {
    throw new ValidationError('Deal ID is required');
  }

  const telegramUserId = parsePositiveBigInt(input.telegramUserId, 'telegramUserId');
  const incomingThreadId = input.messageThreadId !== undefined
    ? parsePositiveBigInt(input.messageThreadId, 'messageThreadId')
    : null;

  return prisma.$transaction(async (tx) => {
    const participant = await resolveParticipantContext(tx, input.dealId, telegramUserId);
    await lockDealSide(tx, input.dealId, participant.side);
    const freshDeal = await getDealOrThrow(tx, input.dealId);

    const bridge = await getOrCreateBridgeTx(tx, input.dealId);

    const threadField = getThreadFieldBySide(participant.side);
    const existingThreadId = bridge[threadField];

    let threadId = existingThreadId;
    let reusedExistingThread = existingThreadId !== null;
    let needsThreadCreation = existingThreadId === null && incomingThreadId === null;

    const isBridgeClosed = bridge.status === DealChatStatus.CLOSED;
    const isDealTerminal = TERMINAL_DEAL_STATUSES.has(freshDeal.status);

    const updatePayload: Prisma.DealChatBridgeUpdateInput = {};

    if (!isBridgeClosed && !isDealTerminal && existingThreadId === null && incomingThreadId !== null) {
      const openedAtField = getOpenedAtFieldBySide(participant.side);
      threadId = incomingThreadId;
      reusedExistingThread = false;
      needsThreadCreation = false;
      updatePayload[threadField] = incomingThreadId;
      updatePayload[openedAtField] = new Date();
    }

    const advertiserThreadId = threadField === 'advertiserThreadId'
      ? threadId
      : bridge.advertiserThreadId;
    const publisherThreadId = threadField === 'publisherThreadId'
      ? threadId
      : bridge.publisherThreadId;
    const nextStatus = deriveStatusFromThreads(
      freshDeal.status,
      bridge.status,
      advertiserThreadId,
      publisherThreadId,
    );

    if (nextStatus !== bridge.status) {
      updatePayload.status = nextStatus;
      if (nextStatus === DealChatStatus.CLOSED && bridge.closedAt === null) {
        updatePayload.closedAt = new Date();
      }
    }

    if (nextStatus === DealChatStatus.CLOSED) {
      needsThreadCreation = false;
    }

    let persistedBridge = bridge;
    if (Object.keys(updatePayload).length > 0) {
      persistedBridge = await tx.dealChatBridge.update({
        where: { id: bridge.id },
        data: updatePayload,
      });
    }

    return {
      dealId: input.dealId,
      participantSide: participant.side,
      status: persistedBridge.status,
      threadId: threadField === 'advertiserThreadId'
        ? persistedBridge.advertiserThreadId
        : persistedBridge.publisherThreadId,
      counterpartyThreadId: getCounterpartyThreadId(persistedBridge, participant.side),
      reusedExistingThread,
      needsThreadCreation,
    };
  });
}

export async function resolveRouteByIncomingThread(
  input: ResolveRouteByIncomingThreadInput,
): Promise<ResolveRouteByIncomingThreadResult> {
  const telegramUserId = parsePositiveBigInt(input.telegramUserId, 'telegramUserId');
  const messageThreadId = parsePositiveBigInt(input.messageThreadId, 'messageThreadId');

  const user = await prisma.user.findUnique({
    where: { telegramId: telegramUserId },
    select: { id: true },
  });

  if (!user) {
    return null;
  }

  const matches = await prisma.dealChatBridge.findMany({
    where: {
      OR: [
        {
          advertiserThreadId: messageThreadId,
          deal: { advertiserId: user.id },
        },
        {
          publisherThreadId: messageThreadId,
          deal: { channelOwnerId: user.id },
        },
      ],
    },
    take: 2,
    orderBy: [
      { updatedAt: 'desc' },
      { createdAt: 'desc' },
      { id: 'asc' },
    ],
    select: {
      id: true,
      dealId: true,
      status: true,
      advertiserThreadId: true,
      publisherThreadId: true,
      updatedAt: true,
      createdAt: true,
      deal: {
        select: {
          advertiserId: true,
          channelOwnerId: true,
          status: true,
        },
      },
    },
  });

  if (matches.length > 1) {
    console.error(
      `[deal-chat] severity=high event=ambiguous-route-candidates telegramUserId=${telegramUserId.toString()} messageThreadId=${messageThreadId.toString()} dealIds=${matches.map((entry) => entry.dealId).join(',')}`,
    );
  }

  const bridge = matches[0] ?? null;
  if (!bridge) {
    return null;
  }

  const fromSide: ParticipantSide = bridge.deal.advertiserId === user.id
    ? 'ADVERTISER'
    : 'PUBLISHER';
  const toSide: ParticipantSide = fromSide === 'ADVERTISER' ? 'PUBLISHER' : 'ADVERTISER';

  const fromThreadId = fromSide === 'ADVERTISER'
    ? bridge.advertiserThreadId
    : bridge.publisherThreadId;
  const toThreadId = toSide === 'ADVERTISER'
    ? bridge.advertiserThreadId
    : bridge.publisherThreadId;

  if (fromThreadId === null) {
    return null;
  }

  const canonicalStatus = deriveStatusFromThreads(
    bridge.deal.status,
    bridge.status,
    bridge.advertiserThreadId,
    bridge.publisherThreadId,
  );

  if (canonicalStatus !== bridge.status) {
    await prisma.dealChatBridge.update({
      where: { id: bridge.id },
      data: {
        status: canonicalStatus,
        ...(canonicalStatus === DealChatStatus.CLOSED && bridge.status !== DealChatStatus.CLOSED
          ? { closedAt: new Date() }
          : {}),
      },
    });
  }

  return {
    dealId: bridge.dealId,
    status: canonicalStatus,
    fromSide,
    toSide,
    fromThreadId,
    toThreadId,
    canRelay: canonicalStatus === DealChatStatus.ACTIVE && toThreadId !== null,
  };
}

export async function closeDealChat(input: CloseDealChatInput): Promise<DealChatBridgeRecord> {
  if (!input.dealId.trim()) {
    throw new ValidationError('Deal ID is required');
  }

  const closedByTelegramUserId = parsePositiveBigInt(
    input.closedByTelegramUserId,
    'closedByTelegramUserId',
  );

  return prisma.$transaction(async (tx) => {
    const participant = await resolveParticipantContext(tx, input.dealId, closedByTelegramUserId);
    await lockDealSide(tx, input.dealId, participant.side);
    await getOrCreateBridgeTx(tx, input.dealId);

    return tx.dealChatBridge.update({
      where: { dealId: input.dealId },
      data: {
        status: DealChatStatus.CLOSED,
        closedAt: new Date(),
        closedByUserId: participant.userId,
      },
    });
  });
}

export async function closeDealChatBySystem(
  input: CloseDealChatBySystemInput,
): Promise<DealChatBridgeRecord> {
  if (!input.dealId.trim()) {
    throw new ValidationError('Deal ID is required');
  }

  return prisma.$transaction(async (tx) => {
    await lockDealSide(tx, input.dealId, 'GLOBAL');
    await getDealOrThrow(tx, input.dealId);

    const bridge = await getOrCreateBridgeTx(tx, input.dealId);
    if (bridge.status === DealChatStatus.CLOSED && bridge.closedAt !== null) {
      return bridge;
    }

    return tx.dealChatBridge.update({
      where: { id: bridge.id },
      data: {
        status: DealChatStatus.CLOSED,
        ...(bridge.closedAt === null ? { closedAt: new Date() } : {}),
      },
    });
  });
}

export async function bindThreadForParticipantWithExpectation(
  input: BindThreadForParticipantWithExpectationInput,
): Promise<BindThreadForParticipantWithExpectationResult> {
  if (!input.dealId.trim()) {
    throw new ValidationError('Deal ID is required');
  }

  const candidateThreadId = parsePositiveBigInt(input.candidateThreadId, 'candidateThreadId');
  const expectedThreadId = input.expectedThreadId === null
    ? null
    : parsePositiveBigInt(input.expectedThreadId, 'expectedThreadId');

  return prisma.$transaction(async (tx) => {
    await lockDealSide(tx, input.dealId, input.side);
    const deal = await getDealOrThrow(tx, input.dealId);
    const bridge = await getOrCreateBridgeTx(tx, input.dealId);

    const threadField = getThreadFieldBySide(input.side);
    const openedAtField = getOpenedAtFieldBySide(input.side);
    const currentThreadId = bridge[threadField];

    if (currentThreadId !== expectedThreadId) {
      return {
        dealId: input.dealId,
        side: input.side,
        status: bridge.status,
        threadId: currentThreadId,
        counterpartyThreadId: getCounterpartyThreadId(bridge, input.side),
        applied: false,
      };
    }

    const advertiserThreadId = input.side === 'ADVERTISER'
      ? candidateThreadId
      : bridge.advertiserThreadId;
    const publisherThreadId = input.side === 'PUBLISHER'
      ? candidateThreadId
      : bridge.publisherThreadId;

    const nextStatus = deriveStatusFromThreads(
      deal.status,
      bridge.status,
      advertiserThreadId,
      publisherThreadId,
    );

    const updatePayload: Prisma.DealChatBridgeUpdateInput = {
      [threadField]: candidateThreadId,
      [openedAtField]: new Date(),
    };

    if (nextStatus !== bridge.status) {
      updatePayload.status = nextStatus;
      if (nextStatus === DealChatStatus.CLOSED && bridge.closedAt === null) {
        updatePayload.closedAt = new Date();
      }
    }

    const updated = await tx.dealChatBridge.update({
      where: { id: bridge.id },
      data: updatePayload,
    });

    return {
      dealId: input.dealId,
      side: input.side,
      status: updated.status,
      threadId: threadField === 'advertiserThreadId'
        ? updated.advertiserThreadId
        : updated.publisherThreadId,
      counterpartyThreadId: getCounterpartyThreadId(updated, input.side),
      applied: true,
    };
  });
}

export async function rebindThreadForParticipant(
  input: RebindThreadForParticipantInput,
): Promise<RebindThreadForParticipantResult> {
  if (!input.dealId.trim()) {
    throw new ValidationError('Deal ID is required');
  }

  const threadId = parsePositiveBigInt(input.threadId, 'threadId');

  return prisma.$transaction(async (tx) => {
    await lockDealSide(tx, input.dealId, input.side);
    const deal = await getDealOrThrow(tx, input.dealId);
    const bridge = await getOrCreateBridgeTx(tx, input.dealId);

    const threadField = getThreadFieldBySide(input.side);
    const openedAtField = getOpenedAtFieldBySide(input.side);

    const advertiserThreadId = input.side === 'ADVERTISER'
      ? threadId
      : bridge.advertiserThreadId;
    const publisherThreadId = input.side === 'PUBLISHER'
      ? threadId
      : bridge.publisherThreadId;

    const nextStatus = deriveStatusFromThreads(
      deal.status,
      bridge.status,
      advertiserThreadId,
      publisherThreadId,
    );

    const updatePayload: Prisma.DealChatBridgeUpdateInput = {
      [threadField]: threadId,
      [openedAtField]: new Date(),
    };

    if (nextStatus !== bridge.status) {
      updatePayload.status = nextStatus;
      if (nextStatus === DealChatStatus.CLOSED && bridge.closedAt === null) {
        updatePayload.closedAt = new Date();
      }
    }

    const updated = await tx.dealChatBridge.update({
      where: { id: bridge.id },
      data: updatePayload,
    });

    return {
      dealId: input.dealId,
      side: input.side,
      status: updated.status,
      threadId: threadField === 'advertiserThreadId'
        ? (updated.advertiserThreadId as bigint)
        : (updated.publisherThreadId as bigint),
      counterpartyThreadId: getCounterpartyThreadId(updated, input.side),
    };
  });
}

export const dealChatService = {
  getOrCreateBridge,
  openDealChatForUser,
  resolveRouteByIncomingThread,
  closeDealChat,
  closeDealChatBySystem,
  bindThreadForParticipantWithExpectation,
  rebindThreadForParticipant,
};
