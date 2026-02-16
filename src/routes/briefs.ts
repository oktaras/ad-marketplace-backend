import { Router } from 'express';
import { z } from 'zod';
import { telegramAuth, optionalAuth } from '../middleware/auth.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../middleware/error.js';
import { prisma } from '../lib/prisma.js';
import { appEvents, AppEvent } from '../services/events.js';
import { isSupportedCurrency, normalizeCurrencyInput, requiredCurrencySchema } from '../lib/currency.js';

const router = Router();
const LEGACY_APPLICATION_META_PREFIX = '__APP_META__::';

function parseLegacyApplicationPitch(value: string | null): {
  pitch: string | null;
  selectedAdFormatIds: string[];
  proposedFormatPrices: Record<string, string>;
} {
  if (!value) {
    return { pitch: null, selectedAdFormatIds: [], proposedFormatPrices: {} };
  }

  if (!value.startsWith(LEGACY_APPLICATION_META_PREFIX)) {
    return { pitch: value, selectedAdFormatIds: [], proposedFormatPrices: {} };
  }

  const raw = value.slice(LEGACY_APPLICATION_META_PREFIX.length);
  try {
    const parsed = JSON.parse(raw) as {
      pitch?: unknown;
      selectedAdFormatIds?: unknown;
      proposedFormatPrices?: unknown;
    };

    const proposedFormatPrices = parsed.proposedFormatPrices
      && typeof parsed.proposedFormatPrices === 'object'
      && !Array.isArray(parsed.proposedFormatPrices)
      ? Object.entries(parsed.proposedFormatPrices as Record<string, unknown>)
        .reduce<Record<string, string>>((acc, [adFormatId, amount]) => {
          if (typeof adFormatId !== 'string' || typeof amount !== 'string') {
            return acc;
          }

          const normalizedAmount = amount.trim();
          if (!normalizedAmount) {
            return acc;
          }

          acc[adFormatId] = normalizedAmount;
          return acc;
        }, {})
      : {};

    return {
      pitch: typeof parsed.pitch === 'string' ? parsed.pitch : null,
      selectedAdFormatIds: Array.isArray(parsed.selectedAdFormatIds)
        ? parsed.selectedAdFormatIds.filter((id): id is string => typeof id === 'string')
        : [],
      proposedFormatPrices,
    };
  } catch {
    return { pitch: value, selectedAdFormatIds: [], proposedFormatPrices: {} };
  }
}

