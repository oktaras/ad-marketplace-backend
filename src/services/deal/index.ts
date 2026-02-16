import { prisma } from '../../lib/prisma.js';
import { DealStatus, type Prisma } from '@prisma/client';
import { ValidationError } from '../../middleware/error.js';
import { appEvents, AppEvent } from '../events.js';

/**
 * Calculate platform fee and publisher amount
 */
export function calculateFees(agreedPrice: string, feeBps: number) {
  // Convert to bigint for precision (nanoTON)
  const amount = BigInt(agreedPrice);
  const platformFeeAmount = (amount * BigInt(feeBps)) / BigInt(10000);
  const publisherAmount = amount - platformFeeAmount;

  return {
    platformFeeAmount: platformFeeAmount.toString(),
    publisherAmount: publisherAmount.toString(),
  };
}

type ActorRole = 'SYSTEM' | 'ADVERTISER' | 'PUBLISHER' | 'UNKNOWN';

type TransitionRule = {
  from: DealStatus[];
  actors: ActorRole[];
};

type DealForActions = {
  status: DealStatus;
  advertiserId: string;
  channelOwnerId: string;
};

type StatusHistoryItem = {
  status: string;
  timestamp: string;
  actor: string;
};

const CANCELABLE_STATUSES: DealStatus[] = [
  DealStatus.CREATED,
  DealStatus.NEGOTIATING,
  DealStatus.TERMS_AGREED,
  DealStatus.AWAITING_PAYMENT,
  DealStatus.FUNDED,
  DealStatus.AWAITING_CREATIVE,
  DealStatus.CREATIVE_SUBMITTED,
  DealStatus.CREATIVE_REVISION,
  DealStatus.CREATIVE_APPROVED,
  DealStatus.AWAITING_POSTING_PLAN,
  DealStatus.POSTING_PLAN_AGREED,
  DealStatus.SCHEDULED,
  DealStatus.AWAITING_MANUAL_POST,
  DealStatus.POSTING,
];

