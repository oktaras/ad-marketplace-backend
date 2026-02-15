import { StatsSource, GraphType } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { appEvents, AppEvent } from '../events.js';
import { bot } from './bot.js';
import {
  fetchChannelStatsFromMtproto,
  hasAuthorizedMtprotoSession,
  isMtprotoBotConfigured,
  ChannelStatsGraphData,
} from './mtproto.js';

export interface ChannelStatsData {
  // Subscriber metrics
  subscriberCount: number;
  subscriberCountPrevious?: number;

  // Post metrics - current period
  averageViewCount?: number;
  averageShareCount?: number;
  averageReactionCount?: number;

  // Post metrics - previous period
  averageViewCountPrev?: number;
  averageShareCountPrev?: number;
  averageReactionCountPrev?: number;

  // Story metrics - current period
  viewsPerStory?: number;
  sharesPerStory?: number;
  reactionsPerStory?: number;

  // Story metrics - previous period
  viewsPerStoryPrev?: number;
  sharesPerStoryPrev?: number;
  reactionsPerStoryPrev?: number;

  // Engagement rates
  engagementRate?: number;
  storyEngagementRate?: number;

  // Notification metrics
  notificationEnabledPart?: number;
  notificationEnabledTotal?: number;
  notificationEnabledRate?: number;

  // Period
  periodStart?: Date;
  periodEnd?: Date;

  // Audience insights
  languageDistribution?: Record<string, number>;
  premiumSubscriberPercent?: number;

  // Growth
  subscriberGrowth7d?: number;
  subscriberGrowth30d?: number;

  // Metadata
  description?: string;
  inviteLink?: string;
  rawData?: unknown;

  // Graph data
  graphs?: ChannelStatsGraphData[];
}

interface ProviderContext {
  channelId: string;
  ownerId: string;
  username: string;
}

interface ProviderResult {
  source: StatsSource;
  stats: ChannelStatsData;
}

interface StatsProvider {
  source: StatsSource;
  canHandle(ctx: ProviderContext): Promise<boolean>;
  fetch(ctx: ProviderContext): Promise<ChannelStatsData>;
}

class BotApiStatsProvider implements StatsProvider {
  source = StatsSource.BOT_API;

  async canHandle(ctx: ProviderContext): Promise<boolean> {
    return !!ctx.username;
  }

  async fetch(ctx: ProviderContext): Promise<ChannelStatsData> {
    return fetchChannelStats(ctx.username);
  }
}

class MtprotoStatsProvider implements StatsProvider {
  source = StatsSource.MTPROTO;

  async canHandle(ctx: ProviderContext): Promise<boolean> {
    if (!isMtprotoBotConfigured()) {
      return false;
    }
    return hasAuthorizedMtprotoSession(ctx.ownerId);
  }

  async fetch(ctx: ProviderContext): Promise<ChannelStatsData> {
    return fetchChannelStatsFromMtproto({
      channelId: ctx.channelId,
      ownerId: ctx.ownerId,
      channelUsername: ctx.username,
    });
  }
}

const providers: StatsProvider[] = [new MtprotoStatsProvider(), new BotApiStatsProvider()];

type DailySnapshotCandidate = {
  id: string;
  source: StatsSource;
  fetchedAt: Date;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function getUtcDayStart(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  ));
}

function getUtcDayBounds(date: Date): { start: Date; end: Date } {
  const start = getUtcDayStart(date);
  const end = new Date(start.getTime() + ONE_DAY_MS);
  return { start, end };
}

function selectDailySnapshotKeeper(candidates: DailySnapshotCandidate[]): DailySnapshotCandidate | null {
  if (candidates.length === 0) {
    return null;
  }

  const mtprotoCandidates = candidates.filter((entry) => entry.source === StatsSource.MTPROTO);
  const pool = mtprotoCandidates.length > 0 ? mtprotoCandidates : candidates;

  return [...pool].sort((left, right) => {
    const timeDelta = right.fetchedAt.getTime() - left.fetchedAt.getTime();
    if (timeDelta !== 0) {
      return timeDelta;
    }

    return right.id.localeCompare(left.id);
  })[0] ?? null;
}

