import { Router } from 'express';
import { z } from 'zod';
import { telegramAuth, optionalAuth } from '../middleware/auth.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../middleware/error.js';
import { prisma } from '../lib/prisma.js';
import { bot } from '../services/telegram/bot.js';
import {
  getLatestChannelStats,
  getChannelStatsHistory,
  calculateChannelGrowth,
} from '../services/telegram/stats.js';
import { checkAndUpdateChannelStatus } from '../services/telegram/verification.js';
import { jobQueue, JobType } from '../services/jobs/index.js';
import {
  getMtprotoSessionStatus,
  hasAuthorizedMtprotoSession,
} from '../services/telegram/mtproto.js';
import {
  getDetailedMetricReason,
  resolveDetailedAnalyticsAccess,
} from '../services/telegram/analytics-access.js';
import {
  densifyGraphSeries,
  getGraphDisplayMeta,
} from '../services/telegram/graph-normalizer.js';
import { optionalCurrencySchema, requiredCurrencySchema } from '../lib/currency.js';

const router = Router();

function getSingleParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value || '';
}

function getMultiParam(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  const slugs = values
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);

  return Array.from(new Set(slugs));
}

type ChannelSortBy =
  | 'subscribers_desc'
  | 'subscribers_asc'
  | 'price_desc'
  | 'price_asc'
  | 'er_desc'
  | 'views_desc';

function parseChannelSortBy(raw: string | string[] | undefined): ChannelSortBy {
  const value = getSingleParam(raw).trim().toLowerCase();

  switch (value) {
    case 'subscribers':
    case 'subscribers_desc':
      return 'subscribers_desc';
    case 'subscribers_asc':
      return 'subscribers_asc';
    case 'price':
    case 'price_desc':
      return 'price_desc';
    case 'price_asc':
      return 'price_asc';
    case 'er':
    case 'er_desc':
      return 'er_desc';
    case 'views':
    case 'views_desc':
      return 'views_desc';
    default:
      return 'subscribers_desc';
  }
}