const TRANSITION_RULES: Partial<Record<DealStatus, TransitionRule>> = {
  [DealStatus.NEGOTIATING]: {
    from: [DealStatus.CREATED, DealStatus.NEGOTIATING],
    actors: ['ADVERTISER', 'PUBLISHER', 'SYSTEM'],
  },
  [DealStatus.TERMS_AGREED]: {
    from: [DealStatus.CREATED, DealStatus.NEGOTIATING],
    actors: ['ADVERTISER', 'PUBLISHER', 'SYSTEM'],
  },
  [DealStatus.AWAITING_PAYMENT]: {
    from: [DealStatus.TERMS_AGREED],
    actors: ['ADVERTISER', 'PUBLISHER', 'SYSTEM'],
  },
  [DealStatus.FUNDED]: {
    from: [DealStatus.AWAITING_PAYMENT],
    actors: ['ADVERTISER', 'PUBLISHER', 'SYSTEM'],
  },
  [DealStatus.AWAITING_CREATIVE]: {
    from: [DealStatus.FUNDED],
    actors: ['ADVERTISER', 'PUBLISHER', 'SYSTEM'],
  },
  [DealStatus.CREATIVE_SUBMITTED]: {
    from: [DealStatus.FUNDED, DealStatus.AWAITING_CREATIVE, DealStatus.CREATIVE_REVISION],
    actors: ['PUBLISHER', 'SYSTEM'],
  },
  [DealStatus.CREATIVE_REVISION]: {
    from: [DealStatus.CREATIVE_SUBMITTED],
    actors: ['ADVERTISER', 'SYSTEM'],
  },
  [DealStatus.CREATIVE_APPROVED]: {
    from: [DealStatus.CREATIVE_SUBMITTED],
    actors: ['ADVERTISER', 'SYSTEM'],
  },
  [DealStatus.AWAITING_POSTING_PLAN]: {
    from: [DealStatus.CREATIVE_APPROVED],
    actors: ['ADVERTISER', 'PUBLISHER', 'SYSTEM'],
  },
  [DealStatus.POSTING_PLAN_AGREED]: {
    from: [DealStatus.AWAITING_POSTING_PLAN],
    actors: ['ADVERTISER', 'PUBLISHER', 'SYSTEM'],
  },
  [DealStatus.SCHEDULED]: {
    from: [DealStatus.POSTING_PLAN_AGREED],
    actors: ['ADVERTISER', 'PUBLISHER', 'SYSTEM'],
  },
  [DealStatus.AWAITING_MANUAL_POST]: {
    from: [DealStatus.POSTING_PLAN_AGREED],
    actors: ['ADVERTISER', 'PUBLISHER', 'SYSTEM'],
  },
  [DealStatus.POSTING]: {
    from: [DealStatus.SCHEDULED, DealStatus.AWAITING_MANUAL_POST],
    actors: ['SYSTEM'],
  },
  [DealStatus.POSTED]: {
    from: [DealStatus.POSTING],
    actors: ['SYSTEM'],
  },
  [DealStatus.VERIFIED]: {
    from: [DealStatus.POSTED],
    actors: ['SYSTEM'],
  },
  [DealStatus.COMPLETED]: {
    from: [DealStatus.VERIFIED],
    actors: ['SYSTEM'],
  },
  [DealStatus.CANCELLED]: {
    from: [...CANCELABLE_STATUSES],
    actors: ['ADVERTISER', 'PUBLISHER', 'SYSTEM'],
  },
  [DealStatus.EXPIRED]: {
    from: [
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
    actors: ['SYSTEM'],
  },
  [DealStatus.REFUNDED]: {
    from: [
      DealStatus.CANCELLED,
      DealStatus.EXPIRED,
      DealStatus.POSTED,
      DealStatus.VERIFIED,
      DealStatus.DISPUTED,
    ],
    actors: ['SYSTEM', 'ADVERTISER', 'PUBLISHER'],
  },
  [DealStatus.DISPUTED]: {
    from: [
      DealStatus.FUNDED,
      DealStatus.AWAITING_CREATIVE,
      DealStatus.CREATIVE_SUBMITTED,
      DealStatus.CREATIVE_REVISION,
      DealStatus.CREATIVE_APPROVED,
      DealStatus.AWAITING_POSTING_PLAN,
      DealStatus.POSTING_PLAN_AGREED,
      DealStatus.SCHEDULED,
      DealStatus.POSTING,
      DealStatus.POSTED,
      DealStatus.VERIFIED,
    ],
    actors: ['ADVERTISER', 'PUBLISHER', 'SYSTEM'],
  },
  [DealStatus.RESOLVED]: {
    from: [DealStatus.DISPUTED],
    actors: ['SYSTEM'],
  },
};

const STAGE_TIMEOUT_HOURS: Partial<Record<DealStatus, number>> = {
  [DealStatus.CREATED]: 72,
  [DealStatus.NEGOTIATING]: 72,
  [DealStatus.TERMS_AGREED]: 48,
  [DealStatus.AWAITING_PAYMENT]: 48,
  [DealStatus.AWAITING_CREATIVE]: 48,
  [DealStatus.CREATIVE_SUBMITTED]: 72,
  [DealStatus.CREATIVE_REVISION]: 48,
  [DealStatus.AWAITING_POSTING_PLAN]: 48,
  [DealStatus.AWAITING_MANUAL_POST]: 24,
  [DealStatus.POSTED]: 72,
};

function parseStatusHistory(raw: Prisma.JsonValue): StatusHistoryItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((entry): entry is StatusHistoryItem => {
      if (!entry || typeof entry !== 'object') {
        return false;
      }
      const candidate = entry as Partial<StatusHistoryItem>;
      return typeof candidate.status === 'string' && typeof candidate.timestamp === 'string';
    })
    .map((entry) => ({
      status: entry.status,
      timestamp: entry.timestamp,
      actor: entry.actor ?? 'SYSTEM',
    }));
}

function resolveActorRole(deal: { advertiserId: string; channelOwnerId: string }, actorId: string): ActorRole {
  if (actorId === 'SYSTEM') {
    return 'SYSTEM';
  }
  if (actorId === deal.advertiserId) {
    return 'ADVERTISER';
  }
  if (actorId === deal.channelOwnerId) {
    return 'PUBLISHER';
  }
  return 'UNKNOWN';
}