/**
 * Fetch basic channel stats from Telegram Bot API.
 */
export async function fetchChannelStats(channelUsername: string): Promise<ChannelStatsData> {
  try {
    const chatId = channelUsername.startsWith('@')
      ? channelUsername
      : `@${channelUsername}`;

    const chat = await bot.api.getChat(chatId);
    if (chat.type !== 'channel') {
      throw new Error('Not a channel');
    }

    const memberCount = await bot.api.getChatMemberCount(chatId);

    return {
      subscriberCount: memberCount,
      description: chat.description,
      inviteLink: (chat as any).invite_link,
    };
  } catch (error: any) {
    if (error?.error_code === 400) {
      throw new Error('Channel not found or bot cannot access it');
    }

    throw error;
  }
}

async function resolveProviderResult(ctx: ProviderContext): Promise<ProviderResult> {
  const failures: Array<{ source: StatsSource; error: string }> = [];

  for (const provider of providers) {
    const canHandle = await provider.canHandle(ctx);
    if (!canHandle) {
      continue;
    }

    try {
      const stats = await provider.fetch(ctx);
      return {
        source: provider.source,
        stats,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown provider error';
      failures.push({ source: provider.source, error: message });
      console.warn(
        `Failed to fetch channel stats from ${provider.source} for ${ctx.username}: ${message}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      failures
        .map((failure) => `${failure.source}: ${failure.error}`)
        .join('; '),
    );
  }

  throw new Error('No stats provider available for this channel.');
}

/**
 * Update channel stats in database using the best available provider.
 */
export async function updateChannelStats(channelId: string): Promise<void> {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      ownerId: true,
      username: true,
    },
  });

  if (!channel) {
    throw new Error('Channel not found');
  }

  if (!channel.username) {
    throw new Error('Channel username is missing');
  }

  const { source, stats } = await resolveProviderResult({
    channelId: channel.id,
    ownerId: channel.ownerId,
    username: channel.username,
  });

  const fetchedAt = new Date();
  const dayBounds = getUtcDayBounds(fetchedAt);

  const persisted = await prisma.$transaction(async (tx) => {
    const sameDaySnapshots = await tx.channelStats.findMany({
      where: {
        channelId: channel.id,
        fetchedAt: {
          gte: dayBounds.start,
          lt: dayBounds.end,
        },
      },
      select: {
        id: true,
        source: true,
        fetchedAt: true,
      },
      orderBy: { fetchedAt: 'desc' },
    });

    const hasMtprotoSnapshot = sameDaySnapshots.some((entry) => entry.source === StatsSource.MTPROTO);
    if (source === StatsSource.BOT_API && hasMtprotoSnapshot) {
      const keeper = selectDailySnapshotKeeper(sameDaySnapshots);
      if (!keeper) {
        throw new Error('Failed to resolve same-day snapshot keeper');
      }

      const keeperStats = await tx.channelStats.findUnique({
        where: { id: keeper.id },
        select: {
          id: true,
          source: true,
          subscriberCount: true,
          avgViewsPerPost: true,
        },
      });

      if (!keeperStats) {
        throw new Error('Failed to load same-day snapshot keeper');
      }

      await tx.channel.update({
        where: { id: channel.id },
        data: {
          currentStatsId: keeper.id,
        },
      });

      return {
        mode: 'ignored' as const,
        snapshotId: keeperStats.id,
        source: keeperStats.source,
        subscriberCount: keeperStats.subscriberCount,
        avgViewsPerPost: keeperStats.avgViewsPerPost ?? 0,
      };
    }

    const snapshot = await tx.channelStats.create({
      data: {
        channelId: channel.id,
        source,

        // Period
        periodStart: stats.periodStart,
        periodEnd: stats.periodEnd,

        // Subscriber metrics
        subscriberCount: stats.subscriberCount,
        subscriberCountPrevious: stats.subscriberCountPrevious,
        subscriberGrowth7d: stats.subscriberGrowth7d,
        subscriberGrowth30d: stats.subscriberGrowth30d,

        // Post metrics - current
        avgViewsPerPost: stats.averageViewCount,
        avgSharesPerPost: stats.averageShareCount,
        avgReactionsPerPost: stats.averageReactionCount,

        // Post metrics - previous
        avgViewsPerPostPrev: stats.averageViewCountPrev,
        avgSharesPerPostPrev: stats.averageShareCountPrev,
        avgReactionsPerPostPrev: stats.averageReactionCountPrev,

        // Story metrics - current
        avgViewsPerStory: stats.viewsPerStory,
        avgSharesPerStory: stats.sharesPerStory,
        avgReactionsPerStory: stats.reactionsPerStory,

        // Story metrics - previous
        avgViewsPerStoryPrev: stats.viewsPerStoryPrev,
        avgSharesPerStoryPrev: stats.sharesPerStoryPrev,
        avgReactionsPerStoryPrev: stats.reactionsPerStoryPrev,

        // Engagement
        engagementRate: stats.engagementRate,
        storyEngagementRate: stats.storyEngagementRate,

        // Notification metrics
        notificationEnabledPart: stats.notificationEnabledPart,
        notificationEnabledTotal: stats.notificationEnabledTotal,
        notificationEnabledRate: stats.notificationEnabledRate,

        // Audience insights
        languageStats: stats.languageDistribution || {},
        premiumPercent: stats.premiumSubscriberPercent,

        // Schema version
        schemaVersion: 2,

        // Raw data
        rawData: (stats.rawData as any) ?? undefined,
        fetchedAt,
      },
    });

    if (stats.graphs && stats.graphs.length > 0) {
      const graphRecords = stats.graphs.map((graph) => ({
        statsId: snapshot.id,
        graphType: graph.graphType as GraphType,
        periodStart: graph.periodStart,
        periodEnd: graph.periodEnd,
        isAsync: graph.isAsync,
        asyncToken: graph.asyncToken || null,
        loadedAt: graph.isAsync && graph.timestamps.length > 0 ? new Date() : null,
        timestamps: graph.timestamps,
        series: graph.series,
        title: graph.title || null,
        xAxisFormat: graph.xAxisFormat || null,
        yAxisFormat: graph.yAxisFormat || null,
        rawGraph: graph.rawGraph || undefined,
      }));

      await tx.channelStatsGraph.createMany({
        data: graphRecords as any,
      });
    }

    const candidates: DailySnapshotCandidate[] = [
      ...sameDaySnapshots,
      {
        id: snapshot.id,
        source: snapshot.source,
        fetchedAt: snapshot.fetchedAt,
      },
    ];
    const keeper = selectDailySnapshotKeeper(candidates);
    if (!keeper) {
      throw new Error('Failed to resolve same-day snapshot keeper');
    }

    const staleSnapshotIds = candidates
      .filter((entry) => entry.id !== keeper.id)
      .map((entry) => entry.id);

    if (staleSnapshotIds.length > 0) {
      await tx.channelStats.deleteMany({
        where: {
          id: { in: staleSnapshotIds },
        },
      });
    }

    await tx.channel.update({
      where: { id: channelId },
      data: {
        ...(keeper.id === snapshot.id && stats.description !== undefined
          ? { description: stats.description }
          : {}),
        ...(keeper.id === snapshot.id && stats.inviteLink !== undefined
          ? { inviteLink: stats.inviteLink }
          : {}),
        currentStatsId: keeper.id,
      },
    });

    const keeperStats = keeper.id === snapshot.id
      ? snapshot
      : await tx.channelStats.findUnique({
          where: { id: keeper.id },
          select: {
            id: true,
            source: true,
            subscriberCount: true,
            avgViewsPerPost: true,
          },
        });

    if (!keeperStats) {
      throw new Error('Failed to load current snapshot keeper');
    }

    return {
      mode: 'stored' as const,
      snapshotId: keeperStats.id,
      source: keeperStats.source,
      subscriberCount: keeperStats.subscriberCount,
      avgViewsPerPost: keeperStats.avgViewsPerPost ?? 0,
    };
  });

  if (persisted.mode === 'stored') {
    appEvents.emit(AppEvent.STATS_UPDATED, {
      channelId: channel.id,
      subscriberCount: persisted.subscriberCount,
      avgViews: persisted.avgViewsPerPost,
      avgViewsPerPost: persisted.avgViewsPerPost,
    });
  }

  if (persisted.mode === 'ignored') {
    console.log(
      `ℹ️ Ignored BOT_API snapshot for channel ${channel.username}: MTPROTO snapshot already exists for ${dayBounds.start.toISOString().slice(0, 10)}.`,
    );
    return;
  }

  console.log(`✅ Updated stats for channel: ${channel.username} via ${persisted.source}`);
}

/**
 * Batch update all active channel stats.
 */
export async function refreshAllChannelStats(): Promise<void> {
  console.log('Starting batch channel stats refresh...');

  const activeChannels = await prisma.channel.findMany({
    where: {
      status: 'ACTIVE',
      deletedAt: null,
      username: { not: null },
    },
    select: {
      id: true,
      username: true,
    },
  });

  let updated = 0;
  let failed = 0;

  for (const channel of activeChannels) {
    try {
      await updateChannelStats(channel.id);
      updated++;
      await new Promise((resolve) => setTimeout(resolve, 200));
    } catch (error) {
      failed++;
      console.error(`Failed to update stats for ${channel.username}:`, error);

      if ((error as any)?.error_code === 429) {
        const retryAfter = (error as any)?.parameters?.retry_after || 30;
        console.log(`Rate limited. Waiting ${retryAfter} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
      }
    }
  }

  console.log(
    `Stats refresh complete: ${updated} updated, ${failed} failed out of ${activeChannels.length} channels`,
  );
}

/**
 * Get latest stats for a channel.
 */
export async function getLatestChannelStats(channelId: string) {
  return prisma.channelStats.findFirst({
    where: { channelId },
    orderBy: { fetchedAt: 'desc' },
  });
}

/**
 * Get stats history for a channel.
 */
export async function getChannelStatsHistory(channelId: string, days: number = 30) {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - days);

  const snapshots = await prisma.channelStats.findMany({
    where: {
      channelId,
      fetchedAt: {
        gte: sinceDate,
      },
    },
    orderBy: { fetchedAt: 'desc' },
  });

  const deduped = new Map<string, (typeof snapshots)[number]>();
  for (const snapshot of snapshots) {
    const dayKey = snapshot.fetchedAt.toISOString().slice(0, 10);
    if (!deduped.has(dayKey)) {
      deduped.set(dayKey, snapshot);
    }
  }

  return Array.from(deduped.values());
}

