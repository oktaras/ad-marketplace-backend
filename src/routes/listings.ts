import { Router } from 'express';
import { z } from 'zod';
import { telegramAuth, optionalAuth } from '../middleware/auth.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../middleware/error.js';
import { prisma } from '../lib/prisma.js';
import { optionalCurrencySchema, requiredCurrencySchema } from '../lib/currency.js';

const router = Router();

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

type ListingSortBy =
  | 'created_desc'
  | 'created_asc'
  | 'price_desc'
  | 'price_asc'
  | 'subscribers_desc'
  | 'subscribers_asc'
  | 'views_desc'
  | 'er_desc';

function parseSortBy(raw: string | string[] | undefined): ListingSortBy {
  const value = (Array.isArray(raw) ? raw[0] : raw || '').trim().toLowerCase();
  switch (value) {
    case 'created_asc':
      return 'created_asc';
    case 'price_desc':
      return 'price_desc';
    case 'price_asc':
      return 'price_asc';
    case 'subscribers_desc':
      return 'subscribers_desc';
    case 'subscribers_asc':
      return 'subscribers_asc';
    case 'views_desc':
      return 'views_desc';
    case 'er_desc':
      return 'er_desc';
    case 'created_desc':
    default:
      return 'created_desc';
  }
}

function parseNumeric(value: string | number | null | undefined): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  return 0;
}

function getListingOffers(listing: any): Array<{
  id: string;
  adFormatId: string;
  customPrice: string | null;
  customCurrency: string | null;
  enabled: boolean;
  adFormat: {
    id: string;
    type: string;
    name: string;
    priceAmount: string;
    priceCurrency: string;
  };
}> {
  const rawOffers = Array.isArray(listing.formatOffers) ? listing.formatOffers : [];
  if (rawOffers.length > 0) {
    return rawOffers
      .filter((offer: any) => offer?.adFormat)
      .map((offer: any) => ({
        id: offer.id,
        adFormatId: offer.adFormatId,
        customPrice: offer.customPrice ?? null,
        customCurrency: offer.customCurrency ?? null,
        enabled: Boolean(offer.enabled),
        adFormat: {
          id: offer.adFormat.id,
          type: String(offer.adFormat.type),
          name: offer.adFormat.name,
          priceAmount: offer.adFormat.priceAmount,
          priceCurrency: offer.adFormat.priceCurrency,
        },
      }));
  }

  if (!listing.adFormat) {
    return [];
  }

  return [
    {
      id: `${listing.id}_legacy_offer`,
      adFormatId: listing.adFormatId,
      customPrice: listing.customPrice ?? null,
      customCurrency: listing.customCurrency ?? null,
      enabled: listing.status !== 'REMOVED',
      adFormat: {
        id: listing.adFormat.id,
        type: String(listing.adFormat.type),
        name: listing.adFormat.name,
        priceAmount: listing.adFormat.priceAmount,
        priceCurrency: listing.adFormat.priceCurrency,
      },
    },
  ];
}

function getEffectiveOfferPrice(offer: {
  customPrice: string | null;
  adFormat: { priceAmount: string };
}): number {
  return parseNumeric(offer.customPrice) || parseNumeric(offer.adFormat.priceAmount);
}

function getEffectiveOfferCurrency(offer: {
  customCurrency: string | null;
  adFormat: { priceCurrency: string };
}): string {
  return offer.customCurrency || offer.adFormat.priceCurrency || 'TON';
}

function getListingPriceMetric(listing: any): number {
  const offers = getListingOffers(listing);
  const activeOffers = offers.filter((offer) => offer.enabled);
  const source = activeOffers.length > 0 ? activeOffers : offers;
  if (source.length === 0) {
    return 0;
  }

  return Math.min(...source.map((offer) => getEffectiveOfferPrice(offer)));
}

function getListingSubscribersMetric(listing: any): number {
  return parseNumeric(listing.channel?.currentStats?.subscriberCount);
}

function getListingViewsMetric(listing: any): number {
  return parseNumeric(listing.channel?.currentStats?.avgViewsPerPost);
}

function getListingErMetric(listing: any): number {
  return parseNumeric(listing.channel?.currentStats?.engagementRate);
}