function assertTransitionAllowed(params: {
  from: DealStatus;
  to: DealStatus;
  actorRole: ActorRole;
}) {
  const { from, to, actorRole } = params;

  if (from === to) {
    return;
  }

  const rule = TRANSITION_RULES[to];
  if (!rule) {
    throw new ValidationError(`No transition rule is defined for status ${to}`);
  }

  if (!rule.from.includes(from)) {
    throw new ValidationError(`Invalid transition: ${from} -> ${to}`);
  }

  if (!rule.actors.includes(actorRole)) {
    throw new ValidationError(`Actor ${actorRole} is not allowed to set status ${to}`);
  }
}

function getCurrentStageStartedAt(status: DealStatus, history: StatusHistoryItem[], fallbackIso: string): string {
  const latestMatch = [...history]
    .reverse()
    .find((entry) => entry.status === status && Number.isFinite(Date.parse(entry.timestamp)));
  return latestMatch?.timestamp ?? fallbackIso;
}

export function getDealDeadlineInfo(deal: {
  status: DealStatus;
  updatedAt: Date;
  statusHistory: Prisma.JsonValue;
}): {
  currentStageDeadlineAt: string | null;
  currentStageTimeoutHours: number | null;
  stageStartedAt: string | null;
} {
  const timeoutHours = STAGE_TIMEOUT_HOURS[deal.status];
  if (!timeoutHours) {
    return {
      currentStageDeadlineAt: null,
      currentStageTimeoutHours: null,
      stageStartedAt: null,
    };
  }

  const history = parseStatusHistory(deal.statusHistory);
  const stageStartedAt = getCurrentStageStartedAt(deal.status, history, deal.updatedAt.toISOString());
  const stageStartedTs = Date.parse(stageStartedAt);
  if (!Number.isFinite(stageStartedTs)) {
    return {
      currentStageDeadlineAt: null,
      currentStageTimeoutHours: timeoutHours,
      stageStartedAt: null,
    };
  }

  return {
    currentStageDeadlineAt: new Date(stageStartedTs + timeoutHours * 60 * 60 * 1000).toISOString(),
    currentStageTimeoutHours: timeoutHours,
    stageStartedAt,
  };
}

export function getDealAvailableActions(deal: DealForActions, userId: string) {
  const actorRole = resolveActorRole(deal, userId);
  const isParty = actorRole === 'ADVERTISER' || actorRole === 'PUBLISHER';

  return {
    acceptTerms: actorRole === 'PUBLISHER'
      && (deal.status === DealStatus.CREATED || deal.status === DealStatus.NEGOTIATING),
    fundDeal: actorRole === 'ADVERTISER'
      && (deal.status === DealStatus.TERMS_AGREED || deal.status === DealStatus.AWAITING_PAYMENT),
    verifyPayment: actorRole === 'ADVERTISER'
      && (deal.status === DealStatus.AWAITING_PAYMENT || deal.status === DealStatus.FUNDED),
    submitCreative: actorRole === 'PUBLISHER'
      && (deal.status === DealStatus.FUNDED || deal.status === DealStatus.AWAITING_CREATIVE || deal.status === DealStatus.CREATIVE_REVISION),
    approveCreative: actorRole === 'ADVERTISER' && deal.status === DealStatus.CREATIVE_SUBMITTED,
    requestCreativeRevision: actorRole === 'ADVERTISER' && deal.status === DealStatus.CREATIVE_SUBMITTED,
    cancelDeal: isParty && CANCELABLE_STATUSES.includes(deal.status),
    proposePostingPlan: isParty && deal.status === DealStatus.AWAITING_POSTING_PLAN,
    respondPostingPlan: isParty && deal.status === DealStatus.AWAITING_POSTING_PLAN,
    openDispute: false,
  };
}

/**
 * Update deal status with history tracking
 */
