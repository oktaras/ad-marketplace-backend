import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DealChatStatus } from '@prisma/client';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    user: {
      findUnique: vi.fn(),
    },
    dealChatBridge: {
      findMany: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    deal: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock('../../lib/prisma.js', () => ({
  prisma: prismaMock,
}));

import {
  bindThreadForParticipantWithExpectation,
  resolveRouteByIncomingThread,
} from './index.js';

describe('deal-chat route resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes deterministically to newest match and logs high-severity anomaly', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' });
    prismaMock.dealChatBridge.findMany.mockResolvedValue([
      {
        id: 'bridge-new',
        dealId: 'deal-new',
        status: DealChatStatus.ACTIVE,
        advertiserThreadId: 111n,
        publisherThreadId: 222n,
        updatedAt: new Date('2026-02-16T10:00:00.000Z'),
        createdAt: new Date('2026-02-16T09:00:00.000Z'),
        deal: {
          advertiserId: 'user-1',
          channelOwnerId: 'user-2',
          status: 'CREATED',
        },
      },
      {
        id: 'bridge-old',
        dealId: 'deal-old',
        status: DealChatStatus.ACTIVE,
        advertiserThreadId: 111n,
        publisherThreadId: 333n,
        updatedAt: new Date('2026-02-16T08:00:00.000Z'),
        createdAt: new Date('2026-02-16T07:00:00.000Z'),
        deal: {
          advertiserId: 'user-1',
          channelOwnerId: 'user-3',
          status: 'CREATED',
        },
      },
    ]);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const resolved = await resolveRouteByIncomingThread({
        telegramUserId: 999n,
        messageThreadId: 111n,
      });

      expect(resolved?.dealId).toBe('deal-new');
      expect(resolved?.fromThreadId).toBe(111n);
      expect(prismaMock.dealChatBridge.findMany).toHaveBeenCalledWith(expect.objectContaining({
        take: 2,
        orderBy: [
          { updatedAt: 'desc' },
          { createdAt: 'desc' },
          { id: 'asc' },
        ],
      }));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('severity=high event=ambiguous-route-candidates'));
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('bindThreadForParticipantWithExpectation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not overwrite thread mapping on CAS miss', async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      deal: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'deal-1',
          advertiserId: 'user-1',
          channelOwnerId: 'user-2',
          status: 'CREATED',
        }),
      },
      dealChatBridge: {
        upsert: vi.fn().mockResolvedValue({
          id: 'bridge-1',
          dealId: 'deal-1',
          status: DealChatStatus.PENDING_OPEN,
          advertiserThreadId: 700n,
          publisherThreadId: 800n,
          advertiserOpenedAt: null,
          publisherOpenedAt: null,
          closedAt: null,
          closedByUserId: null,
          createdAt: new Date('2026-02-16T10:00:00.000Z'),
          updatedAt: new Date('2026-02-16T10:00:00.000Z'),
        }),
        update: vi.fn(),
      },
    };
    prismaMock.$transaction.mockImplementation(async (callback: (txClient: typeof tx) => Promise<unknown>) => callback(tx));

    const result = await bindThreadForParticipantWithExpectation({
      dealId: 'deal-1',
      side: 'ADVERTISER',
      candidateThreadId: 701n,
      expectedThreadId: 1n,
    });

    expect(result.applied).toBe(false);
    expect(result.threadId).toBe(700n);
    expect(tx.dealChatBridge.update).not.toHaveBeenCalled();
  });

  it('applies mapping when expected thread matches and updates status', async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      deal: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'deal-2',
          advertiserId: 'user-1',
          channelOwnerId: 'user-2',
          status: 'CREATED',
        }),
      },
      dealChatBridge: {
        upsert: vi.fn().mockResolvedValue({
          id: 'bridge-2',
          dealId: 'deal-2',
          status: DealChatStatus.PENDING_OPEN,
          advertiserThreadId: null,
          publisherThreadId: 900n,
          advertiserOpenedAt: null,
          publisherOpenedAt: new Date('2026-02-16T10:00:00.000Z'),
          closedAt: null,
          closedByUserId: null,
          createdAt: new Date('2026-02-16T10:00:00.000Z'),
          updatedAt: new Date('2026-02-16T10:00:00.000Z'),
        }),
        update: vi.fn().mockResolvedValue({
          id: 'bridge-2',
          dealId: 'deal-2',
          status: DealChatStatus.ACTIVE,
          advertiserThreadId: 901n,
          publisherThreadId: 900n,
          advertiserOpenedAt: new Date('2026-02-16T11:00:00.000Z'),
          publisherOpenedAt: new Date('2026-02-16T10:00:00.000Z'),
          closedAt: null,
          closedByUserId: null,
          createdAt: new Date('2026-02-16T10:00:00.000Z'),
          updatedAt: new Date('2026-02-16T11:00:00.000Z'),
        }),
      },
    };
    prismaMock.$transaction.mockImplementation(async (callback: (txClient: typeof tx) => Promise<unknown>) => callback(tx));

    const result = await bindThreadForParticipantWithExpectation({
      dealId: 'deal-2',
      side: 'ADVERTISER',
      candidateThreadId: 901n,
      expectedThreadId: null,
    });

    expect(result.applied).toBe(true);
    expect(result.threadId).toBe(901n);
    expect(result.status).toBe(DealChatStatus.ACTIVE);
    expect(tx.dealChatBridge.update).toHaveBeenCalledTimes(1);
  });
});