function serializeApplicationPitch(input: {
  pitch: string | undefined;
  selectedAdFormatIds: string[];
  proposedFormatPrices: Record<string, string>;
}): string | null {
  const normalizedPitch = typeof input.pitch === 'string'
    ? input.pitch.trim()
    : '';
  const hasMeta = input.selectedAdFormatIds.length > 0
    || Object.keys(input.proposedFormatPrices).length > 0;

  if (!hasMeta) {
    return normalizedPitch || null;
  }

  return `${LEGACY_APPLICATION_META_PREFIX}${JSON.stringify({
    pitch: normalizedPitch || null,
    selectedAdFormatIds: input.selectedAdFormatIds,
    proposedFormatPrices: input.proposedFormatPrices,
  })}`;
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

const BRIEF_OPEN_STATUSES = ['ACTIVE'] as const;
const BRIEF_CLOSED_STATUSES = ['PAUSED', 'FULFILLED', 'CANCELLED', 'EXPIRED'] as const;
const BRIEF_ALL_STATUSES = ['DRAFT', ...BRIEF_OPEN_STATUSES, ...BRIEF_CLOSED_STATUSES] as const;

type BriefSortBy = 'budget_desc' | 'budget_asc' | 'deadline_asc' | 'subs_desc' | 'created_desc';

function parseBriefSortBy(raw: string | string[] | undefined): BriefSortBy {
  const value = (Array.isArray(raw) ? raw[0] : raw || '').trim().toLowerCase();
  switch (value) {
    case 'budget_desc':
      return 'budget_desc';
    case 'budget_asc':
      return 'budget_asc';
    case 'deadline_asc':
      return 'deadline_asc';
    case 'subs_desc':
      return 'subs_desc';
    default:
      return 'created_desc';
  }
}

function parseNumeric(value: string | number | null | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function getBriefBudget(brief: any): number {
  return parseNumeric(brief.totalBudget) || parseNumeric(brief.budgetMax) || parseNumeric(brief.budgetMin);
}

function getBriefSubscribersMetric(brief: any): number {
  return parseNumeric(brief.minSubscribers) || parseNumeric(brief.maxSubscribers);
}

function normalizeBriefStatusFilter(raw: string | string[] | undefined): { mode: 'all' | 'group' | 'exact'; values: string[] } {
  const value = (Array.isArray(raw) ? raw[0] : raw || 'all').trim();
  if (!value || value.toLowerCase() === 'all') {
    return { mode: 'all', values: [] };
  }

  const normalized = value
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);

  if (normalized.length === 0) {
    return { mode: 'all', values: [] };
  }

  if (normalized.length === 1 && normalized[0] === 'OPEN') {
    return { mode: 'group', values: [...BRIEF_OPEN_STATUSES] };
  }

  if (normalized.length === 1 && normalized[0] === 'CLOSED') {
    return { mode: 'group', values: [...BRIEF_CLOSED_STATUSES] };
  }

  const exactValues = normalized.filter((entry) => BRIEF_ALL_STATUSES.includes(entry as any));
  if (exactValues.length === 0) {
    return { mode: 'all', values: [] };
  }

  return { mode: 'exact', values: exactValues };
}

function compareBriefs(a: any, b: any, sortBy: BriefSortBy): number {
  const budgetA = getBriefBudget(a);
  const budgetB = getBriefBudget(b);
  const subsA = getBriefSubscribersMetric(a);
  const subsB = getBriefSubscribersMetric(b);
  const deadlineA = a.desiredEndDate ? new Date(a.desiredEndDate).getTime() : Number.MAX_SAFE_INTEGER;
  const deadlineB = b.desiredEndDate ? new Date(b.desiredEndDate).getTime() : Number.MAX_SAFE_INTEGER;
  const createdA = new Date(a.createdAt).getTime();
  const createdB = new Date(b.createdAt).getTime();

  switch (sortBy) {
    case 'budget_desc':
      return budgetB - budgetA;
    case 'budget_asc':
      return budgetA - budgetB;
    case 'deadline_asc':
      return deadlineA - deadlineB;
    case 'subs_desc':
      return subsB - subsA;
    case 'created_desc':
    default:
      return createdB - createdA;
  }
}

/**
 * @openapi
 * /api/briefs:
 *   get:
 *     tags: [Briefs]
 *     summary: Browse active briefs
 *     description: Browse advertiser briefs for channel owners to apply
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *       - in: query
 *         name: category
 *         schema:
 *           type: string
 *       - in: query
 *         name: minBudget
 *         schema:
 *           type: string
 *       - in: query
 *         name: maxBudget
 *         schema:
 *           type: string
 *       - in: query
 *         name: minSubscribers
 *         schema:
 *           type: string
 *       - in: query
 *         name: maxSubscribers
 *         schema:
 *           type: string
 *       - in: query
 *         name: minApplications
 *         schema:
 *           type: string
 *       - in: query
 *         name: maxApplications
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Briefs retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 briefs:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Brief'
 *                 pagination:
 *                   type: object
 */
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const {
      page = '1',
      limit = '20',
      category,
      minBudget,
      maxBudget,
      minSubscribers,
      maxSubscribers,
      minApplications,
      maxApplications,
      search,
      sortBy = 'created_desc',
    } = req.query;

    const categorySlugs = getMultiParam(category as string | string[] | undefined);
    const searchTerm = typeof search === 'string' ? search.trim() : '';
    const searchQuery = searchTerm.length >= 3 ? searchTerm : '';
    const parsedPage = Math.max(1, parseInt(page as string, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (parsedPage - 1) * parsedLimit;
    const normalizedSortBy = parseBriefSortBy(sortBy as string | string[] | undefined);
    const minBudgetValue = typeof minBudget === 'string' ? parseNumeric(minBudget) : 0;
    const maxBudgetValue = typeof maxBudget === 'string' ? parseNumeric(maxBudget) : 0;
    const minSubscribersValue = typeof minSubscribers === 'string' ? parseNumeric(minSubscribers) : 0;
    const maxSubscribersValue = typeof maxSubscribers === 'string' ? parseNumeric(maxSubscribers) : 0;
    const minApplicationsValue = typeof minApplications === 'string' ? parseNumeric(minApplications) : 0;
    const maxApplicationsValue = typeof maxApplications === 'string' ? parseNumeric(maxApplications) : 0;
    const hasMinBudget = typeof minBudget === 'string' && minBudget.trim().length > 0;
    const hasMaxBudget = typeof maxBudget === 'string' && maxBudget.trim().length > 0;
    const hasMinSubscribers = typeof minSubscribers === 'string' && minSubscribers.trim().length > 0;
    const hasMaxSubscribers = typeof maxSubscribers === 'string' && maxSubscribers.trim().length > 0;
    const hasMinApplications = typeof minApplications === 'string' && minApplications.trim().length > 0;
    const hasMaxApplications = typeof maxApplications === 'string' && maxApplications.trim().length > 0;

    const where = {
      status: 'ACTIVE' as const,
      ...(req.user?.id && {
        advertiserId: { not: req.user.id },
      }),
      ...(categorySlugs.length > 0 && {
        targetCategories: { hasSome: categorySlugs },
      }),
      ...(searchQuery && {
        OR: [
          { title: { contains: searchQuery, mode: 'insensitive' as const } },
          { description: { contains: searchQuery, mode: 'insensitive' as const } },
          { advertiser: { username: { contains: searchQuery, mode: 'insensitive' as const } } },
          { advertiser: { firstName: { contains: searchQuery, mode: 'insensitive' as const } } },
        ],
      }),
    };

    const briefs = await prisma.brief.findMany({
      where,
      include: {
        advertiser: {
          select: {
            id: true,
            username: true,
            firstName: true,
            photoUrl: true,
          },
        },
        _count: {
          select: { applications: true, savedChannels: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const filteredBriefs = briefs.filter((brief: any) => {
      const budget = getBriefBudget(brief);
      const subscribers = getBriefSubscribersMetric(brief);
      const applications = parseNumeric(brief?._count?.applications);

      if (hasMinBudget && budget < minBudgetValue) {
        return false;
      }

      if (hasMaxBudget && budget > maxBudgetValue) {
        return false;
      }

      if (hasMinSubscribers && subscribers < minSubscribersValue) {
        return false;
      }

      if (hasMaxSubscribers && subscribers > maxSubscribersValue) {
        return false;
      }

      if (hasMinApplications && applications < minApplicationsValue) {
        return false;
      }

      if (hasMaxApplications && applications > maxApplicationsValue) {
        return false;
      }

      return true;
    });

    filteredBriefs.sort((a: any, b: any) => compareBriefs(a, b, normalizedSortBy));
    const total = filteredBriefs.length;
    const pagedBriefs = filteredBriefs.slice(skip, skip + parsedLimit);

    res.json({
      briefs: pagedBriefs.map((b: any) => ({
        id: b.id,
        title: b.title,
        description: b.description,
        adFormatTypes: b.adFormatTypes,
        customFormatDescription: b.customFormatDescription,
        channelsLimit: b.channelsLimit,
        targetCategories: b.targetCategories,
        targetLanguages: b.targetLanguages,
        minSubscribers: b.minSubscribers,
        maxSubscribers: b.maxSubscribers,
        budgetMin: b.budgetMin,
        budgetMax: b.budgetMax,
        currency: b.currency,
        desiredStartDate: b.desiredStartDate,
        desiredEndDate: b.desiredEndDate,
        flexibility: b.flexibility,
        hasCreative: b.hasCreative,
        status: b.status,
        advertiser: b.advertiser,
        applicationCount: b._count.applications,
        savedChannelsCount: b._count.savedChannels,
        createdAt: b.createdAt,
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
 * /api/briefs/my:
 *   get:
 *     tags: [Briefs]
 *     summary: Get current user's briefs
 *     description: Returns all briefs created by the authenticated user (as advertiser)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Briefs retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 briefs:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Brief'
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
      status = 'all',
      sortBy = 'created_desc',
    } = req.query;

    const parsedPage = Math.max(1, parseInt(page as string, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (parsedPage - 1) * parsedLimit;
    const normalizedSortBy = parseBriefSortBy(sortBy as string | string[] | undefined);

    const categorySlugs = getMultiParam(category as string | string[] | undefined);
    const searchTerm = typeof search === 'string' ? search.trim() : '';
    const searchQuery = searchTerm.length >= 3 ? searchTerm : '';
    const normalizedStatusFilter = normalizeBriefStatusFilter(status as string | string[] | undefined);

    const where = {
      advertiserId: req.user!.id,
      ...(normalizedStatusFilter.mode !== 'all' && normalizedStatusFilter.values.length > 0
        ? { status: { in: normalizedStatusFilter.values as any } }
        : {}),
      ...(categorySlugs.length > 0 && {
        targetCategories: { hasSome: categorySlugs },
      }),
      ...(searchQuery && {
        OR: [
          { title: { contains: searchQuery, mode: 'insensitive' as const } },
          { description: { contains: searchQuery, mode: 'insensitive' as const } },
        ],
      }),
    };

    const briefs = await prisma.brief.findMany({
      where,
      include: {
        advertiser: {
          select: {
            id: true,
            username: true,
            firstName: true,
            photoUrl: true,
          },
        },
        _count: {
          select: { applications: true, deals: true, savedChannels: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    briefs.sort((a: any, b: any) => compareBriefs(a, b, normalizedSortBy));
    const total = briefs.length;
    const pagedBriefs = briefs.slice(skip, skip + parsedLimit);

    res.json({
      briefs: pagedBriefs.map((b: any) => ({
        id: b.id,
        title: b.title,
        description: b.description,
        adFormatTypes: b.adFormatTypes,
        targetCategories: b.targetCategories,
        targetLanguages: b.targetLanguages,
        minSubscribers: b.minSubscribers,
        maxSubscribers: b.maxSubscribers,
        budgetMin: b.budgetMin,
        budgetMax: b.budgetMax,
        totalBudget: b.totalBudget,
        currency: b.currency,
        desiredEndDate: b.desiredEndDate,
        status: b.status,
        advertiser: b.advertiser,
        applicationCount: b._count.applications,
        savedChannelsCount: b._count.savedChannels,
        createdAt: b.createdAt,
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
 * /api/briefs:
 *   post:
 *     tags: [Briefs]
 *     summary: Create a new brief
 *     description: Creates a new advertising brief with requirements and budget
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - title
 *               - description
 *               - adFormatTypes
 *               - currency
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               adFormatTypes:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [POST, STORY, REPOST, PINNED, OTHER]
 *               customFormatDescription:
 *                 type: string
 *               channelsLimit:
 *                 type: integer
 *               targetCategories:
 *                 type: array
 *                 items:
 *                   type: string
 *               targetLanguages:
 *                 type: array
 *                 items:
 *                   type: string
 *               minSubscribers:
 *                 type: integer
 *               maxSubscribers:
 *                 type: integer
 *               minAvgViews:
 *                 type: integer
 *               budgetMin:
 *                 type: string
 *               budgetMax:
 *                 type: string
 *               totalBudget:
 *                 type: string
 *               currency:
 *                 type: string
 *                 description: Brief currency (must be one of configured supported currencies)
 *               desiredStartDate:
 *                 type: string
 *                 format: date-time
 *               desiredEndDate:
 *                 type: string
 *                 format: date-time
 *               flexibility:
 *                 type: string
 *                 enum: [STRICT, FLEXIBLE, ANYTIME]
 *                 default: FLEXIBLE
 *               hasCreative:
 *                 type: boolean
 *                 default: false
 *               creativeGuidelines:
 *                 type: string
 *     responses:
 *       201:
 *         description: Brief created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 brief:
 *                   $ref: '#/components/schemas/Brief'
 *       400:
 *         description: Invalid input
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
const createBriefSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  adFormatTypes: z.array(z.enum(['POST', 'STORY', 'REPOST', 'PINNED', 'OTHER'])).min(1),
  customFormatDescription: z.string().optional(),
  channelsLimit: z.number().int().positive().optional(),
  targetCategories: z.array(z.string()).optional(),
  targetLanguages: z.array(z.string()).optional(),
  minSubscribers: z.number().int().positive().optional(),
  maxSubscribers: z.number().int().positive().optional(),
  minAvgViews: z.number().int().positive().optional(),
  budgetMin: z.string().optional(),
  budgetMax: z.string().optional(),
  totalBudget: z.string().optional(),
  currency: requiredCurrencySchema,
  desiredStartDate: z.string().datetime().optional(),
  desiredEndDate: z.string().datetime().optional(),
  flexibility: z.enum(['STRICT', 'FLEXIBLE', 'ANYTIME']).default('FLEXIBLE'),
  hasCreative: z.boolean().default(false),
  creativeGuidelines: z.string().optional(),
  sampleCreative: z.object({
    text: z.string().optional(),
    mediaUrls: z.array(z.string()).optional(),
  }).optional(),
});

router.post('/', telegramAuth, async (req, res, next) => {
  try {
    const data = createBriefSchema.parse(req.body);

    const brief = await prisma.brief.create({
      data: {
        advertiserId: req.user!.id,
        ...data,
        desiredStartDate: data.desiredStartDate ? new Date(data.desiredStartDate) : null,
        desiredEndDate: data.desiredEndDate ? new Date(data.desiredEndDate) : null,
        status: 'ACTIVE',
      },
    });

    // Mark user as advertiser
    if (!req.user!.isAdvertiser) {
      await prisma.user.update({
        where: { id: req.user!.id },
        data: { isAdvertiser: true },
      });
    }

    res.status(201).json({ brief });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/briefs/{id}:
 *   get:
 *     tags: [Briefs]
 *     summary: Get brief details
 *     description: Returns detailed information about a specific brief
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Brief ID
 *     responses:
 *       200:
 *         description: Brief retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 brief:
 *                   $ref: '#/components/schemas/Brief'
 *       404:
 *         description: Brief not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const brief = await prisma.brief.findUnique({
      where: { id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id },
      include: {
        advertiser: {
          select: {
            id: true,
            username: true,
            firstName: true,
            photoUrl: true,
          },
        },
        _count: {
          select: { applications: true, savedChannels: true },
        },
      },
    });

    if (!brief) {
      throw new NotFoundError('Brief');
    }

    res.json({
      brief: {
        ...brief,
        savedChannelsCount: brief._count.savedChannels,
      },
    });
  } catch (error) {
    next(error);
  }
});

const saveBriefChannelSchema = z.object({
  channelId: z.string().cuid(),
});

router.get('/:id/saved-channels', telegramAuth, async (req, res, next) => {
  try {
    const briefId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const brief = await prisma.brief.findUnique({
      where: { id: briefId },
      select: {
        id: true,
        advertiserId: true,
      },
    });

    if (!brief) {
      throw new NotFoundError('Brief');
    }

    if (brief.advertiserId !== req.user!.id) {
      throw new ForbiddenError('Not brief owner');
    }

    const savedChannels = await prisma.briefSavedChannel.findMany({
      where: {
        briefId,
        advertiserId: req.user!.id,
      },
      include: {
        channel: {
          select: {
            id: true,
            username: true,
            title: true,
            description: true,
            language: true,
            isVerified: true,
            categories: {
              select: {
                id: true,
                slug: true,
                name: true,
                icon: true,
              },
            },
            currentStats: {
              select: {
                subscriberCount: true,
                avgViewsPerPost: true,
                engagementRate: true,
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
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      savedChannels: savedChannels.map((entry: any) => ({
        id: entry.id,
        briefId: entry.briefId,
        channelId: entry.channelId,
        advertiserId: entry.advertiserId,
        createdAt: entry.createdAt,
        channel: entry.channel
          ? {
              id: entry.channel.id,
              username: entry.channel.username,
              title: entry.channel.title,
              description: entry.channel.description,
              language: entry.channel.language,
              isVerified: entry.channel.isVerified,
              categories: entry.channel.categories,
              stats: entry.channel.currentStats
                ? {
                    subscribers: entry.channel.currentStats.subscriberCount,
                    avgViews: entry.channel.currentStats.avgViewsPerPost,
                    engagementRate: entry.channel.currentStats.engagementRate,
                  }
                : null,
              formats: entry.channel.adFormats,
            }
          : null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/saved-channels', telegramAuth, async (req, res, next) => {
  try {
    const briefId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const data = saveBriefChannelSchema.parse(req.body);

    const brief = await prisma.brief.findUnique({
      where: { id: briefId },
      select: {
        id: true,
        advertiserId: true,
        status: true,
      },
    });

    if (!brief) {
      throw new NotFoundError('Brief');
    }

    if (brief.advertiserId !== req.user!.id) {
      throw new ForbiddenError('Not brief owner');
    }

    if (brief.status !== 'ACTIVE') {
      throw new ValidationError('Channels can be saved only for active briefs');
    }

    const channel = await prisma.channel.findFirst({
      where: {
        id: data.channelId,
        deletedAt: null,
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    if (!channel) {
      throw new NotFoundError('Channel');
    }

    const existing = await prisma.briefSavedChannel.findUnique({
      where: {
        briefId_channelId: {
          briefId,
          channelId: data.channelId,
        },
      },
    });

    if (existing) {
      res.json({
        savedChannel: existing,
        created: false,
      });
      return;
    }

    const savedChannel = await prisma.briefSavedChannel.create({
      data: {
        briefId,
        channelId: data.channelId,
        advertiserId: req.user!.id,
      },
    });

    res.status(201).json({
      savedChannel,
      created: true,
    });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id/saved-channels/:channelId', telegramAuth, async (req, res, next) => {
  try {
    const briefId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const channelId = Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId;
    const brief = await prisma.brief.findUnique({
      where: { id: briefId },
      select: {
        id: true,
        advertiserId: true,
      },
    });

    if (!brief) {
      throw new NotFoundError('Brief');
    }

    if (brief.advertiserId !== req.user!.id) {
      throw new ForbiddenError('Not brief owner');
    }

    await prisma.briefSavedChannel.deleteMany({
      where: {
        briefId,
        channelId,
        advertiserId: req.user!.id,
      },
    });

    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/briefs/{id}:
 *   put:
 *     tags: [Briefs]
 *     summary: Update brief
 *     description: Updates brief information (owner only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Brief ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               budgetMin:
 *                 type: string
 *               budgetMax:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [ACTIVE, PAUSED, CANCELLED]
 *     responses:
 *       200:
 *         description: Brief updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 brief:
 *                   $ref: '#/components/schemas/Brief'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Not brief owner
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Brief not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/:id', telegramAuth, async (req, res, next) => {
  try {
    const brief = await prisma.brief.findUnique({
      where: { id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id },
    });

    if (!brief) {
      throw new NotFoundError('Brief');
    }

    if (brief.advertiserId !== req.user!.id) {
      throw new ForbiddenError('Not brief owner');
    }

    const { title, description, status, budgetMin, budgetMax } = req.body;

    const updated = await prisma.brief.update({
      where: { id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id },
      data: {
        ...(title && { title }),
        ...(description && { description }),
        ...(budgetMin !== undefined && { budgetMin }),
        ...(budgetMax !== undefined && { budgetMax }),
        ...(status && ['ACTIVE', 'PAUSED', 'CANCELLED'].includes(status) && { status }),
      },
    });

    res.json({ brief: updated });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/briefs/{id}:
 *   delete:
 *     tags: [Briefs]
 *     summary: Delete brief
 *     description: Permanently deletes a brief owned by the authenticated advertiser
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Brief ID
 *     responses:
 *       200:
 *         description: Brief deleted successfully
 *       400:
 *         description: Brief has related deals and cannot be deleted
 *       403:
 *         description: Not brief owner
 *       404:
 *         description: Brief not found
 */
router.delete('/:id', telegramAuth, async (req, res, next) => {
  try {
    const briefId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const brief = await prisma.brief.findUnique({
      where: { id: briefId },
    });

    if (!brief) {
      throw new NotFoundError('Brief');
    }

    if (brief.advertiserId !== req.user!.id) {
      throw new ForbiddenError('Not brief owner');
    }

    const dealsCount = await prisma.deal.count({
      where: { briefId },
    });

    if (dealsCount > 0) {
      throw new ValidationError('Cannot delete brief with existing deals');
    }

    await prisma.brief.delete({
      where: { id: briefId },
    });

    res.json({ deleted: true });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/briefs/{id}/applications:
 *   post:
 *     tags: [Briefs]
 *     summary: Apply to a brief
 *     description: Submit application to a brief with channel and pricing proposal
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Brief ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - channelId
 *               - proposedPrice
 *             properties:
 *               channelId:
 *                 type: string
 *                 description: Channel ID to propose for the brief
 *               proposedPrice:
 *                 type: string
 *                 description: Proposed price for the advertisement
 *               proposedDate:
 *                 type: string
 *                 format: date-time
 *                 description: Proposed publication date
 *               pitch:
 *                 type: string
 *                 description: Application pitch message
 *               selectedAdFormatIds:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Optional selected channel ad format IDs
 *     responses:
 *       201:
 *         description: Application submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 application:
 *                   type: object
 *       400:
 *         description: Already applied or invalid channel
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
 *       403:
 *         description: Not channel owner
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Brief not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
const applySchema = z.object({
  channelId: z.string().cuid(),
  proposedPrice: z.string().min(1),
  proposedDate: z.string().datetime().optional(),
  pitch: z.string().optional(),
  selectedAdFormatIds: z.array(z.string().cuid()).optional(),
  proposedFormatPrices: z.record(z.string(), z.string().min(1)).optional(),
});

router.post('/:id/applications', telegramAuth, async (req, res, next) => {
  try {
    const data = applySchema.parse(req.body);

    // Check if user is a channel owner
    if (!req.user!.isChannelOwner) {
      throw new ForbiddenError('Only channel owners can apply to briefs');
    }

    const brief = await prisma.brief.findUnique({
      where: { id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id },
    });

    if (!brief || brief.status !== 'ACTIVE') {
      throw new NotFoundError('Brief');
    }

    if (brief.advertiserId === req.user!.id) {
      throw new ValidationError('Cannot apply to your own brief');
    }

    // Verify channel ownership
    const channel = await prisma.channel.findUnique({
      where: { id: data.channelId },
      include: {
        adFormats: {
          where: { isActive: true },
          select: { id: true },
        },
      },
    });

    if (!channel || channel.ownerId !== req.user!.id) {
      throw new ForbiddenError('Not channel owner');
    }

    const availableFormatIds = new Set(channel.adFormats.map((f: any) => f.id));
    const proposedFormatPrices = Object.entries(data.proposedFormatPrices || {})
      .reduce<Record<string, string>>((acc, [adFormatId, amount]) => {
        const normalizedAmount = amount.trim();
        if (!normalizedAmount) {
          return acc;
        }

        acc[adFormatId] = normalizedAmount;
        return acc;
      }, {});
    const selectedAdFormatIds = Array.from(new Set(
      (data.selectedAdFormatIds && data.selectedAdFormatIds.length > 0)
        ? data.selectedAdFormatIds
        : Object.keys(proposedFormatPrices),
    ));

    if (selectedAdFormatIds.length > 0) {
      const hasInvalidFormat = selectedAdFormatIds.some((id) => !availableFormatIds.has(id));
      if (hasInvalidFormat) {
        throw new ValidationError('Selected ad format options are invalid for this channel');
      }
    }

    const hasInvalidPriceFormat = Object.keys(proposedFormatPrices)
      .some((adFormatId) => !availableFormatIds.has(adFormatId));
    if (hasInvalidPriceFormat) {
      throw new ValidationError('Ad format pricing contains invalid channel format IDs');
    }

    if (selectedAdFormatIds.length > 0) {
      const selectedIdSet = new Set(selectedAdFormatIds);
      const hasPricingOutsideSelection = Object.keys(proposedFormatPrices)
        .some((adFormatId) => !selectedIdSet.has(adFormatId));
      if (hasPricingOutsideSelection) {
        throw new ValidationError('Ad format pricing must match selected ad format options');
      }
    }

    const pitch = serializeApplicationPitch({
      pitch: data.pitch,
      selectedAdFormatIds,
      proposedFormatPrices,
    });
    const proposedPrice = data.proposedPrice.trim();
    if (!proposedPrice) {
      throw new ValidationError('proposedPrice is required');
    }

    // Check if already applied
    const existing = await prisma.briefApplication.findUnique({
      where: {
        briefId_channelId: {
          briefId: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id,
          channelId: data.channelId,
        },
      },
    });

    if (existing) {
      throw new ValidationError('Already applied with this channel');
    }

    const application = await prisma.briefApplication.create({
      data: {
        briefId: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id,
        channelId: data.channelId,
        applicantId: req.user!.id,
        proposedPrice,
        proposedDate: data.proposedDate ? new Date(data.proposedDate) : null,
        pitch,
        selectedAdFormatIds,
        status: 'PENDING',
      },
      include: {
        brief: {
          select: { title: true, advertiserId: true },
        },
      },
    });

    // Emit event to notify advertiser
    appEvents.emit(AppEvent.BRIEF_APPLICATION_SUBMITTED, {
      applicationId: application.id,
      briefId: application.briefId,
      briefTitle: application.brief.title,
      channelOwnerId: req.user!.id,
      advertiserId: application.brief.advertiserId,
    });

    res.status(201).json({ application });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/briefs/{id}/my-applications:
 *   get:
 *     tags: [Briefs]
 *     summary: Get current user's applications for a brief
 *     description: Returns applications submitted by the authenticated channel owner for this brief
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Brief ID
 *     responses:
 *       200:
 *         description: Applications retrieved successfully
 */
router.get('/:id/my-applications', telegramAuth, async (req, res, next) => {
  try {
    const briefId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const applications = await prisma.briefApplication.findMany({
      where: {
        briefId,
        applicantId: req.user!.id,
      },
      select: {
        id: true,
        channelId: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ applications });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/briefs/{id}/applications:
 *   get:
 *     tags: [Briefs]
 *     summary: Get applications for a brief
 *     description: Returns all applications for a brief (advertiser only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Brief ID
 *     responses:
 *       200:
 *         description: Applications retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 applications:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Not brief owner
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Brief not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/:id/applications', telegramAuth, async (req, res, next) => {
  try {
    const brief = await prisma.brief.findUnique({
      where: { id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id },
    });

    if (!brief) {
      throw new NotFoundError('Brief');
    }

    if (brief.advertiserId !== req.user!.id) {
      throw new ForbiddenError('Not brief owner');
    }

    const applications = await prisma.briefApplication.findMany({
      where: { briefId: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id },
      include: {
        deal: {
          select: { id: true, dealNumber: true, status: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Get channel details for each application
    const channelIds = applications.map((a: any) => a.channelId);
    const channels = await prisma.channel.findMany({
      where: { id: { in: channelIds } },
      include: {
        currentStats: true,
        categories: true,
        adFormats: {
          where: { isActive: true },
        },
        owner: {
          select: {
            id: true,
            username: true,
            firstName: true,
            photoUrl: true,
          },
        },
      },
    });

    const channelMap = new Map(channels.map((c: any) => [c.id, c]));

    res.json({
      applications: applications.map((a: any) => {
        const legacy = parseLegacyApplicationPitch(a.pitch);
        const selectedAdFormatIds: string[] = a.selectedAdFormatIds?.length > 0
          ? a.selectedAdFormatIds
          : (legacy.selectedAdFormatIds.length > 0
            ? legacy.selectedAdFormatIds
            : Object.keys(legacy.proposedFormatPrices));
        const proposedFormatPrices: Record<string, string> = {};

        selectedAdFormatIds.forEach((adFormatId) => {
          const amount = legacy.proposedFormatPrices[adFormatId];
          if (amount) {
            proposedFormatPrices[adFormatId] = amount;
          }
        });

        return {
          ...a,
          pitch: legacy.pitch,
          selectedAdFormatIds,
          proposedFormatPrices,
          channel: channelMap.get(a.channelId),
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/briefs/applications/{id}:
 *   put:
 *     tags: [Briefs]
 *     summary: Accept or reject a brief application
 *     description: Updates application status and creates a deal if accepted
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Application ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [ACCEPTED, REJECTED]
 *               adFormatId:
 *                 type: string
 *                 description: Required if accepting - the ad format from the channel
 *               rejectionReason:
 *                 type: string
 *                 description: Optional reason for rejection
 *               scheduledPostTime:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Application updated successfully
 *       400:
 *         description: Invalid status or missing required fields
 *       403:
 *         description: Not brief owner
 *       404:
 *         description: Application not found
 */
const updateApplicationSchema = z.object({
  status: z.enum(['ACCEPTED', 'REJECTED']),
  adFormatId: z.string().cuid().optional(),
  rejectionReason: z.string().optional(),
});

router.put('/applications/:id', telegramAuth, async (req, res, next) => {
  try {
    const data = updateApplicationSchema.parse(req.body);
    const applicationId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    // Get application with brief details
    const application = await prisma.briefApplication.findUnique({
      where: { id: applicationId },
      include: {
        brief: true,
      },
    });

    if (!application) {
      throw new NotFoundError('Application');
    }

    // Fetch channel with ad formats separately
    const channel = await prisma.channel.findUnique({
      where: { id: application.channelId },
      include: {
        adFormats: true,
      },
    });

    if (!channel) {
      throw new NotFoundError('Channel');
    }

    // Verify user is the brief owner (advertiser)
    if (application.brief.advertiserId !== req.user!.id) {
      throw new ForbiddenError('Only the brief owner can accept/reject applications');
    }

    // Check if already processed
    if (application.status === 'ACCEPTED' || application.status === 'REJECTED') {
      throw new ValidationError('Application already processed');
    }

    if (application.applicantId === application.brief.advertiserId) {
      throw new ValidationError('Cannot create a deal with yourself');
    }

    // If accepting, validate ad format
    if (data.status === 'ACCEPTED') {
      if (!data.adFormatId) {
        throw new ValidationError('adFormatId is required when accepting an application');
      }

      // Verify the ad format belongs to the channel
      const adFormat = channel.adFormats.find((f: any) => f.id === data.adFormatId);
      if (!adFormat) {
        throw new ValidationError('Invalid ad format for this channel');
      }

      const legacy = parseLegacyApplicationPitch(application.pitch);
      const selectedAdFormatIds = application.selectedAdFormatIds?.length > 0
        ? application.selectedAdFormatIds
        : (legacy.selectedAdFormatIds.length > 0
          ? legacy.selectedAdFormatIds
          : Object.keys(legacy.proposedFormatPrices));

      if (selectedAdFormatIds.length > 0) {
        if (!selectedAdFormatIds.includes(data.adFormatId)) {
          throw new ValidationError('Please choose one of the ad format options selected by the channel owner');
        }
      }

      const agreedPrice = legacy.proposedFormatPrices[data.adFormatId]?.trim()
        || application.proposedPrice;
      const briefCurrencyRaw = application.brief.currency;
      if (!briefCurrencyRaw || !isSupportedCurrency(briefCurrencyRaw)) {
        throw new ValidationError('Brief currency is not supported');
      }
      const briefCurrency = normalizeCurrencyInput(briefCurrencyRaw);

      // Update application status
      const updatedApplication = await prisma.briefApplication.update({
        where: { id: applicationId },
        data: {
          status: 'ACCEPTED',
        },
      });

      // Create the deal
      const deal = await prisma.deal.create({
        data: {
          advertiserId: application.brief.advertiserId,
          channelOwnerId: application.applicantId,
          channelId: application.channelId,
          adFormatId: data.adFormatId,
          origin: 'BRIEF',
          briefId: application.briefId,
          applicationId: application.id,
          agreedPrice,
          currency: briefCurrency,
          scheduledTime: application.proposedDate,
          status: 'CREATED',
        },
      });

      await appEvents.emitWithNotification(AppEvent.DEAL_CREATED, {
        dealId: deal.id,
        channelOwnerId: deal.channelOwnerId,
        advertiserId: deal.advertiserId,
      });

      // Emit event to notify channel owner
      appEvents.emit(AppEvent.BRIEF_APPLICATION_ACCEPTED, {
        applicationId: application.id,
        briefId: application.briefId,
        briefTitle: application.brief.title,
        dealId: deal.id,
        dealNumber: deal.dealNumber,
        channelOwnerId: application.applicantId,
        advertiserId: application.brief.advertiserId,
      });

      res.json({
        application: updatedApplication,
        deal: {
          id: deal.id,
          dealNumber: deal.dealNumber,
        },
      });
    } else {
      // Rejecting
      const updatedApplication = await prisma.briefApplication.update({
        where: { id: applicationId },
        data: {
          status: 'REJECTED',
          rejectionReason: data.rejectionReason,
        },
      });

      // Emit event to notify channel owner
      appEvents.emit(AppEvent.BRIEF_APPLICATION_REJECTED, {
        applicationId: application.id,
        briefId: application.briefId,
        briefTitle: application.brief.title,
        reason: data.rejectionReason,
        channelOwnerId: application.applicantId,
        advertiserId: application.brief.advertiserId,
      });

      res.json({ application: updatedApplication });
    }
  } catch (error) {
    next(error);
  }
});

export default router;