export async function updateStatus(
  dealId: string,
  newStatus: DealStatus,
  actorId: string,
  data?: Prisma.InputJsonValue,
) {
  const deal = await prisma.deal.findUniqueOrThrow({
    where: { id: dealId },
  });

  if (deal.status === newStatus) {
    const updated = await prisma.deal.findUniqueOrThrow({
      where: { id: dealId },
      include: {
        channel: true,
        adFormat: true,
        advertiser: {
          select: { id: true, username: true, firstName: true },
        },
        channelOwner: {
          select: { id: true, username: true, firstName: true },
        },
      },
    });

    return {
      ...updated,
      _transitioned: false,
    } as typeof updated & { _transitioned: boolean };
  }

  const actorRole = resolveActorRole(deal, actorId);
  assertTransitionAllowed({
    from: deal.status,
    to: newStatus,
    actorRole,
  });

  const statusHistory = parseStatusHistory(deal.statusHistory);

  statusHistory.push({
    status: newStatus,
    timestamp: new Date().toISOString(),
    actor: actorId,
  });

  const transitionData: Prisma.DealUpdateManyMutationInput = {
    status: newStatus,
    statusHistory,
  };

  if (newStatus === DealStatus.VERIFIED) {
    transitionData.verifiedAt = new Date();
  } else if (newStatus === DealStatus.COMPLETED) {
    transitionData.completedAt = new Date();
  }

  // Compare-and-swap: transition only if the status hasn't changed since we read it.
  const transitionResult = await prisma.deal.updateMany({
    where: {
      id: dealId,
      status: deal.status,
    },
    data: transitionData,
  });

  const updated = await prisma.deal.findUniqueOrThrow({
    where: { id: dealId },
    include: {
      channel: true,
      adFormat: true,
      advertiser: {
        select: { id: true, username: true, firstName: true },
      },
      channelOwner: {
        select: { id: true, username: true, firstName: true },
      },
    },
  });

  // If no row was changed, another concurrent request already moved the status.
  // Return latest state and avoid duplicating side-effects/events.
  if (transitionResult.count === 0) {
    return {
      ...updated,
      _transitioned: false,
    } as typeof updated & { _transitioned: boolean };
  }

  // Create event
  await prisma.dealEvent.create({
    data: {
      dealId,
      type: `STATUS_${newStatus}`,
      actorId: actorId === 'SYSTEM' ? null : actorId,
      actorType: actorId === 'SYSTEM' ? 'SYSTEM' : 'USER',
      fromStatus: deal.status,
      toStatus: newStatus,
      data: data ?? {},
    },
  });

  // Emit application event
  appEvents.emit(AppEvent.DEAL_STATUS_CHANGED, {
    dealId,
    oldStatus: deal.status,
    newStatus,
    userId: actorId,
  });

  // Emit specific events for certain status changes
  if (newStatus === DealStatus.TERMS_AGREED) {
    appEvents.emit(AppEvent.DEAL_ACCEPTED, {
      dealId,
      channelOwnerId: updated.channel.ownerId,
      advertiserId: updated.advertiserId,
    });
  } else if (newStatus === DealStatus.CANCELLED) {
    appEvents.emit(AppEvent.DEAL_CANCELLED, {
      dealId,
      reason: (data as any)?.reason || 'No reason provided',
      cancelledBy: actorId,
    });
  } else if (newStatus === DealStatus.COMPLETED) {
    appEvents.emit(AppEvent.DEAL_COMPLETED, {
      dealId,
      channelOwnerId: updated.channel.ownerId,
      advertiserId: updated.advertiserId,
    });
  }

  return {
    ...updated,
    _transitioned: true,
  } as typeof updated & { _transitioned: boolean };
}

/**
 * Check and expire stale deals
 */
export async function expireStaleDeals() {
  const now = new Date();

  // Find deals past their expiration
  const expiredDeals = await prisma.deal.findMany({
    where: {
      expiresAt: { lt: now },
      status: {
        in: ['CREATED', 'NEGOTIATING', 'TERMS_AGREED', 'AWAITING_PAYMENT'],
      },
    },
  });

  for (const deal of expiredDeals) {
    await updateStatus(deal.id, 'EXPIRED', 'SYSTEM', {
      reason: 'Deal expired due to inactivity',
    });
  }

  return expiredDeals.length;
}

export const dealService = {
  calculateFees,
  updateStatus,
  getDealAvailableActions,
  getDealDeadlineInfo,
  expireStaleDeals,
};