function toNumberOrZero(value: string | number | null | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function getChannelPriceMetric(channel: any): number {
  const prices = (channel.adFormats ?? [])
    .map((format: any) => toNumberOrZero(format.priceAmount))
    .filter((value: number) => value > 0);

  if (prices.length === 0) {
    return 0;
  }

  return Math.min(...prices);
}

function compareChannelsBySort(a: any, b: any, sortBy: ChannelSortBy): number {
  const subscribersA = toNumberOrZero(a.currentStats?.subscriberCount);
  const subscribersB = toNumberOrZero(b.currentStats?.subscriberCount);
  const priceA = getChannelPriceMetric(a);
  const priceB = getChannelPriceMetric(b);
  const erA = toNumberOrZero(a.currentStats?.engagementRate);
  const erB = toNumberOrZero(b.currentStats?.engagementRate);
  const viewsA = toNumberOrZero(a.currentStats?.avgViewsPerPost);
  const viewsB = toNumberOrZero(b.currentStats?.avgViewsPerPost);

  switch (sortBy) {
    case 'subscribers_asc':
      return subscribersA - subscribersB;
    case 'price_desc':
      return priceB - priceA;
    case 'price_asc':
      return priceA - priceB;
    case 'er_desc':
      return erB - erA;
    case 'views_desc':
      return viewsB - viewsA;
    case 'subscribers_desc':
    default:
      return subscribersB - subscribersA;
  }
}

async function getOwnedChannel(channelId: string, ownerId: string) {
  const channel = await prisma.channel.findUnique({
    where: { id: channelId },
    select: {
      id: true,
      ownerId: true,
      telegramChatId: true,
      username: true,
      title: true,
      deletedAt: true,
    },
  });

  if (!channel || channel.deletedAt) {
    throw new NotFoundError('Channel');
  }

  if (channel.ownerId !== ownerId) {
    throw new ForbiddenError('Not channel owner');
  }

  return channel;
}

/**
 * @openapi
 * /api/channels:
 *   get:
 *     tags: [Channels]
 *     summary: List all active channels
 *     description: Browse marketplace channels with filtering and pagination
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Items per page
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *         description: Filter by category slug
 *       - in: query
 *         name: language
 *         schema:
 *           type: string
 *         description: Filter by language
 *       - in: query
 *         name: minSubscribers
 *         schema:
 *           type: integer
 *         description: Minimum subscribers count
 *       - in: query
 *         name: maxSubscribers
 *         schema:
 *           type: integer
 *         description: Maximum subscribers count
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search in title, username, or description
 *       - in: query
 *         name: sortBy
 *         schema:
 *           type: string
 *           enum: [subscribers, price, recent]
 *           default: subscribers
 *         description: Sort order
 *     responses:
 *       200:
 *         description: List of channels
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 channels:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Channel'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     pages:
 *                       type: integer
 */
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const {
      page = '1',
      limit = '20',
      category,
      language,
      minSubscribers,
      maxSubscribers,
      minAvgViews,
      hasStories,
      minNotificationRate,
      minGrowth30d,
      search,
      sortBy = 'subscribers_desc',
    } = req.query;

    const categorySlugs = getMultiParam(category as string | string[] | undefined);
    const searchTerm = typeof search === 'string' ? search.trim() : '';
    const searchQuery = searchTerm.length >= 3 ? searchTerm : '';

    const parsedPage = Math.max(1, parseInt(page as string, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (parsedPage - 1) * parsedLimit;
    const normalizedSortBy = parseChannelSortBy(sortBy as string | string[] | undefined);

    // Build currentStats filter dynamically
    const currentStatsFilter: any = {};
    if (minSubscribers) {
      currentStatsFilter.subscriberCount = { gte: parseInt(minSubscribers as string) };
    }
    if (maxSubscribers) {
      currentStatsFilter.subscriberCount = {
        ...currentStatsFilter.subscriberCount,
        lte: parseInt(maxSubscribers as string),
      };
    }
    if (minAvgViews) {
      currentStatsFilter.avgViewsPerPost = { gte: parseInt(minAvgViews as string) };
    }
    if (hasStories === 'true') {
      currentStatsFilter.avgViewsPerStory = { not: null, gt: 0 };
    }
    if (minNotificationRate) {
      currentStatsFilter.notificationEnabledRate = { gte: parseFloat(minNotificationRate as string) };
    }
    if (minGrowth30d) {
      currentStatsFilter.subscriberGrowth30d = { gte: parseInt(minGrowth30d as string) };
    }

    const where = {
      status: 'ACTIVE' as const,
      deletedAt: null,
      ...(categorySlugs.length > 0 && {
        categories: { some: { slug: { in: categorySlugs } } },
      }),
      ...(language && { language: language as string }),
      ...(Object.keys(currentStatsFilter).length > 0 && { currentStats: currentStatsFilter }),
      ...(searchQuery && {
        OR: [
          { title: { contains: searchQuery, mode: 'insensitive' as const } },
          { username: { contains: searchQuery, mode: 'insensitive' as const } },
          { description: { contains: searchQuery, mode: 'insensitive' as const } },
        ],
      }),
    };

    const channels = await prisma.channel.findMany({
      where,
      include: {
        currentStats: true,
        categories: true,
        owner: {
          select: {
            id: true,
            username: true,
            firstName: true,
            photoUrl: true,
          },
        },
        adFormats: {
          where: { isActive: true },
          select: {
            id: true,
            type: true,
            name: true,
            priceAmount: true,
            priceCurrency: true,
          },
        },
        _count: {
          select: {
            deals: { where: { status: 'COMPLETED' } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    channels.sort((a: any, b: any) => compareChannelsBySort(a, b, normalizedSortBy));
    const total = channels.length;
    const pagedChannels = channels.slice(skip, skip + parsedLimit);

    res.json({
      channels: pagedChannels.map((ch: any) => ({
        id: ch.id,
        username: ch.username,
        title: ch.title,
        description: ch.description,
        language: ch.language,
        isVerified: ch.isVerified,
        updatedAt: ch.updatedAt,
        categories: ch.categories.map((c: any) => ({ slug: c.slug, name: c.name, icon: c.icon })),
        stats: ch.currentStats
          ? {
              subscribers: ch.currentStats.subscriberCount,
              avgViews: ch.currentStats.avgViewsPerPost,
              engagementRate: ch.currentStats.engagementRate,
            }
          : null,
        owner: ch.owner,
        formats: ch.adFormats,
        completedDeals: ch._count.deals,
      })),
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        pages: Math.max(Math.ceil(total / parsedLimit), 1),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels/my:
 *   get:
 *     tags: [Channels]
 *     summary: Get current user's channels
 *     description: Returns all channels owned by the authenticated user
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Channels retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 channels:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Channel'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/my', telegramAuth, async (req, res, next) => {
  try {
    const {
      page = '1',
      limit = '20',
      category,
      search,
      sortBy = 'subscribers_desc',
    } = req.query;

    const parsedPage = Math.max(1, parseInt(page as string, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (parsedPage - 1) * parsedLimit;
    const normalizedSortBy = parseChannelSortBy(sortBy as string | string[] | undefined);

    const categorySlugs = getMultiParam(category as string | string[] | undefined);
    const searchTerm = typeof search === 'string' ? search.trim() : '';
    const searchQuery = searchTerm.length >= 3 ? searchTerm : '';

    const where = {
      ownerId: req.user!.id,
      deletedAt: null,
      ...(categorySlugs.length > 0 && {
        categories: { some: { slug: { in: categorySlugs } } },
      }),
      ...(searchQuery && {
        OR: [
          { title: { contains: searchQuery, mode: 'insensitive' as const } },
          { username: { contains: searchQuery, mode: 'insensitive' as const } },
          { description: { contains: searchQuery, mode: 'insensitive' as const } },
        ],
      }),
    };

    const channels = await prisma.channel.findMany({
      where,
      include: {
        currentStats: true,
        categories: true,
        adFormats: {
          where: { isActive: true },
          select: {
            id: true,
            type: true,
            name: true,
            priceAmount: true,
            priceCurrency: true,
          },
        },
        _count: {
          select: {
            deals: { where: { status: 'COMPLETED' } },
            listings: { where: { status: 'ACTIVE' } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    channels.sort((a: any, b: any) => {
      const sorted = compareChannelsBySort(a, b, normalizedSortBy);
      if (sorted !== 0) {
        return sorted;
      }

      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    const total = channels.length;
    const pagedChannels = channels.slice(skip, skip + parsedLimit);

    res.json({
      channels: pagedChannels.map((ch: any) => ({
        id: ch.id,
        username: ch.username,
        title: ch.title,
        description: ch.description,
        language: ch.language,
        status: ch.status,
        isVerified: ch.isVerified,
        updatedAt: ch.updatedAt,
        categories: ch.categories.map((c: any) => ({ slug: c.slug, name: c.name, icon: c.icon })),
        stats: ch.currentStats
          ? {
              subscribers: ch.currentStats.subscriberCount,
              avgViews: ch.currentStats.avgViewsPerPost,
              engagementRate: ch.currentStats.engagementRate,
            }
          : null,
        formats: ch.adFormats,
        completedDeals: ch._count.deals,
        activeListings: ch._count.listings,
        createdAt: ch.createdAt,
      })),
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        pages: Math.ceil(total / parsedLimit),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels/categories:
 *   get:
 *     tags: [Channels]
 *     summary: Get all channel categories
 *     description: Returns list of all available channel categories
 *     responses:
 *       200:
 *         description: Categories retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 categories:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       slug:
 *                         type: string
 *                       name:
 *                         type: string
 *                       icon:
 *                         type: string
 */
router.get('/categories', async (req, res, next) => {
  try {
    const categories = await prisma.channelCategory.findMany({
      select: {
        id: true,
        slug: true,
        name: true,
        icon: true,
      },
      orderBy: { name: 'asc' },
    });

    res.json({ categories });
  } catch (error) {
    next(error);
  }
});

const analyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(90).optional(),
});

function getMissingMetricReason(source: string | undefined): string {
  if (source === 'BOT_API') {
    return 'Wider analytics are not provided yet.';
  }

  return 'This metric is not available yet.';
}

function getMtprotoEligibilityReason(rawData: unknown): string | null {
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    return null;
  }

  const value = rawData as Record<string, unknown>;
  if (value.detailedStatsStatus === 'NOT_AVAILABLE') {
    if (typeof value.detailedStatsReason === 'string' && value.detailedStatsReason) {
      return value.detailedStatsReason;
    }
    return 'Detailed MTProto analytics are unavailable for this channel yet.';
  }

  const canViewStatsRaw =
    typeof value.canViewStats === 'boolean'
      ? value.canViewStats
      : typeof value.can_view_stats === 'boolean'
        ? value.can_view_stats
        : null;

  if (canViewStatsRaw === false) {
    return 'Detailed MTProto analytics are unavailable for this channel yet (Telegram enables them only for eligible channels with enough audience).';
  }

  return null;
}

function hasLanguageStats(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.keys(value).length > 0;
}

/**
 * @openapi
 * /api/channels/{id}/analytics:
 *   get:
 *     tags: [Channels]
 *     summary: Get channel analytics with availability metadata
 *     description: Returns latest metrics, growth summary and history snapshots
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Channel ID
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           minimum: 7
 *           maximum: 90
 *           default: 30
 *         description: Number of days of analytics history to include
 *     responses:
 *       200:
 *         description: Analytics retrieved successfully
 *       404:
 *         description: Channel not found
 */
router.get('/:id/analytics', optionalAuth, async (req, res, next) => {
  try {
    const channelId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { days = 30 } = analyticsQuerySchema.parse(req.query);

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        id: true,
        ownerId: true,
        deletedAt: true,
      },
    });

    if (!channel || channel.deletedAt) {
      throw new NotFoundError('Channel');
    }

    const [latestStats, statsHistory, growth] = await Promise.all([
      getLatestChannelStats(channelId),
      getChannelStatsHistory(channelId, days),
      calculateChannelGrowth(channelId),
    ]);

    const source = latestStats?.source;
    const languageStats = hasLanguageStats(latestStats?.languageStats)
      ? (latestStats.languageStats as Record<string, number>)
      : null;
    const mtprotoEligibilityReason =
      source === 'MTPROTO' ? getMtprotoEligibilityReason(latestStats?.rawData) : null;
    const ownerHasMtprotoSession = await hasAuthorizedMtprotoSession(channel.ownerId);
    const detailedAccessPolicy = resolveDetailedAnalyticsAccess({
      ownerId: channel.ownerId,
      viewerUserId: req.user?.id || null,
      ownerHasMtprotoSession,
      source,
      mtprotoEligibilityReason,
    });
    const ownerMissingReason = mtprotoEligibilityReason || getMissingMetricReason(source);
    const detailedMetricReason = getDetailedMetricReason(detailedAccessPolicy, ownerMissingReason);
    const detailedMetricsAvailable = detailedAccessPolicy.detailedAvailable;

    // Helper to calculate trend
    const calculateTrend = (current?: number | null, previous?: number | null) => {
      if (!current || !previous) return null;
      const change = current - previous;
      const percent = (change / previous) * 100;
      return {
        change,
        percent: Math.round(percent * 100) / 100,
        direction: change > 0 ? 'up' : change < 0 ? 'down' : 'stable',
      };
    };

    // Check time range availability based on stats period
    const oldestStats = await prisma.channelStats.findFirst({
      where: { channelId },
      select: { fetchedAt: true },
      orderBy: { fetchedAt: 'asc' },
    });

    const daysSinceOldestStats = oldestStats
      ? Math.floor((Date.now() - new Date(oldestStats.fetchedAt).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    const timeRangeAvailability = {
      '7d': {
        available: daysSinceOldestStats >= 7 || (latestStats?.periodEnd && latestStats?.periodStart &&
          (new Date(latestStats.periodEnd).getTime() - new Date(latestStats.periodStart).getTime()) >= 7 * 24 * 60 * 60 * 1000),
        reason: daysSinceOldestStats < 7 ? 'Not enough historical data (minimum 7 days required)' : undefined,
      },
      '30d': {
        available: daysSinceOldestStats >= 30 || (latestStats?.periodEnd && latestStats?.periodStart &&
          (new Date(latestStats.periodEnd).getTime() - new Date(latestStats.periodStart).getTime()) >= 30 * 24 * 60 * 60 * 1000),
        reason: daysSinceOldestStats < 30 ? 'Not enough historical data (minimum 30 days required)' : undefined,
      },
      '90d': {
        available: daysSinceOldestStats >= 90 || (latestStats?.periodEnd && latestStats?.periodStart &&
          (new Date(latestStats.periodEnd).getTime() - new Date(latestStats.periodStart).getTime()) >= 90 * 24 * 60 * 60 * 1000),
        reason: daysSinceOldestStats < 90 ? 'Not enough historical data (minimum 90 days required)' : undefined,
      },
    };

    const availability = {
      subscriberCount: {
        available: latestStats?.subscriberCount !== null && latestStats?.subscriberCount !== undefined,
        reason:
          latestStats?.subscriberCount !== null && latestStats?.subscriberCount !== undefined
            ? undefined
            : 'Stats are not fetched yet.',
      },
      avgViewsPerPost: {
        available:
          detailedMetricsAvailable
          && latestStats?.avgViewsPerPost !== null
          && latestStats?.avgViewsPerPost !== undefined,
        reason:
          detailedMetricsAvailable
          && latestStats?.avgViewsPerPost !== null
          && latestStats?.avgViewsPerPost !== undefined
            ? undefined
            : detailedMetricReason,
      },
      avgReactionsPerPost: {
        available:
          detailedMetricsAvailable
          && latestStats?.avgReactionsPerPost !== null
          && latestStats?.avgReactionsPerPost !== undefined,
        reason:
          detailedMetricsAvailable
          && latestStats?.avgReactionsPerPost !== null
          && latestStats?.avgReactionsPerPost !== undefined
            ? undefined
            : detailedMetricReason,
      },
      storyMetrics: {
        available:
          detailedMetricsAvailable
          && latestStats?.avgViewsPerStory !== null
          && latestStats?.avgViewsPerStory !== undefined,
        reason:
          detailedMetricsAvailable
          && latestStats?.avgViewsPerStory !== null
          && latestStats?.avgViewsPerStory !== undefined
            ? undefined
            : detailedMetricReason,
      },
      engagementRate: {
        available:
          detailedMetricsAvailable
          && latestStats?.engagementRate !== null
          && latestStats?.engagementRate !== undefined,
        reason:
          detailedMetricsAvailable
          && latestStats?.engagementRate !== null
          && latestStats?.engagementRate !== undefined
            ? undefined
            : detailedMetricReason,
      },
      notificationRate: {
        available:
          detailedMetricsAvailable
          && latestStats?.notificationEnabledRate !== null
          && latestStats?.notificationEnabledRate !== undefined,
        reason:
          detailedMetricsAvailable
          && latestStats?.notificationEnabledRate !== null
          && latestStats?.notificationEnabledRate !== undefined
            ? undefined
            : detailedMetricReason,
      },
      premiumPercent: {
        available:
          detailedMetricsAvailable
          && latestStats?.premiumPercent !== null
          && latestStats?.premiumPercent !== undefined,
        reason:
          detailedMetricsAvailable
          && latestStats?.premiumPercent !== null
          && latestStats?.premiumPercent !== undefined
            ? undefined
            : detailedMetricReason,
      },
      languageStats: {
        available: detailedMetricsAvailable && !!languageStats,
        reason: detailedMetricsAvailable && languageStats ? undefined : detailedMetricReason,
      },
      subscriberGrowth30d: {
        available: !!growth,
        reason: growth ? undefined : 'Not enough historical snapshots yet.',
      },
    };

    res.json({
      analytics: {
        source: source || null,
        sourceLabel: 'Telegram',
        lastUpdatedAt: latestStats?.fetchedAt || null,
        period: {
          start: latestStats?.periodStart ?? null,
          end: latestStats?.periodEnd ?? null,
        },
        metrics: {
          // Subscriber metrics
          subscriberCount: latestStats?.subscriberCount ?? null,

          // Post metrics
          avgViewsPerPost: detailedMetricsAvailable ? (latestStats?.avgViewsPerPost ?? null) : null,
          avgSharesPerPost: detailedMetricsAvailable ? (latestStats?.avgSharesPerPost ?? null) : null,
          avgReactionsPerPost: detailedMetricsAvailable ? (latestStats?.avgReactionsPerPost ?? null) : null,

          // Story metrics
          avgViewsPerStory: detailedMetricsAvailable ? (latestStats?.avgViewsPerStory ?? null) : null,
          avgSharesPerStory: detailedMetricsAvailable ? (latestStats?.avgSharesPerStory ?? null) : null,
          avgReactionsPerStory: detailedMetricsAvailable ? (latestStats?.avgReactionsPerStory ?? null) : null,

          // Engagement
          engagementRate: detailedMetricsAvailable ? (latestStats?.engagementRate ?? null) : null,
          storyEngagementRate: detailedMetricsAvailable ? (latestStats?.storyEngagementRate ?? null) : null,

          // Notification quality
          notificationEnabledRate: detailedMetricsAvailable
            ? (latestStats?.notificationEnabledRate ?? null)
            : null,

          // Audience
          premiumPercent: detailedMetricsAvailable ? (latestStats?.premiumPercent ?? null) : null,
          languageStats: detailedMetricsAvailable ? languageStats : null,
        },
        trending: {
          subscribers: calculateTrend(latestStats?.subscriberCount, latestStats?.subscriberCountPrevious),
          viewsPerPost: detailedMetricsAvailable
            ? calculateTrend(latestStats?.avgViewsPerPost, latestStats?.avgViewsPerPostPrev)
            : null,
          sharesPerPost: detailedMetricsAvailable
            ? calculateTrend(latestStats?.avgSharesPerPost, latestStats?.avgSharesPerPostPrev)
            : null,
          reactionsPerPost: detailedMetricsAvailable
            ? calculateTrend(
              latestStats?.avgReactionsPerPost,
              latestStats?.avgReactionsPerPostPrev,
            )
            : null,
          viewsPerStory: detailedMetricsAvailable
            ? calculateTrend(latestStats?.avgViewsPerStory, latestStats?.avgViewsPerStoryPrev)
            : null,
        },
        growth: growth
          ? {
              subscriberGrowth: growth.subscriberGrowth,
              growthPercent: growth.growthPercent,
              avgDailyGrowth: growth.avgDailyGrowth,
              daysTracked: growth.daysTracked,
            }
          : null,
        history: statsHistory
          .slice()
          .reverse()
          .map((item) => ({
            fetchedAt: item.fetchedAt,
            subscriberCount: item.subscriberCount,
            avgViewsPerPost: detailedMetricsAvailable ? item.avgViewsPerPost : null,
            avgReactionsPerPost: detailedMetricsAvailable ? item.avgReactionsPerPost : null,
            engagementRate: detailedMetricsAvailable ? item.engagementRate : null,
            storyEngagementRate: detailedMetricsAvailable ? item.storyEngagementRate : null,
          })),
        detailedAccess: {
          available: detailedAccessPolicy.detailedAvailable,
          reason: detailedAccessPolicy.viewerReason,
        },
        availability,
        timeRangeAvailability,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels/{id}/graphs:
 *   get:
 *     tags: [Channels]
 *     summary: Get channel graph data with time range filtering
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: range
 *         schema:
 *           type: string
 *           enum: [7d, 30d, 90d]
 *         description: "Time range for graph data (default: 30d)"
 *       - in: query
 *         name: types
 *         schema:
 *           type: string
 *         description: Comma-separated list of graph types (e.g., "GROWTH,FOLLOWERS")
 */
router.get('/:id/graphs', optionalAuth, async (req, res, next) => {
  try {
    const channelId = getSingleParam(req.params.id);
    const range = (req.query.range as string) || '30d';
    const requestedTypes = req.query.types
      ? (req.query.types as string).split(',')
      : undefined;

    // Validate range
    if (!['7d', '30d', '90d'].includes(range)) {
      throw new ValidationError('Invalid range. Must be one of: 7d, 30d, 90d');
    }

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        id: true,
        ownerId: true,
        deletedAt: true,
        currentStatsId: true,
        currentStats: {
          select: {
            source: true,
            rawData: true,
          },
        },
      },
    });

    if (!channel || channel.deletedAt) {
      throw new NotFoundError('Channel not found');
    }

    const source = channel.currentStats?.source;
    const mtprotoEligibilityReason =
      source === 'MTPROTO' ? getMtprotoEligibilityReason(channel.currentStats?.rawData) : null;
    const ownerHasMtprotoSession = await hasAuthorizedMtprotoSession(channel.ownerId);
    const detailedAccessPolicy = resolveDetailedAnalyticsAccess({
      ownerId: channel.ownerId,
      viewerUserId: req.user?.id || null,
      ownerHasMtprotoSession,
      source,
      mtprotoEligibilityReason,
    });

    const daysToInclude = Number.parseInt(range, 10);
    const windowEnd = new Date();
    const windowEndUtc = new Date(Date.UTC(
      windowEnd.getUTCFullYear(),
      windowEnd.getUTCMonth(),
      windowEnd.getUTCDate(),
    ));
    const windowStartUtc = new Date(
      windowEndUtc.getTime() - ((daysToInclude - 1) * 24 * 60 * 60 * 1000),
    );

    if (!detailedAccessPolicy.detailedAvailable) {
      return res.json({
        window: {
          start: windowStartUtc,
          end: windowEndUtc,
          days: daysToInclude,
        },
        graphs: [],
      });
    }

    if (!channel.currentStatsId) {
      return res.json({
        window: {
          start: windowStartUtc,
          end: windowEndUtc,
          days: daysToInclude,
        },
        graphs: [],
      });
    }

    // Fetch graphs for the current stats
    const where: any = {
      statsId: channel.currentStatsId,
    };

    if (requestedTypes && requestedTypes.length > 0) {
      where.graphType = { in: requestedTypes };
    }

    const graphs = await prisma.channelStatsGraph.findMany({
      where,
      select: {
        id: true,
        graphType: true,
        periodStart: true,
        periodEnd: true,
        isAsync: true,
        loadedAt: true,
        timestamps: true,
        series: true,
        title: true,
        xAxisFormat: true,
        yAxisFormat: true,
        rawGraph: true,
      },
      orderBy: { graphType: 'asc' },
    });

    // Normalize graph data to a complete daily window.
    const normalizedGraphs = graphs.map((graph) => {
      const dense = densifyGraphSeries({
        graphType: graph.graphType,
        timestamps: graph.timestamps.map((ts) => (
          typeof ts === 'bigint' ? Number(ts) : Number(ts)
        )),
        series: Array.isArray(graph.series)
          ? (graph.series as Array<Record<string, unknown>>).map((seriesItem) => ({
              key: typeof seriesItem.key === 'string' ? seriesItem.key : 'series',
              label: typeof seriesItem.label === 'string' ? seriesItem.label : 'Series',
              values: Array.isArray(seriesItem.values)
                ? seriesItem.values.map((value) => (
                    typeof value === 'number'
                      ? value
                      : typeof value === 'string'
                        ? Number(value)
                        : null
                  ))
                : [],
            }))
          : [],
        periodEnd: windowEndUtc,
        days: daysToInclude,
      });
      const displayMeta = getGraphDisplayMeta(graph.graphType);

      return {
        id: graph.id,
        type: graph.graphType,
        periodStart: dense.periodStart,
        periodEnd: dense.periodEnd,
        isAsync: graph.isAsync,
        loadedAt: graph.loadedAt,
        timestamps: dense.timestamps,
        series: dense.series,
        title: graph.title || displayMeta.title,
        xAxisFormat: displayMeta.xAxisFormat,
        yAxisFormat: displayMeta.yAxisFormat,
        xAxisLabel: displayMeta.xAxisLabel,
        yAxisLabel: displayMeta.yAxisLabel,
        yUnit: displayMeta.yUnit,
        chartKind: displayMeta.chartKind,
        rawGraph: graph.rawGraph,
      };
    });

    res.json({
      window: {
        start: windowStartUtc,
        end: windowEndUtc,
        days: daysToInclude,
      },
      graphs: normalizedGraphs,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels/{id}/stats/refresh:
 *   post:
 *     tags: [Channels]
 *     summary: Refresh channel statistics on demand (owner only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Channel ID
 *     responses:
 *       202:
 *         description: Channel stats refresh queued
 *       403:
 *         description: Not channel owner
 *       404:
 *         description: Channel not found
 */
router.post('/:id/stats/refresh', telegramAuth, async (req, res, next) => {
  try {
    const channelId = getSingleParam(req.params.id);
    const channel = await getOwnedChannel(channelId, req.user!.id);
    if (!channel.username) {
      throw new ValidationError('Channel username is missing');
    }

    const job = await jobQueue.addJob(
      JobType.REFRESH_CHANNEL_STATS,
      { channelId: channel.id },
      {
        jobId: `manual_refresh:${channel.id}:${Date.now()}`,
      },
    );

    res.status(202).json({
      message: 'Channel stats refresh queued',
      jobId: job.id,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels/{id}/profile/refresh:
 *   post:
 *     tags: [Channels]
 *     summary: Refresh channel profile metadata from Telegram (owner only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Channel ID
 *     responses:
 *       200:
 *         description: Channel profile refreshed
 *       403:
 *         description: Not channel owner
 *       404:
 *         description: Channel not found
 */
router.post('/:id/profile/refresh', telegramAuth, async (req, res, next) => {
  try {
    const channelId = getSingleParam(req.params.id);
    const channel = await getOwnedChannel(channelId, req.user!.id);

    let chat;
    try {
      chat = await bot.api.getChat(channel.telegramChatId);
    } catch (error: any) {
      if (error?.error_code === 400) {
        throw new ValidationError('Channel not found or bot is not added to the channel');
      }

      throw new ValidationError('Failed to fetch latest channel profile from Telegram');
    }

    if (chat.type !== 'channel') {
      throw new ValidationError('This is not a channel');
    }

    const titleFromTelegram = 'title' in chat && typeof chat.title === 'string'
      ? chat.title.trim()
      : '';
    const usernameFromTelegram = 'username' in chat && typeof chat.username === 'string'
      ? chat.username.trim()
      : '';
    const descriptionFromTelegram = 'description' in chat && typeof chat.description === 'string'
      ? chat.description.trim()
      : '';

    const updatedChannel = await prisma.channel.update({
      where: { id: channel.id },
      data: {
        title: titleFromTelegram || channel.title,
        username: usernameFromTelegram || null,
        description: descriptionFromTelegram || null,
      },
      select: {
        id: true,
        username: true,
        title: true,
        description: true,
        updatedAt: true,
      },
    });

    res.json({
      message: 'Channel profile refreshed',
      channel: updatedChannel,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/mtproto/status', telegramAuth, async (req, res, next) => {
  try {
    const channelId = getSingleParam(req.params.id);
    await getOwnedChannel(channelId, req.user!.id);

    const status = await getMtprotoSessionStatus(channelId, req.user!.id);
    res.json({ mtproto: status });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels/{id}/activate:
 *   post:
 *     tags: [Channels]
 *     summary: Activate pending channel after admin re-verification (owner only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Channel ID
 *     responses:
 *       200:
 *         description: Channel activated successfully
 *       403:
 *         description: Not channel owner
 *       404:
 *         description: Channel not found
 */
router.post('/:id/activate', telegramAuth, async (req, res, next) => {
  try {
    const channelId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        id: true,
        ownerId: true,
        username: true,
        deletedAt: true,
      },
    });

    if (!channel || channel.deletedAt) {
      throw new NotFoundError('Channel');
    }

    if (channel.ownerId !== req.user!.id) {
      throw new ForbiddenError('Not channel owner');
    }

    if (!channel.username) {
      throw new ValidationError('Channel username is missing');
    }

    await checkAndUpdateChannelStatus(channel.id);

    const updated = await prisma.channel.findUnique({
      where: { id: channel.id },
      include: {
        currentStats: true,
        categories: true,
        adFormats: true,
      },
    });

    if (!updated?.botIsAdmin) {
      throw new ValidationError(
        'Bot is not an admin with post permission in this channel. Please add bot admin rights and try again.',
      );
    }

    res.json({
      message: 'Channel activated',
      channel: updated,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels/verify-and-add:
 *   post:
 *     tags: [Channels]
 *     summary: Verify and add channel by username
 *     description: Verifies user is admin and bot has access, then adds channel
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - channelUsername
 *             properties:
 *               channelUsername:
 *                 type: string
 *                 description: Channel username (with or without @)
 *               categoryIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of category IDs to assign to channel
 *     responses:
 *       201:
 *         description: Channel successfully verified and added
 *       400:
 *         description: Validation error
 *       403:
 *         description: User is not admin of the channel
 */
const verifyAndAddChannelSchema = z.object({
  channelUsername: z.string().regex(/^@?[a-zA-Z0-9_]{5,32}$/, 'Invalid channel username'),
  categoryIds: z.array(z.string()).optional(),
});

router.post('/verify-and-add', telegramAuth, async (req, res, next) => {
  try {
    const { channelUsername, categoryIds } = verifyAndAddChannelSchema.parse(req.body);
    const username = channelUsername.startsWith('@') ? channelUsername : `@${channelUsername}`;

    // Step 1: Get channel info via bot
    let channelInfo;
    try {
      const chat = await bot.api.getChat(username);
      if (chat.type !== 'channel') {
        throw new ValidationError('This is not a channel');
      }
      
      const memberCount = await bot.api.getChatMemberCount(chat.id);
      
      channelInfo = {
        id: chat.id,
        title: 'title' in chat ? chat.title : '',
        username: 'username' in chat ? chat.username : undefined,
        description: 'description' in chat ? chat.description : undefined,
        memberCount,
      };
    } catch (error: any) {
      if (error.error_code === 400) {
        throw new ValidationError('Channel not found or bot is not added to the channel');
      }
      throw new ValidationError('Failed to access channel. Make sure the bot is added as admin.');
    }

    // Step 2: Verify user is admin of the channel
    let isUserAdmin = false;
    try {
      const member = await bot.api.getChatMember(channelInfo.id.toString(), Number(req.user!.telegramId));
      isUserAdmin = ['creator', 'administrator'].includes(member.status);
    } catch (error) {
      throw new ValidationError('Could not verify your admin status in this channel');
    }

    if (!isUserAdmin) {
      throw new ForbiddenError('You must be an admin of this channel to add it');
    }

    // Step 3: Verify bot is admin with post permission
    let botCanPost = false;
    try {
      const botInfo = await bot.api.getMe();
      const botMember = await bot.api.getChatMember(channelInfo.id.toString(), botInfo.id);
      botCanPost = botMember.status === 'administrator' && 
                   ('can_post_messages' in botMember && botMember.can_post_messages === true);
    } catch (error) {
      throw new ValidationError('Bot must be added as admin with "Post Messages" permission');
    }

    if (!botCanPost) {
      throw new ValidationError('Bot must have "Post Messages" permission in the channel');
    }

    // Step 4: Check if already registered
    const existing = await prisma.channel.findUnique({
      where: { telegramChatId: channelInfo.id.toString() },
    });

    if (existing) {
      if (existing.ownerId === req.user!.id) {
        return res.json({ 
          channel: existing,
          message: 'Channel already registered to you',
        });
      } else {
        throw new ValidationError('Channel is already registered by another user');
      }
    }

    // Step 5: Create channel
    const channel = await prisma.channel.create({
      data: {
        telegramChatId: channelInfo.id.toString(),
        username: channelInfo.username,
        title: channelInfo.title,
        description: channelInfo.description || '',
        language: 'en',
        ownerId: req.user!.id,
        status: 'ACTIVE',
        botIsAdmin: true,
        botAddedAt: new Date(),
        botPermissions: {
          canPost: true,
          canEdit: false,
          canDelete: false,
          canManage: false,
        },
        isVerified: true,
        verifiedAt: new Date(),
        ...(categoryIds && categoryIds.length > 0 && {
          categories: {
            connect: categoryIds.map((id) => ({ id })),
          },
        }),
      },
      include: {
        categories: true,
      },
    });

    // Create initial stats and link as currentStats
    const initialStats = await prisma.channelStats.create({
      data: {
        channelId: channel.id,
        subscriberCount: channelInfo.memberCount,
        source: 'BOT_API',
      },
    });

    // Update channel to link the stats as current
    await prisma.channel.update({
      where: { id: channel.id },
      data: { currentStatsId: initialStats.id },
    });

    // Mark user as channel owner
    if (!req.user!.isChannelOwner) {
      await prisma.user.update({
        where: { id: req.user!.id },
        data: {
          isChannelOwner: true,
          ...(req.user!.onboardingCompletedAt ? {} : { onboardingCompletedAt: new Date() }),
        },
      });
    }

    res.status(201).json({
      channel,
      message: 'Channel successfully verified and added!',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels:
 *   post:
 *     tags: [Channels]
 *     summary: Register a new channel
 *     description: Registers a new Telegram channel to the marketplace
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - telegramChatId
 *               - title
 *             properties:
 *               telegramChatId:
 *                 type: number
 *                 description: Telegram chat ID of the channel
 *               username:
 *                 type: string
 *                 description: Channel username
 *               title:
 *                 type: string
 *                 description: Channel title
 *               language:
 *                 type: string
 *                 default: en
 *                 description: Channel language
 *               categoryIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Category IDs
 *     responses:
 *       201:
 *         description: Channel created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 channel:
 *                   $ref: '#/components/schemas/Channel'
 *       400:
 *         description: Channel already registered
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
const createChannelSchema = z.object({
  telegramChatId: z.number(),
  username: z.string().optional(),
  title: z.string().min(1).max(255),
  language: z.string().default('en'),
  categoryIds: z.array(z.string()).optional(),
});

router.post('/', telegramAuth, async (req, res, next) => {
  try {
    const data = createChannelSchema.parse(req.body);
    let telegramDescription: string | undefined;

    try {
      const chat = await bot.api.getChat(data.telegramChatId.toString());
      if (chat.type === 'channel' && 'description' in chat) {
        telegramDescription = chat.description;
      }
    } catch (error) {
      console.warn(`Unable to fetch Telegram description for chat ${data.telegramChatId}:`, error);
    }

    // Check if channel already registered
    const existing = await prisma.channel.findUnique({
      where: { telegramChatId: data.telegramChatId.toString() },
    });

    if (existing) {
      throw new ValidationError('Channel already registered');
    }

    // Create channel
    const channel = await prisma.channel.create({
      data: {
        telegramChatId: data.telegramChatId.toString(),
        username: data.username,
        title: data.title,
        description: telegramDescription,
        language: data.language,
        ownerId: req.user!.id,
        status: 'PENDING',
        ...(data.categoryIds && {
          categories: {
            connect: data.categoryIds.map((id) => ({ id })),
          },
        }),
      },
      include: {
        categories: true,
      },
    });

    // Mark user as channel owner
    if (!req.user!.isChannelOwner) {
      await prisma.user.update({
        where: { id: req.user!.id },
        data: {
          isChannelOwner: true,
          ...(req.user!.onboardingCompletedAt ? {} : { onboardingCompletedAt: new Date() }),
        },
      });
    }

    res.status(201).json({ channel });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels/{id}:
 *   get:
 *     tags: [Channels]
 *     summary: Get channel details
 *     description: Returns detailed information about a specific channel
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Channel ID
 *     responses:
 *       200:
 *         description: Channel details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 channel:
 *                   $ref: '#/components/schemas/Channel'
 *       404:
 *         description: Channel not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const channelId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      include: {
        currentStats: true,
        categories: true,
        owner: {
          select: {
            id: true,
            username: true,
            firstName: true,
            photoUrl: true,
          },
        },
        adFormats: {
          where: { isActive: true },
        },
        listings: {
          where: { status: 'ACTIVE' },
          take: 10,
        },
        _count: {
          select: {
            deals: { where: { status: 'COMPLETED' } },
          },
        },
      },
    });

    if (!channel || channel.deletedAt) {
      throw new NotFoundError('Channel');
    }

    // Calculate time range availability for statistics
    const oldestStats = await prisma.channelStats.findFirst({
      where: { channelId },
      select: { fetchedAt: true, periodStart: true, periodEnd: true },
      orderBy: { fetchedAt: 'asc' },
    });

    const daysSinceOldestStats = oldestStats
      ? Math.floor((Date.now() - new Date(oldestStats.fetchedAt).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    const timeRangeAvailability = {
      '7d': {
        available: daysSinceOldestStats >= 7 || (oldestStats?.periodEnd && oldestStats?.periodStart &&
          (new Date(oldestStats.periodEnd).getTime() - new Date(oldestStats.periodStart).getTime()) >= 7 * 24 * 60 * 60 * 1000),
        reason: daysSinceOldestStats < 7 ? 'Not enough historical data (minimum 7 days required)' : undefined,
      },
      '30d': {
        available: daysSinceOldestStats >= 30 || (oldestStats?.periodEnd && oldestStats?.periodStart &&
          (new Date(oldestStats.periodEnd).getTime() - new Date(oldestStats.periodStart).getTime()) >= 30 * 24 * 60 * 60 * 1000),
        reason: daysSinceOldestStats < 30 ? 'Not enough historical data (minimum 30 days required)' : undefined,
      },
      '90d': {
        available: daysSinceOldestStats >= 90 || (oldestStats?.periodEnd && oldestStats?.periodStart &&
          (new Date(oldestStats.periodEnd).getTime() - new Date(oldestStats.periodStart).getTime()) >= 90 * 24 * 60 * 60 * 1000),
        reason: daysSinceOldestStats < 90 ? 'Not enough historical data (minimum 90 days required)' : undefined,
      },
    };

    res.json({ channel, timeRangeAvailability });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels/{id}:
 *   put:
 *     tags: [Channels]
 *     summary: Update channel
 *     description: Updates channel information (owner only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Channel ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               language:
 *                 type: string
 *               categoryIds:
 *                 type: array
 *                 items:
 *                   type: string
 *               status:
 *                 type: string
 *                 enum: [ACTIVE, PAUSED]
 *     responses:
 *       200:
 *         description: Channel updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 channel:
 *                   $ref: '#/components/schemas/Channel'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Not channel owner
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Channel not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/:id', telegramAuth, async (req, res, next) => {
  try {
    const channelId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
    });

    if (!channel) {
      throw new NotFoundError('Channel');
    }

    if (channel.ownerId !== req.user!.id) {
      throw new ForbiddenError('Not channel owner');
    }

    const { title, language, categoryIds, status } = req.body;

    const updated = await prisma.channel.update({
      where: { id: channelId },
      data: {
        ...(title && { title }),
        ...(language && { language }),
        ...(status && ['ACTIVE', 'PAUSED'].includes(status) && { status }),
        ...(categoryIds && {
          categories: {
            set: categoryIds.map((id: string) => ({ id })),
          },
        }),
      },
      include: {
        categories: true,
      },
    });

    res.json({ channel: updated });
  } catch (error) {
    next(error);
  }
});

const TERMINAL_DEAL_STATUSES = ['COMPLETED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'RESOLVED'] as const;

router.delete('/:id', telegramAuth, async (req, res, next) => {
  try {
    const channelId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: {
        id: true,
        ownerId: true,
        deletedAt: true,
      },
    });

    if (!channel || channel.deletedAt) {
      throw new NotFoundError('Channel');
    }

    if (channel.ownerId !== req.user!.id) {
      throw new ForbiddenError('Not channel owner');
    }

    const activeDealsCount = await prisma.deal.count({
      where: {
        channelId,
        status: {
          notIn: [...TERMINAL_DEAL_STATUSES],
        },
      },
    });

    if (activeDealsCount > 0) {
      throw new ValidationError('Cannot remove channel while active deals exist');
    }

    await prisma.$transaction([
      prisma.channel.update({
        where: { id: channelId },
        data: {
          status: 'REMOVED',
          deletedAt: new Date(),
        },
      }),
      prisma.listing.updateMany({
        where: {
          channelId,
          status: {
            notIn: ['SOLD_OUT', 'EXPIRED', 'REMOVED'],
          },
        },
        data: {
          status: 'REMOVED',
        },
      }),
    ]);

    const hasRemainingChannels = await prisma.channel.count({
      where: {
        ownerId: req.user!.id,
        deletedAt: null,
      },
    });

    if (!hasRemainingChannels && req.user!.isChannelOwner) {
      await prisma.user.update({
        where: { id: req.user!.id },
        data: { isChannelOwner: false },
      });
    }

    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels/{id}/formats:
 *   post:
 *     tags: [Channels]
 *     summary: Create ad format for channel
 *     description: Creates a new advertising format for the channel (owner only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Channel ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - type
 *               - name
 *               - priceAmount
 *               - priceCurrency
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [POST, STORY, REPOST, PINNED, OTHER]
 *               customType:
 *                 type: string
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               priceAmount:
 *                 type: string
 *               priceCurrency:
 *                 type: string
 *                 description: Format currency (must be one of configured supported currencies)
 *               durationHours:
 *                 type: integer
 *                 default: 24
 *               maxLength:
 *                 type: integer
 *               mediaAllowed:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [TEXT, IMAGE, VIDEO, GIF, DOCUMENT, AUDIO, POLL]
 *     responses:
 *       201:
 *         description: Format created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 format:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Not channel owner
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Channel not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
const createFormatSchema = z.object({
  type: z.enum(['POST', 'STORY', 'REPOST', 'PINNED', 'OTHER']),
  customType: z.string().optional(),
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  priceAmount: z
    .string()
    .trim()
    .min(1)
    .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, {
      message: 'Price must be greater than 0',
    }),
  priceCurrency: requiredCurrencySchema,
  durationHours: z.number().int().min(0).default(24),
  maxLength: z.number().int().positive().optional(),
  mediaAllowed: z.array(z.enum(['TEXT', 'IMAGE', 'VIDEO', 'GIF', 'DOCUMENT', 'AUDIO', 'POLL'])).optional(),
});

router.post('/:id/formats', telegramAuth, async (req, res, next) => {
  try {
    const channelId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
    });

    if (!channel) {
      throw new NotFoundError('Channel');
    }

    if (channel.ownerId !== req.user!.id) {
      throw new ForbiddenError('Not channel owner');
    }

    const data = createFormatSchema.parse(req.body);

    const format = await prisma.adFormat.create({
      data: {
        channelId: channel.id,
        ...data,
      },
    });

    res.status(201).json({ format });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels/{id}/formats:
 *   get:
 *     tags: [Channels]
 *     summary: Get channel's ad formats
 *     description: Returns all active advertising formats for a channel
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Channel ID
 *     responses:
 *       200:
 *         description: Formats retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 formats:
 *                   type: array
 *                   items:
 *                     type: object
 */
router.get('/:id/formats', async (req, res, next) => {
  try {
    const channelId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const formats = await prisma.adFormat.findMany({
      where: {
        channelId,
        isActive: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ formats });
  } catch (error) {
    next(error);
  }
});

const updateFormatSchema = z
  .object({
    type: z.enum(['POST', 'STORY', 'REPOST', 'PINNED', 'OTHER']).optional(),
    customType: z.string().optional(),
    name: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
    priceAmount: z
      .string()
      .trim()
      .min(1)
      .refine((value) => Number.isFinite(Number(value)) && Number(value) > 0, {
        message: 'Price must be greater than 0',
      })
      .optional(),
    priceCurrency: optionalCurrencySchema,
    durationHours: z.number().int().min(0).optional(),
    maxLength: z.number().int().positive().optional(),
    mediaAllowed: z
      .array(z.enum(['TEXT', 'IMAGE', 'VIDEO', 'GIF', 'DOCUMENT', 'AUDIO', 'POLL']))
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No update fields provided',
  });

/**
 * @openapi
 * /api/channels/{id}/formats/{formatId}:
 *   put:
 *     tags: [Channels]
 *     summary: Update an ad format
 *     description: Updates ad format fields for a channel (owner only)
 *     security:
 *       - TelegramAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Channel ID
 *       - in: path
 *         name: formatId
 *         required: true
 *         schema:
 *           type: string
 *         description: Ad format ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [POST, STORY, REPOST, PINNED, OTHER]
 *               customType:
 *                 type: string
 *               name:
 *                 type: string
 *               description:
 *                 type: string
 *               priceAmount:
 *                 type: string
 *               priceCurrency:
 *                 type: string
 *               durationHours:
 *                 type: integer
 *               maxLength:
 *                 type: integer
 *               mediaAllowed:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [TEXT, IMAGE, VIDEO, GIF, DOCUMENT, AUDIO, POLL]
 *     responses:
 *       200:
 *         description: Ad format updated successfully
 *       403:
 *         description: Not channel owner
 *       404:
 *         description: Ad format not found
 */
router.put('/:id/formats/:formatId', telegramAuth, async (req, res, next) => {
  try {
    const channelId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const formatId = Array.isArray(req.params.formatId) ? req.params.formatId[0] : req.params.formatId;

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
    });

    if (!channel) {
      throw new NotFoundError('Channel');
    }

    if (channel.ownerId !== req.user!.id) {
      throw new ForbiddenError('Not channel owner');
    }

    const format = await prisma.adFormat.findFirst({
      where: { id: formatId, channelId, isActive: true },
    });

    if (!format) {
      throw new NotFoundError('Ad format');
    }

    const data = updateFormatSchema.parse(req.body);

    const updated = await prisma.adFormat.update({
      where: { id: formatId },
      data,
    });

    res.json({ format: updated });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/channels/{id}/formats/{formatId}:
 *   delete:
 *     tags: [Channels]
 *     summary: Delete an ad format
 *     description: Permanently deletes an ad format (hard delete)
 *     security:
 *       - TelegramAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Channel ID
 *       - in: path
 *         name: formatId
 *         required: true
 *         schema:
 *           type: string
 *         description: Ad Format ID
 *     responses:
 *       200:
 *         description: Format deleted successfully
 *       403:
 *         description: Not channel owner
 *       404:
 *         description: Format not found
 */
router.delete('/:id/formats/:formatId', telegramAuth, async (req, res, next) => {
  try {
    const channelId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const formatId = Array.isArray(req.params.formatId) ? req.params.formatId[0] : req.params.formatId;

    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
    });

    if (!channel) {
      throw new NotFoundError('Channel');
    }

    if (channel.ownerId !== req.user!.id) {
      throw new ForbiddenError('Not channel owner');
    }

    const format = await prisma.adFormat.findFirst({
      where: { id: formatId, channelId },
    });

    if (!format) {
      throw new NotFoundError('Ad format');
    }

    const dealsCount = await prisma.deal.count({
      where: {
        adFormatId: formatId,
      },
    });

    if (dealsCount > 0) {
      throw new ValidationError(
        'Cannot delete this ad format because it is used by existing deals.',
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.listing.deleteMany({
        where: { adFormatId: formatId },
      });

      await tx.adFormat.delete({
        where: { id: formatId },
      });
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