/**
 * Calculate channel growth metrics.
 */
export async function calculateChannelGrowth(channelId: string) {
  const latestStats = await getLatestChannelStats(channelId);
  const statsHistory = await getChannelStatsHistory(channelId, 30);

  if (!latestStats) {
    return null;
  }

  if (statsHistory.length < 2) {
    if (latestStats.subscriberGrowth30d === null || latestStats.subscriberGrowth30d === undefined) {
      return null;
    }

    const subscriberGrowth = latestStats.subscriberGrowth30d;
    const previousSubscribers = latestStats.subscriberCount - subscriberGrowth;
    const growthPercent =
      previousSubscribers > 0 ? (subscriberGrowth / previousSubscribers) * 100 : 0;

    return {
      currentSubscribers: latestStats.subscriberCount,
      subscriberGrowth,
      growthPercent: Math.round(growthPercent * 100) / 100,
      daysTracked: 30,
      avgDailyGrowth: Math.round(subscriberGrowth / 30),
    };
  }

  const oldestStats = statsHistory[statsHistory.length - 1];
  if (oldestStats.subscriberCount <= 0) {
    return null;
  }

  const subscriberGrowth = latestStats.subscriberCount - oldestStats.subscriberCount;
  const growthPercent = (subscriberGrowth / oldestStats.subscriberCount) * 100;

  return {
    currentSubscribers: latestStats.subscriberCount,
    subscriberGrowth,
    growthPercent: Math.round(growthPercent * 100) / 100,
    daysTracked: statsHistory.length,
    avgDailyGrowth: Math.round(subscriberGrowth / statsHistory.length),
  };
}