function compareListings(a: any, b: any, sortBy: ListingSortBy): number {
  const createdA = new Date(a.createdAt).getTime();
  const createdB = new Date(b.createdAt).getTime();
  const priceA = getListingPriceMetric(a);
  const priceB = getListingPriceMetric(b);
  const subscribersA = getListingSubscribersMetric(a);
  const subscribersB = getListingSubscribersMetric(b);
  const viewsA = getListingViewsMetric(a);
  const viewsB = getListingViewsMetric(b);
  const erA = getListingErMetric(a);
  const erB = getListingErMetric(b);

  switch (sortBy) {
    case 'created_asc':
      return createdA - createdB;
    case 'price_desc':
      return priceB - priceA;
    case 'price_asc':
      return priceA - priceB;
    case 'subscribers_desc':
      return subscribersB - subscribersA;
    case 'subscribers_asc':
      return subscribersA - subscribersB;
    case 'views_desc':
      return viewsB - viewsA;
    case 'er_desc':
      return erB - erA;
    case 'created_desc':
    default:
      return createdB - createdA;
  }
}

function serializeListing(listing: any) {
  const offers = getListingOffers(listing);
  const activeOffers = offers.filter((offer) => offer.enabled);
  const source = activeOffers.length > 0 ? activeOffers : offers;
  const primaryOffer = source[0] ?? offers[0] ?? null;
  const price = primaryOffer ? getEffectiveOfferPrice(primaryOffer) : 0;
  const currency = primaryOffer ? getEffectiveOfferCurrency(primaryOffer) : 'TON';

  return {
    id: listing.id,
    title: listing.title,
    description: listing.description,
    status: listing.status,
    price,
    currency,
    customPrice: listing.customPrice ?? null,
    customCurrency: listing.customCurrency ?? null,
    format: primaryOffer?.adFormat ?? listing.adFormat ?? null,
    adFormat: listing.adFormat ?? primaryOffer?.adFormat ?? null,
    formatOffers: offers.map((offer) => ({
      id: offer.id,
      adFormatId: offer.adFormatId,
      customPrice: offer.customPrice,
      customCurrency: offer.customCurrency,
      enabled: offer.enabled,
      adFormat: offer.adFormat,
      effectivePrice: getEffectiveOfferPrice(offer),
      effectiveCurrency: getEffectiveOfferCurrency(offer),
    })),
    channel: {
      id: listing.channel.id,
      username: listing.channel.username,
      title: listing.channel.title,
      stats: listing.channel.currentStats
        ? {
            subscribers: listing.channel.currentStats.subscriberCount,
            avgViews: listing.channel.currentStats.avgViewsPerPost,
            engagementRate: listing.channel.currentStats.engagementRate,
          }
        : null,
      categories: listing.channel.categories,
      owner: listing.channel.owner ?? null,
    },
    availableFrom: listing.availableFrom,
    availableTo: listing.availableTo,
    createdAt: listing.createdAt,
    dealCount: listing._count?.deals ?? 0,
    requirements: listing.requirements ?? null,
    restrictions: listing.restrictions ?? null,
  };
}

/**
 * @openapi
 * /api/listings:
 *   get:
 *     tags: [Listings]
 *     summary: Browse active listings
 *     description: Browse marketplace listings with filtering and pagination
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
 *         name: language
 *         schema:
 *           type: string
 *       - in: query
 *         name: minPrice
 *         schema:
 *           type: string
 *       - in: query
 *         name: maxPrice
 *         schema:
 *           type: string
 *       - in: query
 *         name: formatType
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Listings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 listings:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Listing'
 *                 pagination:
 *                   type: object
 */
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const {
      page = '1',
      limit = '20',
      category,
      language,
      minPrice,
      maxPrice,
      formatType,
      search,
      sortBy = 'created_desc',
    } = req.query;

    const parsedPage = Math.max(1, parseInt(page as string, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (parsedPage - 1) * parsedLimit;
    const normalizedSortBy = parseSortBy(sortBy as string | string[] | undefined);
    const searchTerm = typeof search === 'string' ? search.trim() : '';
    const searchQuery = searchTerm.length >= 3 ? searchTerm : '';
    const minPriceValue = typeof minPrice === 'string' ? parseNumeric(minPrice) : 0;
    const maxPriceValue = typeof maxPrice === 'string' ? parseNumeric(maxPrice) : 0;
    const hasMinPrice = typeof minPrice === 'string' && minPrice.trim().length > 0;
    const hasMaxPrice = typeof maxPrice === 'string' && maxPrice.trim().length > 0;
    const normalizedFormatType = typeof formatType === 'string' ? formatType.toUpperCase() : '';

    const formatCondition = normalizedFormatType
      ? {
          OR: [
            { formatOffers: { some: { enabled: true, adFormat: { type: normalizedFormatType as any } } } },
            { adFormat: { type: normalizedFormatType as any } },
          ],
        }
      : null;

    const searchCondition = searchQuery
      ? {
          OR: [
            { title: { contains: searchQuery, mode: 'insensitive' as const } },
            { description: { contains: searchQuery, mode: 'insensitive' as const } },
            { channel: { title: { contains: searchQuery, mode: 'insensitive' as const } } },
            { channel: { username: { contains: searchQuery, mode: 'insensitive' as const } } },
          ],
        }
      : null;

    const where = {
      status: 'ACTIVE' as const,
      channel: {
        status: 'ACTIVE' as const,
        deletedAt: null,
        ...(category && {
          categories: { some: { slug: category as string } },
        }),
        ...(language && { language: language as string }),
      },
      ...(formatCondition || searchCondition
        ? {
            AND: [formatCondition, searchCondition].filter((entry) => entry !== null),
          }
        : {}),
    };

    const listings = await prisma.listing.findMany({
      where,
      include: {
        channel: {
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
          },
        },
        adFormat: true,
        formatOffers: {
          include: {
            adFormat: true,
          },
          orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }],
        },
        _count: {
          select: { deals: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const filteredListings = listings.filter((listing: any) => {
      const price = getListingPriceMetric(listing);
      if (hasMinPrice && price < minPriceValue) {
        return false;
      }

      if (hasMaxPrice && price > maxPriceValue) {
        return false;
      }

      return true;
    });

    filteredListings.sort((a: any, b: any) => compareListings(a, b, normalizedSortBy));
    const total = filteredListings.length;
    const pagedListings = filteredListings.slice(skip, skip + parsedLimit);

    res.json({
      listings: pagedListings.map((listing: any) => serializeListing(listing)),
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
 * /api/listings/my:
 *   get:
 *     tags: [Listings]
 *     summary: Get current user's listings
 *     description: Returns all listings owned by the authenticated user
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Listings retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 listings:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Listing'
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
    const normalizedSortBy = parseSortBy(sortBy as string | string[] | undefined);

    const categorySlugs = getMultiParam(category as string | string[] | undefined);
    const searchTerm = typeof search === 'string' ? search.trim() : '';
    const searchQuery = searchTerm.length >= 3 ? searchTerm : '';
    const statusValue = typeof status === 'string' ? status.trim().toUpperCase() : 'ALL';
    const closedStatuses: Array<'SOLD_OUT' | 'EXPIRED' | 'REMOVED'> = ['SOLD_OUT', 'EXPIRED', 'REMOVED'];
    const statusList = statusValue
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const normalizedStatusList = statusList.length > 0 ? statusList : ['ALL'];

    const statusFilter = (() => {
      if (normalizedStatusList.includes('ALL')) {
        return undefined;
      }

      if (normalizedStatusList.length === 1 && normalizedStatusList[0] === 'ACTIVE') {
        return { status: 'ACTIVE' as const };
      }

      if (normalizedStatusList.length === 1 && normalizedStatusList[0] === 'PAUSED') {
        return { status: 'PAUSED' as const };
      }

      if (normalizedStatusList.length === 1 && normalizedStatusList[0] === 'DRAFT') {
        return { status: 'DRAFT' as const };
      }

      if (normalizedStatusList.length === 1 && normalizedStatusList[0] === 'CLOSED') {
        return { status: { in: closedStatuses } };
      }

      const exact = normalizedStatusList.filter((entry) => (
        ['DRAFT', 'ACTIVE', 'PAUSED', 'SOLD_OUT', 'EXPIRED', 'REMOVED'].includes(entry)
      ));
      if (exact.length > 0) {
        return { status: { in: exact as any } };
      }

      return undefined;
    })();

    const where = {
      channel: {
        ownerId: req.user!.id,
        deletedAt: null,
        ...(categorySlugs.length > 0 && {
          categories: { some: { slug: { in: categorySlugs } } },
        }),
      },
      ...(statusFilter ?? {}),
      ...(searchQuery && {
        OR: [
          { title: { contains: searchQuery, mode: 'insensitive' as const } },
          { description: { contains: searchQuery, mode: 'insensitive' as const } },
          { channel: { title: { contains: searchQuery, mode: 'insensitive' as const } } },
          { channel: { username: { contains: searchQuery, mode: 'insensitive' as const } } },
        ],
      }),
    };

    const listings = await prisma.listing.findMany({
      where,
      include: {
        channel: {
          select: {
            id: true,
            username: true,
            title: true,
            categories: {
              select: {
                slug: true,
                name: true,
                icon: true,
              },
            },
            currentStats: {
              select: {
                subscriberCount: true,
                avgViewsPerPost: true,
              },
            },
          },
        },
        adFormat: {
          select: {
            id: true,
            type: true,
            name: true,
            priceAmount: true,
            priceCurrency: true,
          },
        },
        formatOffers: {
          include: {
            adFormat: {
              select: {
                id: true,
                type: true,
                name: true,
                priceAmount: true,
                priceCurrency: true,
              },
            },
          },
          orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }],
        },
        _count: {
          select: { deals: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    listings.sort((a: any, b: any) => compareListings(a, b, normalizedSortBy));
    const total = listings.length;
    const pagedListings = listings.slice(skip, skip + parsedLimit);

    res.json({
      listings: pagedListings.map((listing: any) => serializeListing(listing)),
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
 * /api/listings:
 *   post:
 *     tags: [Listings]
 *     summary: Create a new listing
 *     description: Creates a new advertising listing for a channel
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - channelId
 *               - adFormatId
 *               - title
 *             properties:
 *               channelId:
 *                 type: string
 *               adFormatId:
 *                 type: string
 *               title:
 *                 type: string
 *               description:
 *                 type: string
 *               customPrice:
 *                 type: string
 *               customCurrency:
 *                 type: string
 *               availableFrom:
 *                 type: string
 *                 format: date-time
 *               availableTo:
 *                 type: string
 *                 format: date-time
 *               requirements:
 *                 type: string
 *               restrictions:
 *                 type: string
 *     responses:
 *       201:
 *         description: Listing created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 listing:
 *                   $ref: '#/components/schemas/Listing'
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
 *       403:
 *         description: Not channel owner
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
const createListingSchema = z.object({
  channelId: z.string().cuid(),
  adFormatId: z.string().cuid().optional(),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  customPrice: z.string().optional(),
  customCurrency: optionalCurrencySchema,
  formatOffers: z.array(
    z.object({
      adFormatId: z.string().cuid(),
      customPrice: z.string().optional(),
      customCurrency: optionalCurrencySchema,
      enabled: z.boolean().optional(),
    }),
  ).optional(),
  availableFrom: z.string().datetime().optional(),
  availableTo: z.string().datetime().optional(),
  requirements: z.string().optional(),
  restrictions: z.string().optional(),
});

router.post('/', telegramAuth, async (req, res, next) => {
  try {
    const data = createListingSchema.parse(req.body);
    const offersInput = Array.isArray(data.formatOffers) ? data.formatOffers : [];

    // Verify channel ownership
    const channel = await prisma.channel.findUnique({
      where: { id: data.channelId },
    });

    if (!channel || channel.ownerId !== req.user!.id) {
      throw new ForbiddenError('Not channel owner');
    }

    const channelFormats = await prisma.adFormat.findMany({
      where: {
        channelId: data.channelId,
        isActive: true,
      },
      select: {
        id: true,
      },
    });
    const availableFormatIds = new Set(channelFormats.map((format: any) => format.id));

    const normalizedOffers = offersInput
      .reduce<Array<{ adFormatId: string; customPrice?: string; customCurrency?: string; enabled: boolean }>>(
        (acc, offer) => {
          if (!offer.adFormatId || acc.some((entry) => entry.adFormatId === offer.adFormatId)) {
            return acc;
          }

          acc.push({
            adFormatId: offer.adFormatId,
            customPrice: offer.customPrice?.trim() || undefined,
            customCurrency: offer.customCurrency?.trim() || undefined,
            enabled: offer.enabled ?? true,
          });
          return acc;
        },
        [],
      );

    if (normalizedOffers.length === 0) {
      if (!data.adFormatId) {
        throw new ValidationError('At least one ad format offer is required');
      }

      normalizedOffers.push({
        adFormatId: data.adFormatId,
        customPrice: data.customPrice?.trim() || undefined,
        customCurrency: data.customCurrency?.trim() || undefined,
        enabled: true,
      });
    }

    const invalidOffer = normalizedOffers.find((offer) => !availableFormatIds.has(offer.adFormatId));
    if (invalidOffer) {
      throw new ValidationError('Ad format not found for this channel');
    }

    const primaryOffer = normalizedOffers.find((offer) => offer.enabled) ?? normalizedOffers[0];

    const listing = await prisma.listing.create({
      data: {
        channelId: data.channelId,
        adFormatId: primaryOffer.adFormatId,
        title: data.title,
        description: data.description,
        customPrice: primaryOffer.customPrice,
        customCurrency: primaryOffer.customCurrency,
        availableFrom: data.availableFrom ? new Date(data.availableFrom) : null,
        availableTo: data.availableTo ? new Date(data.availableTo) : null,
        requirements: data.requirements,
        restrictions: data.restrictions,
        status: 'ACTIVE',
        formatOffers: {
          create: normalizedOffers.map((offer) => ({
            adFormatId: offer.adFormatId,
            customPrice: offer.customPrice,
            customCurrency: offer.customCurrency,
            enabled: offer.enabled,
          })),
        },
      },
      include: {
        channel: {
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
          },
        },
        adFormat: {
          select: {
            id: true,
            type: true,
            name: true,
            priceAmount: true,
            priceCurrency: true,
          },
        },
        formatOffers: {
          include: {
            adFormat: {
              select: {
                id: true,
                type: true,
                name: true,
                priceAmount: true,
                priceCurrency: true,
              },
            },
          },
          orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }],
        },
        _count: {
          select: { deals: true },
        },
      },
    });

    res.status(201).json({ listing: serializeListing(listing) });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/listings/{id}:
 *   get:
 *     tags: [Listings]
 *     summary: Get listing details
 *     description: Returns detailed information about a specific listing
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Listing ID
 *     responses:
 *       200:
 *         description: Listing retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 listing:
 *                   $ref: '#/components/schemas/Listing'
 *       404:
 *         description: Listing not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const listingId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
      include: {
        channel: {
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
          },
        },
        adFormat: {
          select: {
            id: true,
            type: true,
            name: true,
            priceAmount: true,
            priceCurrency: true,
          },
        },
        formatOffers: {
          include: {
            adFormat: {
              select: {
                id: true,
                type: true,
                name: true,
                priceAmount: true,
                priceCurrency: true,
              },
            },
          },
          orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }],
        },
        _count: {
          select: { deals: true },
        },
      },
    });

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    res.json({ listing: serializeListing(listing) });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/listings/{id}:
 *   put:
 *     tags: [Listings]
 *     summary: Update listing
 *     description: Updates listing information (owner only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Listing ID
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
 *               customPrice:
 *                 type: string
 *               status:
 *                 type: string
 *                 enum: [ACTIVE, PAUSED, REMOVED]
 *               requirements:
 *                 type: string
 *               restrictions:
 *                 type: string
 *     responses:
 *       200:
 *         description: Listing updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 listing:
 *                   $ref: '#/components/schemas/Listing'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Not listing owner
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Listing not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
const updateListingSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  customPrice: z.string().nullable().optional(),
  customCurrency: z.union([z.null(), requiredCurrencySchema]).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'SOLD_OUT', 'EXPIRED', 'REMOVED']).optional(),
  requirements: z.string().nullable().optional(),
  restrictions: z.string().nullable().optional(),
  formatOffers: z.array(
    z.object({
      adFormatId: z.string().cuid(),
      customPrice: z.string().nullable().optional(),
      customCurrency: z.union([z.null(), requiredCurrencySchema]).optional(),
      enabled: z.boolean().optional(),
    }),
  ).optional(),
});

router.put('/:id', telegramAuth, async (req, res, next) => {
  const listingId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const data = updateListingSchema.parse(req.body);
    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
      include: {
        channel: true,
        formatOffers: {
          select: {
            id: true,
            adFormatId: true,
          },
        },
      },
    });

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    if (listing.channel.ownerId !== req.user!.id) {
      throw new ForbiddenError('Not listing owner');
    }

    const offersInput = Array.isArray(data.formatOffers) ? data.formatOffers : undefined;

    const normalizedOffers = offersInput
      ? offersInput.reduce<Array<{ adFormatId: string; customPrice: string | null; customCurrency: string | null; enabled: boolean }>>(
        (acc, offer) => {
          if (!offer.adFormatId || acc.some((entry) => entry.adFormatId === offer.adFormatId)) {
            return acc;
          }

          acc.push({
            adFormatId: offer.adFormatId,
            customPrice: offer.customPrice?.trim() || null,
            customCurrency: offer.customCurrency?.trim() || null,
            enabled: offer.enabled ?? true,
          });
          return acc;
        },
        [],
      )
      : null;

    if (normalizedOffers && normalizedOffers.length === 0) {
      throw new ValidationError('At least one ad format offer is required');
    }

    if (normalizedOffers) {
      const channelFormats = await prisma.adFormat.findMany({
        where: {
          channelId: listing.channelId,
          isActive: true,
        },
        select: { id: true },
      });
      const availableFormatIds = new Set(channelFormats.map((format: any) => format.id));
      const invalidOffer = normalizedOffers.find((offer) => !availableFormatIds.has(offer.adFormatId));
      if (invalidOffer) {
        throw new ValidationError('Ad format not found for this channel');
      }
    }

    const primaryOffer = normalizedOffers
      ? (normalizedOffers.find((offer) => offer.enabled) ?? normalizedOffers[0])
      : null;

    await prisma.$transaction(async (tx) => {
      await tx.listing.update({
        where: { id: listingId },
        data: {
          ...(data.title !== undefined && { title: data.title }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.requirements !== undefined && { requirements: data.requirements }),
          ...(data.restrictions !== undefined && { restrictions: data.restrictions }),
          ...(primaryOffer
            ? {
                adFormatId: primaryOffer.adFormatId,
                customPrice: primaryOffer.customPrice,
                customCurrency: primaryOffer.customCurrency,
              }
            : {
                ...(data.customPrice !== undefined && { customPrice: data.customPrice }),
                ...(data.customCurrency !== undefined && { customCurrency: data.customCurrency }),
              }),
        },
      });

      if (normalizedOffers) {
        await tx.listingFormatOffer.deleteMany({
          where: { listingId },
        });

        await tx.listingFormatOffer.createMany({
          data: normalizedOffers.map((offer) => ({
            listingId,
            adFormatId: offer.adFormatId,
            customPrice: offer.customPrice,
            customCurrency: offer.customCurrency,
            enabled: offer.enabled,
          })),
        });
      } else if (data.customPrice !== undefined || data.customCurrency !== undefined) {
        await tx.listingFormatOffer.upsert({
          where: {
            listingId_adFormatId: {
              listingId,
              adFormatId: listing.adFormatId,
            },
          },
          update: {
            ...(data.customPrice !== undefined && { customPrice: data.customPrice }),
            ...(data.customCurrency !== undefined && { customCurrency: data.customCurrency }),
          },
          create: {
            listingId,
            adFormatId: listing.adFormatId,
            customPrice: data.customPrice ?? null,
            customCurrency: data.customCurrency ?? null,
            enabled: true,
          },
        });
      }
    });

    const updated = await prisma.listing.findUnique({
      where: { id: listingId },
      include: {
        channel: {
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
          },
        },
        adFormat: {
          select: {
            id: true,
            type: true,
            name: true,
            priceAmount: true,
            priceCurrency: true,
          },
        },
        formatOffers: {
          include: {
            adFormat: {
              select: {
                id: true,
                type: true,
                name: true,
                priceAmount: true,
                priceCurrency: true,
              },
            },
          },
          orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }],
        },
        _count: {
          select: { deals: true },
        },
      },
    });

    if (!updated) {
      throw new NotFoundError('Listing');
    }

    res.json({ listing: serializeListing(updated) });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/listings/{id}:
 *   delete:
 *     tags: [Listings]
 *     summary: Remove listing
 *     description: Marks listing as removed (owner only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Listing ID
 *     responses:
 *       200:
 *         description: Listing removed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Not listing owner
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Listing not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete('/:id', telegramAuth, async (req, res, next) => {
  const listingId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  try {
    const listing = await prisma.listing.findUnique({
      where: { id: listingId },
      include: { channel: true },
    });

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    if (listing.channel.ownerId !== req.user!.id) {
      throw new ForbiddenError('Not listing owner');
    }

    await prisma.listing.update({
      where: { id: listingId },
      data: { status: 'REMOVED' },
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
