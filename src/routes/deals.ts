import { Router } from 'express';
import { z } from 'zod';
import {
  DealChatStatus,
  DealStatus,
  PostingPlanActor,
  PostingPlanMethod,
  PostingPlanProposalStatus,
} from '@prisma/client';
import { telegramAuth } from '../middleware/auth.js';
import { ValidationError, NotFoundError, ForbiddenError } from '../middleware/error.js';
import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';
import { dealService } from '../services/deal/index.js';
import { escrowService } from '../services/escrow/index.js';
import { appEvents, AppEvent } from '../services/events.js';
import { jobQueue, JobType } from '../services/jobs/index.js';
import { openDealChatInPrivateTopic } from '../services/telegram/bot.js';
import { normalizeCurrencyInput, requiredCurrencySchema } from '../lib/currency.js';
import {
  createPresignedS3ReadUrl,
  normalizeCreativeMediaMeta,
  prepareUploads,
  validateSubmittedMediaUrl,
} from '../services/storage/index.js';

const router = Router();

function resolveRequestBaseUrl(req: { headers: Record<string, unknown>; protocol?: string; get?: (name: string) => string | undefined }): string {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedHost = req.headers['x-forwarded-host'];

  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : (typeof forwardedProto === 'string' && forwardedProto.trim()
      ? forwardedProto.split(',')[0].trim()
      : (req.protocol || 'http'));

  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : (typeof forwardedHost === 'string' && forwardedHost.trim()
      ? forwardedHost.split(',')[0].trim()
      : (req.get?.('host') || 'localhost:3000'));

  return `${protocol}://${host}`;
}

function replaceUrlOrigin(urlString: string, newOrigin: string): string {
  try {
    const current = new URL(urlString);
    const base = new URL(newOrigin);
    current.protocol = base.protocol;
    current.host = base.host;
    return current.toString();
  } catch {
    return urlString;
  }
}

function normalizeStorageKey(value: string): string | null {
  const trimmed = value.trim().replace(/^\/+/, '');
  return trimmed ? trimmed : null;
}

function extractS3StorageKeyFromPublicUrl(urlString: string): string | null {
  if (!config.media.s3.publicBaseUrl) {
    return null;
  }

  try {
    const mediaUrl = new URL(urlString);
    const publicBase = new URL(config.media.s3.publicBaseUrl);
    if (mediaUrl.origin.toLowerCase() !== publicBase.origin.toLowerCase()) {
      return null;
    }

    const basePath = publicBase.pathname.replace(/\/+$/, '');
    const prefix = basePath ? `${basePath}/` : '/';
    if (!mediaUrl.pathname.startsWith(prefix)) {
      return null;
    }

    const encodedKey = mediaUrl.pathname.slice(prefix.length);
    if (!encodedKey) {
      return null;
    }

    const decodedKey = encodedKey
      .split('/')
      .filter(Boolean)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      })
      .join('/');

    return normalizeStorageKey(decodedKey);
  } catch {
    return null;
  }
}

function withSignedCreativeMediaUrls(creative: unknown): unknown {
  if (!creative || typeof creative !== 'object') {
    return creative;
  }

  const source = creative as Record<string, unknown>;
  const signCandidate = (candidate: {
    url?: unknown;
    storageKey?: unknown;
    provider?: unknown;
  }): { url: string; storageKey: string } | null => {
    const provider = typeof candidate.provider === 'string' ? candidate.provider.trim().toLowerCase() : '';
    if (provider && provider !== 's3') {
      return null;
    }

    const fromField = typeof candidate.storageKey === 'string'
      ? normalizeStorageKey(candidate.storageKey)
      : null;
    const fromUrl = typeof candidate.url === 'string'
      ? extractS3StorageKeyFromPublicUrl(candidate.url)
      : null;
    const storageKey = fromField || fromUrl;

    if (!storageKey) {
      return null;
    }

    try {
      return {
        url: createPresignedS3ReadUrl(storageKey, config.media.s3.readUrlTtlSeconds),
        storageKey,
      };
    } catch {
      return null;
    }
  };

  let changed = false;

  const signedMedia = Array.isArray(source.media)
    ? source.media.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }

      const mediaItem = item as Record<string, unknown>;
      const signed = signCandidate(mediaItem);
      if (!signed) {
        return item;
      }

      changed = true;
      return {
        ...mediaItem,
        provider: 's3',
        storageKey: signed.storageKey,
        url: signed.url,
      };
    })
    : source.media;

  const signedMediaMeta = Array.isArray(source.mediaMeta)
    ? source.mediaMeta.map((item) => {
      if (!item || typeof item !== 'object') {
        return item;
      }

      const mediaMetaItem = item as Record<string, unknown>;
      const signed = signCandidate(mediaMetaItem);
      if (!signed) {
        return item;
      }

      changed = true;
      return {
        ...mediaMetaItem,
        provider: 's3',
        storageKey: signed.storageKey,
        url: signed.url,
      };
    })
    : source.mediaMeta;

  const signedMediaUrls = Array.isArray(source.mediaUrls)
    ? source.mediaUrls.map((value) => {
      if (typeof value !== 'string') {
        return value;
      }

      const signed = signCandidate({ url: value });
      if (!signed) {
        return value;
      }

      changed = true;
      return signed.url;
    })
    : source.mediaUrls;

  if (!changed) {
    return creative;
  }

  return {
    ...source,
    media: signedMedia,
    mediaMeta: signedMediaMeta,
    mediaUrls: signedMediaUrls,
  };
}

function getSingleParam(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] || '';
  }

  return value || '';
}

function getMultiParam(value: string | string[] | undefined): string[] {
  if (!value) {
    return [];
  }

  const values = Array.isArray(value) ? value : [value];
  const normalized = values
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter(Boolean);

  return Array.from(new Set(normalized));
}

const DEAL_STATUS_SET = new Set<DealStatus>(Object.values(DealStatus));

function parseDealStatuses(value: string | string[] | undefined): DealStatus[] {
  return getMultiParam(value)
    .map((entry) => entry.toUpperCase())
    .filter((entry): entry is DealStatus => DEAL_STATUS_SET.has(entry as DealStatus));
}

const CREATIVE_MEDIA_TYPE_VALUES = ['TEXT', 'IMAGE', 'VIDEO', 'GIF', 'DOCUMENT', 'AUDIO', 'POLL'] as const;
type CreativeMediaTypeValue = typeof CREATIVE_MEDIA_TYPE_VALUES[number];

function extractDealId(params: { id?: string | string[] }): string {
  return Array.isArray(params.id) ? params.id[0] : (params.id || '');
}

function isCreativeSubmissionStatusAllowed(status: DealStatus): boolean {
  return ['FUNDED', 'AWAITING_CREATIVE', 'CREATIVE_REVISION'].includes(status);
}

async function getDealForCreativeMutation(dealId: string, userId: string) {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
  });

  if (!deal) {
    throw new NotFoundError('Deal');
  }

  if (deal.channelOwnerId !== userId) {
    throw new ForbiddenError('Only channel owner can submit creative');
  }

  if (!isCreativeSubmissionStatusAllowed(deal.status)) {
    throw new ValidationError('Cannot submit creative in current status');
  }

  return deal;
}

function getRoleForDeal(deal: { advertiserId: string; channelOwnerId: string }, userId: string): 'advertiser' | 'publisher' | null {
  if (deal.advertiserId === userId) {
    return 'advertiser';
  }
  if (deal.channelOwnerId === userId) {
    return 'publisher';
  }
  return null;
}

function mapProposal(
  proposal: {
    id: string;
    proposedBy: PostingPlanActor;
    method: PostingPlanMethod;
    scheduledAt: Date;
    windowHours: number | null;
    guaranteeTermHours: number;
    status: PostingPlanProposalStatus;
    createdAt: Date;
  },
) {
  return {
    id: proposal.id,
    proposedBy: proposal.proposedBy === 'ADVERTISER' ? 'advertiser' : 'publisher',
    method: proposal.method === 'AUTO' ? 'scheduled' : 'manual',
    date: proposal.scheduledAt.toISOString(),
    windowHours: proposal.windowHours ?? undefined,
    guaranteeTerm: proposal.guaranteeTermHours,
    status: proposal.status.toLowerCase(),
    createdAt: proposal.createdAt.toISOString(),
  };
}

function buildPostingPlanPayload(
  deal: {
    postingMethod: PostingPlanMethod | null;
    scheduledTime: Date | null;
    manualPostWindowHours: number | null;
    postingGuaranteeTermHours: number | null;
    postingPlanProposals?: Array<{
      id: string;
      proposedBy: PostingPlanActor;
      method: PostingPlanMethod;
      scheduledAt: Date;
      windowHours: number | null;
      guaranteeTermHours: number;
      status: PostingPlanProposalStatus;
      createdAt: Date;
    }>;
  },
) {
  const proposals = (deal.postingPlanProposals ?? [])
    .slice()
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(mapProposal);

  return {
    agreedMethod:
      deal.postingMethod === 'AUTO'
        ? 'scheduled'
        : deal.postingMethod === 'MANUAL'
          ? 'manual'
          : undefined,
    agreedDate: deal.scheduledTime ? deal.scheduledTime.toISOString() : undefined,
    windowHours: deal.manualPostWindowHours ?? undefined,
    guaranteeTerm: deal.postingGuaranteeTermHours ?? undefined,
    proposals,
  };
}

const TERMINAL_DEAL_STATUSES = new Set<DealStatus>([
  DealStatus.COMPLETED,
  DealStatus.CANCELLED,
  DealStatus.EXPIRED,
  DealStatus.REFUNDED,
  DealStatus.RESOLVED,
]);

function buildOpenDealChatUrl(dealId: string): string | null {
  const username = config.telegramBotUsername.replace(/^@/, '').trim();
  if (!username) {
    return null;
  }

  return `https://t.me/${username}?start=open_deal_${dealId}`;
}

function buildDealChatPayload(
  deal: {
    id: string;
    status: DealStatus;
    advertiserId: string;
    channelOwnerId: string;
    dealChatBridge?: {
      status: DealChatStatus;
      advertiserThreadId: bigint | null;
      publisherThreadId: bigint | null;
    } | null;
  },
  userId: string,
) {
  const isAdvertiserViewer = deal.advertiserId === userId;
  const isPublisherViewer = deal.channelOwnerId === userId;

  const advertiserOpened = deal.dealChatBridge?.advertiserThreadId !== null
    && deal.dealChatBridge?.advertiserThreadId !== undefined;
  const publisherOpened = deal.dealChatBridge?.publisherThreadId !== null
    && deal.dealChatBridge?.publisherThreadId !== undefined;

  const status = TERMINAL_DEAL_STATUSES.has(deal.status)
    ? DealChatStatus.CLOSED
    : deal.dealChatBridge?.status ?? DealChatStatus.PENDING_OPEN;

  const openedByMe = isAdvertiserViewer
    ? advertiserOpened
    : isPublisherViewer
      ? publisherOpened
      : false;

  const openedByCounterparty = isAdvertiserViewer
    ? publisherOpened
    : isPublisherViewer
      ? advertiserOpened
      : false;

  return {
    status,
    openedByMe,
    openedByCounterparty,
    isOpenable: (isAdvertiserViewer || isPublisherViewer) && status !== DealChatStatus.CLOSED,
  };
}

function shouldRedactAdvertiserForViewer(
  deal: {
    advertiserId: string;
    channelOwnerId: string;
  },
  userId: string,
): boolean {
  return deal.channelOwnerId === userId && deal.advertiserId !== userId;
}

function sanitizeAdvertiserPayload(
  advertiser: {
    id: string;
    username?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    photoUrl?: string | null;
  },
  redact: boolean,
) {
  if (!redact) {
    return advertiser;
  }

  return {
    id: advertiser.id,
    username: null,
    firstName: null,
    lastName: null,
    photoUrl: null,
  };
}

function toOverviewDeal(deal: any, userId: string) {
  const availableActions = dealService.getDealAvailableActions(deal, userId);
  const deadlines = dealService.getDealDeadlineInfo(deal);
  const dealChat = buildDealChatPayload(deal, userId);
  const redactAdvertiser = shouldRedactAdvertiserForViewer(deal, userId);

  return {
    id: deal.id,
    dealNumber: deal.dealNumber,
    origin: deal.origin,
    listingId: deal.listingId,
    briefId: deal.briefId,
    applicationId: deal.applicationId,
    channelId: deal.channelId,
    adFormatId: deal.adFormatId,
    agreedPrice: deal.agreedPrice,
    currency: deal.currency,
    scheduledTime: deal.scheduledTime,
    durationHours: deal.durationHours,
    platformFeeBps: deal.platformFeeBps,
    platformFeeAmount: deal.platformFeeAmount,
    publisherAmount: deal.publisherAmount,
    status: deal.status,
    workflowStatus: deal.status,
    statusHistory: deal.statusHistory,
    escrowStatus: deal.escrowStatus,
    createdAt: deal.createdAt,
    updatedAt: deal.updatedAt,
    expiresAt: deal.expiresAt,
    completedAt: deal.completedAt,
    channel: deal.channel,
    advertiser: sanitizeAdvertiserPayload(deal.advertiser, redactAdvertiser),
    adFormat: deal.adFormat,
    brief: deal.brief,
    dealChat,
    openDealChatUrl: buildOpenDealChatUrl(deal.id),
    availableActions,
    deadlines,
    isAdvertiser: deal.advertiserId === userId,
    isPublisher: deal.channelOwnerId === userId,
  };
}

type DealActivityItemType = 'status' | 'creative' | 'plan' | 'system';

type DealActivityItem = {
  id: string;
  timestamp: string;
  actor: string;
  type: DealActivityItemType;
  title: string;
  detail: string;
};

function toStatusLabel(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function toActivityTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return Number.isFinite(Date.parse(value)) ? value : null;
}

function buildDealActivityPayload(deal: {
  id: string;
  createdAt: Date;
  statusHistory: unknown;
  creative: null | {
    id: string;
    status: string;
    submittedAt: Date | null;
    approvedAt: Date | null;
    updatedAt: Date;
    feedback: string | null;
  };
  postingPlanProposals: Array<{
    id: string;
    proposedBy: PostingPlanActor;
    method: PostingPlanMethod;
    scheduledAt: Date;
    guaranteeTermHours: number;
    status: PostingPlanProposalStatus;
    createdAt: Date;
  }>;
}): DealActivityItem[] {
  const items: DealActivityItem[] = [
    {
      id: `system-created-${deal.id}`,
      timestamp: deal.createdAt.toISOString(),
      actor: 'SYSTEM',
      type: 'system',
      title: 'Deal Created',
      detail: 'Deal was created and entered workflow.',
    },
  ];

  if (Array.isArray(deal.statusHistory)) {
    deal.statusHistory.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        return;
      }

      const candidate = entry as { status?: unknown; timestamp?: unknown; actor?: unknown };
      if (typeof candidate.status !== 'string') {
        return;
      }

      const timestamp = toActivityTimestamp(candidate.timestamp);
      if (!timestamp) {
        return;
      }

      const actor = typeof candidate.actor === 'string' ? candidate.actor : 'SYSTEM';
      items.push({
        id: `status-${deal.id}-${index}-${timestamp}`,
        timestamp,
        actor,
        type: 'status',
        title: `Status: ${toStatusLabel(candidate.status)}`,
        detail: 'Workflow status changed.',
      });
    });
  }

  if (deal.creative) {
    const submittedAt = deal.creative.submittedAt?.toISOString();
    if (submittedAt) {
      items.push({
        id: `creative-submitted-${deal.creative.id}`,
        timestamp: submittedAt,
        actor: 'PUBLISHER',
        type: 'creative',
        title: 'Creative Submitted',
        detail: 'Publisher submitted creative for review.',
      });
    }

    if (deal.creative.feedback) {
      items.push({
        id: `creative-feedback-${deal.creative.id}-${deal.creative.updatedAt.toISOString()}`,
        timestamp: deal.creative.updatedAt.toISOString(),
        actor: 'ADVERTISER',
        type: 'creative',
        title: 'Creative Revision Requested',
        detail: deal.creative.feedback,
      });
    }

    if (deal.creative.approvedAt) {
      items.push({
        id: `creative-approved-${deal.creative.id}`,
        timestamp: deal.creative.approvedAt.toISOString(),
        actor: 'ADVERTISER',
        type: 'creative',
        title: 'Creative Approved',
        detail: 'Creative approved and moved to posting workflow.',
      });
    }
  }

  deal.postingPlanProposals.forEach((proposal) => {
    items.push({
      id: `plan-${proposal.id}`,
      timestamp: proposal.createdAt.toISOString(),
      actor: proposal.proposedBy === PostingPlanActor.ADVERTISER ? 'ADVERTISER' : 'PUBLISHER',
      type: 'plan',
      title: `Posting Plan ${toStatusLabel(proposal.status)}`,
      detail: `Method: ${proposal.method}. Scheduled: ${proposal.scheduledAt.toISOString()}. Guarantee: ${proposal.guaranteeTermHours}h.`,
    });
  });

  return items.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function assertDealPartyAccess(
  deal: { advertiserId: string; channelOwnerId: string },
  userId: string,
): void {
  if (deal.advertiserId !== userId && deal.channelOwnerId !== userId) {
    throw new ForbiddenError('Not a party to this deal');
  }
}

/**
 * @openapi
 * /api/deals:
 *   get:
 *     tags:
 *       - Deals
 *     summary: Get user's deals
 *     description: Retrieve a paginated list of deals where the authenticated user is either the advertiser or channel owner
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [advertiser, publisher]
 *         description: Filter by user role in deals
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *         description: Filter by deal status
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Number of items per page
 *     responses:
 *       200:
 *         description: Successfully retrieved deals
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deals:
 *                   type: array
 *                   items:
 *                     type: object
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     total:
 *                       type: integer
 *                     pages:
 *                       type: integer
 *       400:
 *         description: Invalid query parameters
 *       401:
 *         description: Unauthorized - invalid or missing token
 */
router.get('/', telegramAuth, async (req, res, next) => {
  try {
    const roleValue = getSingleParam(req.query.role as string | string[] | undefined);
    const statusRaw = req.query.status as string | string[] | undefined;
    const pageValue = getSingleParam(req.query.page as string | string[] | undefined) || '1';
    const limitValue = getSingleParam(req.query.limit as string | string[] | undefined) || '20';

    const parsedPage = Math.max(1, parseInt(pageValue, 10) || 1);
    const parsedLimit = Math.min(100, Math.max(1, parseInt(limitValue, 10) || 20));
    const skip = (parsedPage - 1) * parsedLimit;

    const statusFilter = parseDealStatuses(statusRaw);
    if (statusRaw !== undefined && statusFilter.length === 0) {
      throw new ValidationError('Invalid status filter');
    }

    const baseWhere =
      roleValue === 'advertiser'
        ? { advertiserId: req.user!.id }
        : roleValue === 'publisher'
          ? { channelOwnerId: req.user!.id }
          : {
              OR: [
                { advertiserId: req.user!.id },
                { channelOwnerId: req.user!.id },
              ],
            };

    const where = {
      ...baseWhere,
      ...(statusFilter.length > 0 ? { status: { in: statusFilter } } : {}),
    };

    const [deals, total, groupedStatusCounts] = await Promise.all([
      prisma.deal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: parsedLimit,
        select: {
          id: true,
          dealNumber: true,
          origin: true,
          listingId: true,
          briefId: true,
          applicationId: true,
          advertiserId: true,
          channelOwnerId: true,
          channelId: true,
          adFormatId: true,
          agreedPrice: true,
          currency: true,
          scheduledTime: true,
          durationHours: true,
          postingMethod: true,
          postingGuaranteeTermHours: true,
          manualPostWindowHours: true,
          platformFeeBps: true,
          platformFeeAmount: true,
          publisherAmount: true,
          status: true,
          statusHistory: true,
          escrowStatus: true,
          createdAt: true,
          updatedAt: true,
          expiresAt: true,
          completedAt: true,
          dealChatBridge: {
            select: {
              status: true,
              advertiserThreadId: true,
              publisherThreadId: true,
            },
          },
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
            },
          },
          advertiser: {
            select: {
              id: true,
              username: true,
              firstName: true,
              photoUrl: true,
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
          brief: {
            select: {
              id: true,
              title: true,
            },
          },
        },
      }),
      prisma.deal.count({ where }),
      prisma.deal.groupBy({
        by: ['status'],
        where: baseWhere,
        _count: {
          _all: true,
        },
      }),
    ]);

    const statusCounts = Object.values(DealStatus).reduce((acc, status) => {
      acc[status] = 0;
      return acc;
    }, {} as Record<DealStatus, number>);

    groupedStatusCounts.forEach((entry) => {
      statusCounts[entry.status] = entry._count._all;
    });

    res.json({
      deals: deals.map((d: any) => toOverviewDeal(d, req.user!.id)),
      pagination: {
        page: parsedPage,
        limit: parsedLimit,
        total,
        pages: Math.ceil(total / parsedLimit),
      },
      statusCounts,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/deals:
 *   post:
 *     tags:
 *       - Deals
 *     summary: Create a new deal
 *     description: Create a new advertising deal between advertiser and channel owner
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - origin
 *               - channelId
 *               - adFormatId
 *               - agreedPrice
 *               - currency
 *             properties:
 *               origin:
 *                 type: string
 *                 enum: [LISTING, BRIEF, DIRECT]
 *                 description: Origin of the deal
 *               listingId:
 *                 type: string
 *                 description: Listing ID if origin is LISTING
 *               briefId:
 *                 type: string
 *                 description: Brief ID if origin is BRIEF
 *               applicationId:
 *                 type: string
 *                 description: Application ID if origin is BRIEF
 *               channelId:
 *                 type: string
 *                 description: Channel ID for the deal
 *               adFormatId:
 *                 type: string
 *                 description: Ad format ID
 *               agreedPrice:
 *                 type: string
 *                 description: Agreed price for the deal
 *               currency:
 *                 type: string
 *                 description: Deal currency (must be one of configured supported currencies)
 *               scheduledTime:
 *                 type: string
 *                 format: date-time
 *                 description: Scheduled time for the ad
 *               durationHours:
 *                 type: integer
 *                 default: 24
 *                 description: Duration in hours
 *     responses:
 *       201:
 *         description: Deal created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deal:
 *                   type: object
 *       400:
 *         description: Invalid request body or validation error
 *       401:
 *         description: Unauthorized - invalid or missing token
 *       404:
 *         description: Channel or ad format not found
 */
const createDealSchema = z.object({
  origin: z.enum(['LISTING', 'BRIEF', 'DIRECT']),
  listingId: z.string().cuid().optional(),
  briefId: z.string().cuid().optional(),
  applicationId: z.string().cuid().optional(),
  channelId: z.string().cuid(),
  adFormatId: z.string().cuid(),
  agreedPrice: z.string().min(1),
  currency: requiredCurrencySchema,
  scheduledTime: z.string().datetime().optional(),
  durationHours: z.number().int().positive().default(24),
});

router.post('/', telegramAuth, async (req, res, next) => {
  try {
    const data = createDealSchema.parse(req.body);

    // Get channel and verify
    const channel = await prisma.channel.findUnique({
      where: { id: data.channelId },
      include: { owner: true },
    });

    if (!channel || channel.status !== 'ACTIVE') {
      throw new NotFoundError('Channel');
    }

    // Verify ad format
    const adFormat = await prisma.adFormat.findFirst({
      where: { id: data.adFormatId, channelId: data.channelId },
    });

    if (!adFormat) {
      throw new ValidationError('Ad format not found for this channel');
    }

    // Determine parties based on origin
    let advertiserId: string;
    let channelOwnerId: string;

    if (data.origin === 'LISTING') {
      // Advertiser creates deal from listing
      advertiserId = req.user!.id;
      channelOwnerId = channel.ownerId;
    } else if (data.origin === 'BRIEF') {
      // Channel owner's application was accepted
      if (!data.applicationId) {
        throw new ValidationError('Application ID required for brief deals');
      }
      const application = await prisma.briefApplication.findUnique({
        where: { id: data.applicationId },
        include: { brief: true },
      });
      if (!application) {
        throw new NotFoundError('Application');
      }
      advertiserId = application.brief.advertiserId;
      channelOwnerId = channel.ownerId;
    } else {
      // Direct deal
      advertiserId = req.user!.id;
      channelOwnerId = channel.ownerId;
    }

    // Can't create deal with yourself
    if (advertiserId === channelOwnerId) {
      throw new ValidationError('Cannot create deal with yourself');
    }

    // Calculate fees
    const { platformFeeAmount, publisherAmount } = dealService.calculateFees(
      data.agreedPrice,
      config.platformFeeBps,
    );

    // Create deal
    const deal = await prisma.deal.create({
      data: {
        advertiserId,
        channelOwnerId,
        channelId: data.channelId,
        adFormatId: data.adFormatId,
        origin: data.origin,
        listingId: data.listingId,
        briefId: data.briefId,
        applicationId: data.applicationId,
        agreedPrice: data.agreedPrice,
        currency: data.currency,
        scheduledTime: data.scheduledTime ? new Date(data.scheduledTime) : null,
        durationHours: data.durationHours,
        platformFeeBps: config.platformFeeBps,
        platformFeeAmount,
        publisherAmount,
        status: 'CREATED',
        escrowStatus: 'NONE',
        statusHistory: [
          {
            status: 'CREATED',
            timestamp: new Date().toISOString(),
            actor: req.user!.id,
          },
        ],
      },
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

    // Create deal event
    await prisma.dealEvent.create({
      data: {
        dealId: deal.id,
        type: 'DEAL_CREATED',
        actorId: req.user!.id,
        actorType: 'USER',
        toStatus: 'CREATED',
        data: { origin: data.origin },
      },
    });

    await appEvents.emitWithNotification(AppEvent.DEAL_CREATED, {
      dealId: deal.id,
      channelOwnerId: deal.channelOwnerId,
      advertiserId: deal.advertiserId,
    });

    res.status(201).json({
      deal: {
        ...deal,
        workflowStatus: deal.status,
        availableActions: dealService.getDealAvailableActions(deal, req.user!.id),
        deadlines: dealService.getDealDeadlineInfo({
          status: deal.status,
          updatedAt: deal.updatedAt,
          statusHistory: deal.statusHistory,
        }),
        postingPlan: {
          proposals: [],
        },
        dealChat: buildDealChatPayload(
          {
            id: deal.id,
            status: deal.status,
            advertiserId: deal.advertiserId,
            channelOwnerId: deal.channelOwnerId,
            dealChatBridge: null,
          },
          req.user!.id,
        ),
        openDealChatUrl: buildOpenDealChatUrl(deal.id),
        isAdvertiser: deal.advertiserId === req.user!.id,
        isPublisher: deal.channelOwnerId === req.user!.id,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/deals/calculate-fee:
 *   get:
 *     tags:
 *       - Deals
 *     summary: Calculate fee breakdown
 *     description: Calculate platform fee and publisher amount for a given price
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: amount
 *         required: true
 *         schema:
 *           type: string
 *         description: Amount to calculate fees for
 *     responses:
 *       200:
 *         description: Fee breakdown calculated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 amount:
 *                   type: string
 *                 platformFeeBps:
 *                   type: number
 *                 platformFeePercent:
 *                   type: number
 *                 platformFeeAmount:
 *                   type: string
 *                 publisherAmount:
 *                   type: string
 *       400:
 *         description: Amount parameter required
 *       401:
 *         description: Unauthorized - invalid or missing token
 */
router.get('/calculate-fee', telegramAuth, async (req, res) => {
  const { amount } = req.query;

  if (!amount || typeof amount !== 'string') {
    return res.status(400).json({ error: 'Amount required' });
  }

  const fees = dealService.calculateFees(amount, config.platformFeeBps);

  res.json({
    amount,
    platformFeeBps: config.platformFeeBps,
    platformFeePercent: config.platformFeeBps / 100,
    ...fees,
  });
});

/**
 * @openapi
 * /api/deals/{id}:
 *   get:
 *     tags:
 *       - Deals
 *     summary: Get deal details
 *     description: Retrieve detailed information about a specific deal
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Deal ID
 *     responses:
 *       200:
 *         description: Deal details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deal:
 *                   type: object
 *       400:
 *         description: Invalid deal ID
 *       401:
 *         description: Unauthorized - invalid or missing token
 *       403:
 *         description: Forbidden - user is not a party to this deal
 *       404:
 *         description: Deal not found
 */
router.get('/:id', telegramAuth, async (req, res, next) => {
  try {
    const deal = await prisma.deal.findUnique({
      where: { id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id },
      select: {
        id: true,
        dealNumber: true,
        origin: true,
        listingId: true,
        briefId: true,
        applicationId: true,
        advertiserId: true,
        channelOwnerId: true,
        channelId: true,
        adFormatId: true,
        agreedPrice: true,
        currency: true,
        scheduledTime: true,
        durationHours: true,
        postingMethod: true,
        postingGuaranteeTermHours: true,
        manualPostWindowHours: true,
        platformFeeBps: true,
        platformFeeAmount: true,
        publisherAmount: true,
        status: true,
        statusHistory: true,
        escrowStatus: true,
        createdAt: true,
        updatedAt: true,
        expiresAt: true,
        completedAt: true,
        dealChatBridge: {
          select: {
            status: true,
            advertiserThreadId: true,
            publisherThreadId: true,
          },
        },
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
        advertiser: {
          select: {
            id: true,
            username: true,
            firstName: true,
            photoUrl: true,
          },
        },
        brief: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });

    if (!deal) {
      throw new NotFoundError('Deal');
    }

    assertDealPartyAccess(deal, req.user!.id);

    res.json({
      deal: toOverviewDeal(deal, req.user!.id),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/creative', telegramAuth, async (req, res, next) => {
  try {
    const dealId = extractDealId(req.params);
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: {
        id: true,
        status: true,
        advertiserId: true,
        channelOwnerId: true,
        creative: {
          select: {
            id: true,
            text: true,
            mediaUrls: true,
            mediaTypes: true,
            mediaMeta: true,
            buttons: true,
            status: true,
            feedback: true,
            version: true,
            submittedAt: true,
            approvedAt: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!deal) {
      throw new NotFoundError('Deal');
    }

    assertDealPartyAccess(deal, req.user!.id);

    res.json({
      status: deal.status,
      workflowStatus: deal.status,
      creative: withSignedCreativeMediaUrls(deal.creative),
      availableActions: dealService.getDealAvailableActions(deal, req.user!.id),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/finance', telegramAuth, async (req, res, next) => {
  try {
    const dealId = extractDealId(req.params);
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: {
        id: true,
        status: true,
        advertiserId: true,
        channelOwnerId: true,
        agreedPrice: true,
        currency: true,
        platformFeeAmount: true,
        publisherAmount: true,
        escrowStatus: true,
        escrowWallet: {
          select: {
            id: true,
            address: true,
            contractAddress: true,
            isDeployed: true,
            cachedBalance: true,
          },
        },
      },
    });

    if (!deal) {
      throw new NotFoundError('Deal');
    }

    assertDealPartyAccess(deal, req.user!.id);

    res.json({
      status: deal.status,
      workflowStatus: deal.status,
      availableActions: dealService.getDealAvailableActions(deal, req.user!.id),
      finance: {
        agreedPrice: deal.agreedPrice,
        currency: deal.currency,
        platformFeeAmount: deal.platformFeeAmount,
        publisherAmount: deal.publisherAmount,
        escrowStatus: deal.escrowStatus,
        escrowWallet: deal.escrowWallet,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/activity', telegramAuth, async (req, res, next) => {
  try {
    const dealId = extractDealId(req.params);
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: {
        id: true,
        createdAt: true,
        status: true,
        statusHistory: true,
        advertiserId: true,
        channelOwnerId: true,
        creative: {
          select: {
            id: true,
            status: true,
            submittedAt: true,
            approvedAt: true,
            updatedAt: true,
            feedback: true,
          },
        },
        postingPlanProposals: {
          select: {
            id: true,
            proposedBy: true,
            method: true,
            scheduledAt: true,
            guaranteeTermHours: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        disputes: {
          select: {
            id: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });

    if (!deal) {
      throw new NotFoundError('Deal');
    }

    assertDealPartyAccess(deal, req.user!.id);

    const activity = buildDealActivityPayload(deal);
    const disputeSummary = {
      total: deal.disputes.length,
      active: deal.disputes.filter((entry) => entry.status !== 'RESOLVED').length,
    };

    res.json({
      status: deal.status,
      workflowStatus: deal.status,
      activity,
      disputeSummary,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:id/open-chat', telegramAuth, async (req, res, next) => {
  try {
    const dealId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: {
        id: true,
        advertiserId: true,
        channelOwnerId: true,
      },
    });

    if (!deal) {
      throw new NotFoundError('Deal');
    }

    const isParty = deal.advertiserId === req.user!.id || deal.channelOwnerId === req.user!.id;
    if (!isParty) {
      throw new ForbiddenError('Not a party to this deal');
    }

    const opened = await openDealChatInPrivateTopic({
      dealId,
      telegramUserId: req.user!.telegramId,
    });

    res.json({
      ok: true,
      dealId,
      dealChat: {
        status: opened.status,
        openedByMe: true,
        openedByCounterparty: opened.counterpartyThreadId !== null,
        isOpenable: opened.status !== 'CLOSED',
      },
      openDealChatUrl: buildOpenDealChatUrl(dealId),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/deals/{id}/accept:
 *   post:
 *     tags:
 *       - Deals
 *     summary: Accept deal terms
 *     description: Channel owner accepts the terms of the deal
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Deal ID
 *     responses:
 *       200:
 *         description: Deal terms accepted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deal:
 *                   type: object
 *       400:
 *         description: Deal cannot be accepted in current status
 *       401:
 *         description: Unauthorized - invalid or missing token
 *       403:
 *         description: Forbidden - only channel owner can accept
 *       404:
 *         description: Deal not found
 */
router.post('/:id/accept', telegramAuth, async (req, res, next) => {
  try {
    const dealId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
    });

    if (!deal) {
      throw new NotFoundError('Deal');
    }

    // Only channel owner can accept
    if (deal.channelOwnerId !== req.user!.id) {
      throw new ForbiddenError('Only channel owner can accept');
    }

    if (deal.status !== 'CREATED' && deal.status !== 'NEGOTIATING') {
      throw new ValidationError('Deal cannot be accepted in current status');
    }

    const updated = await dealService.updateStatus(
      deal.id,
      'TERMS_AGREED',
      req.user!.id,
      { fromStatus: deal.status },
    );

    res.json({ deal: updated });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/deals/{id}/fund:
 *   post:
 *     tags:
 *       - Deals
 *     summary: Get escrow payment info
 *     description: Deploy or retrieve per-deal escrow contract for payment
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Deal ID
 *     responses:
 *       200:
 *         description: Escrow payment information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 escrow:
 *                   type: object
 *                   properties:
 *                     address:
 *                       type: string
 *                     amount:
 *                       type: string
 *                     reserveAmount:
 *                       type: string
 *                     totalAmount:
 *                       type: string
 *                     currency:
 *                       type: string
 *                     status:
 *                       type: string
 *                 transaction:
 *                   type: object
 *                   properties:
 *                     to:
 *                       type: string
 *                     amountNano:
 *                       type: string
 *                     payload:
 *                       type: string
 *                     stateInit:
 *                       type: string
 *                     deepLink:
 *                       type: string
 *       400:
 *         description: Deal is not awaiting payment
 *       401:
 *         description: Unauthorized - invalid or missing token
 *       403:
 *         description: Forbidden - only advertiser can fund
 *       404:
 *         description: Deal not found
 */
router.post('/:id/fund', telegramAuth, async (req, res, next) => {
  try {
    const dealId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    let deal = await prisma.deal.findUnique({
      where: { id: dealId },
      include: {
        escrowWallet: true,
        advertiser: true,
        channelOwner: true,
      },
    });

    if (!deal) {
      throw new NotFoundError('Deal');
    }

    if (deal.advertiserId !== req.user!.id) {
      throw new ForbiddenError('Only advertiser can fund');
    }

    if (deal.status === 'TERMS_AGREED') {
      await dealService.updateStatus(deal.id, 'AWAITING_PAYMENT', req.user!.id, {
        fromStatus: deal.status,
      });

      deal = await prisma.deal.findUnique({
        where: { id: dealId },
        include: {
          escrowWallet: true,
          advertiser: true,
          channelOwner: true,
        },
      });
    }

    if (!deal || deal.status !== 'AWAITING_PAYMENT') {
      throw new ValidationError('Deal is not awaiting payment');
    }

    const dealCurrency = normalizeCurrencyInput(deal.currency || '');
    if (dealCurrency !== 'TON') {
      throw new ValidationError('Escrow funding currently supports TON deals only');
    }

    // Create or get existing escrow contract
    let escrowWallet = deal.escrowWallet;
    
    if (!escrowWallet) {
      // Type guard: we know these are included from the query above
      const advertiserWallet = (deal as any).advertiser.walletAddress;
      const publisherWallet = (deal as any).channelOwner.walletAddress;
      
      // Validate that both parties have wallet addresses
      if (!advertiserWallet) {
        throw new ValidationError('Advertiser wallet address not set. Please connect your TON wallet first.');
      }
      if (!publisherWallet) {
        throw new ValidationError('Publisher wallet address not set. The channel owner needs to connect their TON wallet.');
      }
      
      // Create new per-deal escrow wallet
      escrowWallet = await escrowService.createDealEscrow({
        dealId: deal.id,
        dealNumber: deal.dealNumber,
        advertiserAddress: advertiserWallet,
        publisherAddress: publisherWallet,
        amount: deal.agreedPrice,
        platformFeeBps: deal.platformFeeBps,
      });

      // Link to deal
      await prisma.deal.update({
        where: { id: deal.id },
        data: {
          escrowWalletId: escrowWallet.id,
          escrowStatus: 'PENDING',
        },
      });
    }

    const fundingTx = await escrowService.getEscrowFundingTransaction(deal.id);

    res.json({
      escrow: {
        address: fundingTx.address,
        amount: fundingTx.expectedAmountTon,
        reserveAmount: fundingTx.reserveAmountTon,
        totalAmount: fundingTx.totalAmountTon,
        currency: deal.currency,
        status: deal.escrowStatus,
      },
      transaction: {
        to: fundingTx.address,
        amountNano: fundingTx.totalAmountNano,
        payload: fundingTx.payload,
        stateInit: fundingTx.stateInit,
        deepLink: fundingTx.deepLink,
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/deals/{id}/verify-payment:
 *   post:
 *     tags:
 *       - Deals
 *     summary: Verify escrow funded
 *     description: Verify that the escrow contract has been funded with the agreed amount
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Deal ID
 *     responses:
 *       200:
 *         description: Escrow funding verification completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 funded:
 *                   type: boolean
 *                   description: Whether the escrow is funded
 *                 invalidFunding:
 *                   type: boolean
 *                 rotation:
 *                   type: object
 *                 nextFundingTransaction:
 *                   type: object
 *                   properties:
 *                     to:
 *                       type: string
 *                     amountNano:
 *                       type: string
 *                     payload:
 *                       type: string
 *                     stateInit:
 *                       type: string
 *                     deepLink:
 *                       type: string
 *                 contractInfo:
 *                   type: object
 *                   properties:
 *                     amount:
 *                       type: string
 *                     platformFee:
 *                       type: string
 *                     publisherAmount:
 *                       type: string
 *                     status:
 *                       type: string
 *                     balance:
 *                       type: string
 *       400:
 *         description: No escrow wallet for this deal
 *       401:
 *         description: Unauthorized - invalid or missing token
 *       403:
 *         description: Forbidden - user is not a party to this deal
 *       404:
 *         description: Deal not found
 */
router.post('/:id/verify-payment', telegramAuth, async (req, res, next) => {
  try {
    const dealId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    // Support dryRun query param for checking status without triggering rotation
    const dryRun = req.query.dryRun === 'true' || req.query.dryRun === '1';
    
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      include: { escrowWallet: true },
    });

    if (!deal) {
      throw new NotFoundError('Deal');
    }

    if (deal.advertiserId !== req.user!.id && deal.channelOwnerId !== req.user!.id) {
      throw new ForbiddenError('Not a party to this deal');
    }

    if (!deal.escrowWallet) {
      throw new ValidationError('No escrow wallet for this deal');
    }

    // Validate first funding transaction (checkOnly when dryRun is true)
    const firstFundingValidation = await escrowService.validateAndRotateFirstFundingTransaction(
      deal.id, 
      { checkOnly: dryRun }
    );
    
    if (!firstFundingValidation.valid) {
      const nextFundingTx = await escrowService.getEscrowFundingTransaction(deal.id);

      return res.json({
        funded: false,
        invalidFunding: true,
        rotation: firstFundingValidation,
        nextFundingTransaction: nextFundingTx
          ? {
              to: nextFundingTx.address,
              amountNano: nextFundingTx.totalAmountNano,
              payload: nextFundingTx.payload,
              stateInit: nextFundingTx.stateInit,
              deepLink: nextFundingTx.deepLink,
            }
          : null,
        contractInfo: null,
      });
    }

    // Check on-chain contract state
    const escrowWallet = (deal as any).escrowWallet;
    const { funded: isFunded, contractInfo } = await escrowService.verifyFunding(
      escrowWallet.contractAddress!,
      deal.agreedPrice
    );

    if (isFunded && contractInfo) {
      await dealService.updateStatus(deal.id, 'FUNDED', req.user!.id, { fromStatus: deal.status });
      
      // Update deal with on-chain amounts
      await prisma.deal.update({
        where: { id: deal.id },
        data: {
          escrowStatus: 'HELD',
          escrowAmount: deal.agreedPrice,
          platformFeeAmount: contractInfo.platformFee,
          publisherAmount: contractInfo.publisherAmount,
        },
      });

      // Update escrow wallet
      await prisma.escrowWallet.update({
        where: { id: escrowWallet.id },
        data: {
          cachedBalance: contractInfo.balance,
          lastSyncedAt: new Date(),
        },
      });

      // Move to awaiting creative
      await dealService.updateStatus(deal.id, 'AWAITING_CREATIVE', 'SYSTEM', {});
    }

    res.json({ 
      funded: isFunded,
      contractInfo: contractInfo ? {
        amount: contractInfo.amount,
        platformFee: contractInfo.platformFee,
        publisherAmount: contractInfo.publisherAmount,
        status: contractInfo.status,
        balance: contractInfo.balance,
      } : null,
    });
  } catch (error) {
    next(error);
  }
});

const prepareCreativeMediaSchema = z.object({
  files: z.array(z.object({
    clientId: z.string().min(1).max(120),
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(255),
    sizeBytes: z.number().int().positive(),
  })),
});

/**
 * @openapi
 * /api/deals/{id}/creative/media/prepare:
 *   post:
 *     tags:
 *       - Deals
 *     summary: Prepare creative media uploads
 *     description: Returns direct upload instructions for creative media files.
 *     security:
 *       - BearerAuth: []
 */
router.post('/:id/creative/media/prepare', telegramAuth, async (req, res, next) => {
  try {
    const data = prepareCreativeMediaSchema.parse(req.body);
    if (data.files.length === 0) {
      throw new ValidationError('At least one file must be provided');
    }

    const uniqueClientIds = new Set(data.files.map((file) => file.clientId));
    if (uniqueClientIds.size !== data.files.length) {
      throw new ValidationError('Each file must have a unique clientId');
    }

    const dealId = extractDealId(req.params);
    const deal = await getDealForCreativeMutation(dealId, req.user!.id);
    const preparedFiles = await prepareUploads(deal.id, data.files);
    const requestBaseUrl = resolveRequestBaseUrl(req);
    const files = preparedFiles.map((entry) => {
      if (entry.provider !== 'local') {
        return entry;
      }

      return {
        ...entry,
        publicUrl: entry.publicUrl ? replaceUrlOrigin(entry.publicUrl, requestBaseUrl) : null,
        upload: {
          ...entry.upload,
          url: replaceUrlOrigin(entry.upload.url, requestBaseUrl),
        },
      };
    });

    res.json({ files });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/deals/{id}/creative:
 *   post:
 *     tags:
 *       - Deals
 *     summary: Submit creative content
 *     description: Channel owner submits creative content for advertiser approval
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Deal ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               text:
 *                 type: string
 *                 description: Creative text content
 *               mediaUrls:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of media URLs
 *               mediaTypes:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [TEXT, IMAGE, VIDEO, GIF, DOCUMENT, AUDIO, POLL]
 *                 description: Array of media types
 *               buttons:
 *                 type: object
 *                 description: Button configuration
 *     responses:
 *       200:
 *         description: Creative submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 creative:
 *                   type: object
 *       400:
 *         description: Invalid request or cannot submit creative in current status
 *       401:
 *         description: Unauthorized - invalid or missing token
 *       403:
 *         description: Forbidden - only channel owner can submit creative
 *       404:
 *         description: Deal not found
 */
const submitCreativeSchema = z.object({
  text: z.string().optional(),
  mediaUrls: z.array(z.string()).optional(),
  mediaTypes: z.array(z.enum(CREATIVE_MEDIA_TYPE_VALUES)).optional(),
  media: z.array(
    z.object({
      url: z.string().url(),
      type: z.enum(CREATIVE_MEDIA_TYPE_VALUES),
      name: z.string().optional(),
      mimeType: z.string().optional(),
      sizeBytes: z.number().int().positive().optional(),
      provider: z.string().optional(),
      storageKey: z.string().optional(),
    }),
  ).optional(),
  buttons: z.any().optional(),
});

router.post('/:id/creative', telegramAuth, async (req, res, next) => {
  try {
    const data = submitCreativeSchema.parse(req.body);
    const dealId = extractDealId(req.params);
    const deal = await getDealForCreativeMutation(dealId, req.user!.id);

    const mediaMetaFromPayload = normalizeCreativeMediaMeta(data.media);
    let mediaUrls: string[];
    let mediaTypes: CreativeMediaTypeValue[];
    let mediaMeta: Array<{
      url: string;
      type: string;
      name?: string;
      mimeType?: string;
      sizeBytes?: number;
      provider?: string;
      storageKey?: string;
    }>;

    if (mediaMetaFromPayload.length > 0) {
      mediaMeta = mediaMetaFromPayload.map((item) => ({
        url: item.url,
        type: item.type,
        name: item.name,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        provider: typeof item.provider === 'string' ? item.provider : undefined,
        storageKey: item.storageKey,
      }));
      mediaUrls = mediaMeta.map((item) => item.url);
      mediaTypes = mediaMeta.map((item) => {
        const normalizedType = item.type.toUpperCase();
        return CREATIVE_MEDIA_TYPE_VALUES.includes(normalizedType as CreativeMediaTypeValue)
          ? (normalizedType as CreativeMediaTypeValue)
          : 'IMAGE';
      });
    } else {
      const fallbackUrls = data.mediaUrls || [];
      const fallbackTypes = data.mediaTypes || [];
      mediaUrls = fallbackUrls;
      mediaTypes = fallbackUrls.map((_, index) => {
        const rawType = fallbackTypes[index] || 'IMAGE';
        const normalizedType = rawType.toUpperCase();
        return CREATIVE_MEDIA_TYPE_VALUES.includes(normalizedType as CreativeMediaTypeValue)
          ? (normalizedType as CreativeMediaTypeValue)
          : 'IMAGE';
      });
      mediaMeta = fallbackUrls.map((url, index) => ({
        url,
        type: mediaTypes[index] || 'IMAGE',
      }));
    }

    mediaMeta.forEach((item) => {
      validateSubmittedMediaUrl(item.url, item.provider || null);
    });

    // Create or update creative
    let creative = await prisma.creative.findUnique({
      where: { dealId: deal.id },
    });

    if (creative) {
      // Save previous version
      const previousVersions = creative.previousVersions as any[];
      previousVersions.push({
        version: creative.version,
        text: creative.text,
        mediaUrls: creative.mediaUrls,
        mediaMeta: creative.mediaMeta,
        updatedAt: creative.updatedAt,
      });

      creative = await prisma.creative.update({
        where: { id: creative.id },
        data: {
          text: data.text,
          mediaUrls,
          mediaTypes,
          mediaMeta,
          buttons: data.buttons,
          version: creative.version + 1,
          previousVersions,
          status: 'SUBMITTED',
          submittedAt: new Date(),
          feedback: null,
        },
      });
    } else {
      creative = await prisma.creative.create({
        data: {
          dealId: deal.id,
          text: data.text,
          mediaUrls,
          mediaTypes,
          mediaMeta,
          buttons: data.buttons,
          status: 'SUBMITTED',
          submittedAt: new Date(),
        },
      });
    }

    await dealService.updateStatus(deal.id, 'CREATIVE_SUBMITTED', req.user!.id, {});

    res.json({ creative });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/deals/{id}/creative/approve:
 *   post:
 *     tags:
 *       - Deals
 *     summary: Approve creative
 *     description: Advertiser approves the submitted creative content
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Deal ID
 *     responses:
 *       200:
 *         description: Creative approved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       400:
 *         description: No creative to approve
 *       401:
 *         description: Unauthorized - invalid or missing token
 *       403:
 *         description: Forbidden - only advertiser can approve creative
 *       404:
 *         description: Deal not found
 */
router.post('/:id/creative/approve', telegramAuth, async (req, res, next) => {
  try {
    const dealId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      include: { creative: true },
    });

    if (!deal) {
      throw new NotFoundError('Deal');
    }

    if (deal.advertiserId !== req.user!.id) {
      throw new ForbiddenError('Only advertiser can approve creative');
    }

    if (deal.status !== 'CREATIVE_SUBMITTED') {
      throw new ValidationError('No creative to approve');
    }

    await prisma.creative.update({
      where: { id: deal.creative!.id },
      data: {
        status: 'APPROVED',
        approvedAt: new Date(),
      },
    });

    const updatedDeal = await dealService.updateStatus(deal.id, 'CREATIVE_APPROVED', req.user!.id, {});
    await dealService.updateStatus(deal.id, 'AWAITING_POSTING_PLAN', req.user!.id, {});

    // Emit event for notifications/observers; scheduling is driven by accepted posting plan.
    if ((updatedDeal as any)._transitioned) {
      appEvents.emit(AppEvent.CREATIVE_APPROVED, {
        dealId: deal.id,
        creativeId: deal.creative!.id,
        advertiserId: deal.advertiserId,
        scheduledTime: deal.scheduledTime || undefined,
      });
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/deals/{id}/creative/revision:
 *   post:
 *     tags:
 *       - Deals
 *     summary: Request creative revision
 *     description: Advertiser requests revision of the submitted creative with feedback
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Deal ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               feedback:
 *                 type: string
 *                 description: Feedback for creative revision
 *     responses:
 *       200:
 *         description: Creative revision requested successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       400:
 *         description: No creative to revise
 *       401:
 *         description: Unauthorized - invalid or missing token
 *       403:
 *         description: Forbidden - only advertiser can request revision
 *       404:
 *         description: Deal not found
 */
router.post('/:id/creative/revision', telegramAuth, async (req, res, next) => {
  try {
    const { feedback } = req.body;

    const dealId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      include: { creative: true },
    });

    if (!deal) {
      throw new NotFoundError('Deal');
    }

    if (deal.advertiserId !== req.user!.id) {
      throw new ForbiddenError('Only advertiser can request revision');
    }

    if (deal.status !== 'CREATIVE_SUBMITTED') {
      throw new ValidationError('No creative to revise');
    }

    await prisma.creative.update({
      where: { id: deal.creative!.id },
      data: {
        status: 'REVISION_REQUESTED',
        feedback,
      },
    });

    await dealService.updateStatus(deal.id, 'CREATIVE_REVISION', req.user!.id, { feedback });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

const createPostingPlanProposalSchema = z.object({
  method: z.enum(['AUTO', 'MANUAL']),
  scheduledAt: z.string().datetime(),
  windowHours: z.number().int().positive().max(168).optional(),
  guaranteeTermHours: z.number().int().positive().max(720).default(48),
});

const respondPostingPlanProposalSchema = z.object({
  action: z.enum(['accept', 'reject', 'counter']),
  counter: createPostingPlanProposalSchema.optional(),
});

/**
 * @openapi
 * /api/deals/{id}/posting-plan:
 *   get:
 *     tags:
 *       - Deals
 *     summary: Get posting plan proposals for a deal
 *     security:
 *       - BearerAuth: []
 */
router.get('/:id/posting-plan', telegramAuth, async (req, res, next) => {
  try {
    const dealId = getSingleParam(req.params.id);
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: {
        id: true,
        advertiserId: true,
        channelOwnerId: true,
        status: true,
        postingMethod: true,
        scheduledTime: true,
        manualPostWindowHours: true,
        postingGuaranteeTermHours: true,
        postingPlanProposals: {
          select: {
            id: true,
            proposedBy: true,
            method: true,
            scheduledAt: true,
            windowHours: true,
            guaranteeTermHours: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!deal) {
      throw new NotFoundError('Deal');
    }

    if (getRoleForDeal(deal, req.user!.id) === null) {
      throw new ForbiddenError('Not a party to this deal');
    }

    res.json({
      postingPlan: buildPostingPlanPayload(deal),
      availableActions: dealService.getDealAvailableActions(deal, req.user!.id),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/deals/{id}/posting-plan/proposals:
 *   post:
 *     tags:
 *       - Deals
 *     summary: Create posting plan proposal
 *     security:
 *       - BearerAuth: []
 */
router.post('/:id/posting-plan/proposals', telegramAuth, async (req, res, next) => {
  try {
    const payload = createPostingPlanProposalSchema.parse(req.body);
    const dealId = getSingleParam(req.params.id);
    const deal = await prisma.deal.findUnique({
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

    const role = getRoleForDeal(deal, req.user!.id);
    if (!role) {
      throw new ForbiddenError('Not a party to this deal');
    }

    if (deal.status !== 'AWAITING_POSTING_PLAN') {
      throw new ValidationError('Posting plan proposals are allowed only in AWAITING_POSTING_PLAN status');
    }

    if (payload.method !== 'AUTO') {
      throw new ValidationError('Only AUTO posting method is supported in this phase');
    }

    const proposedBy = role === 'advertiser' ? PostingPlanActor.ADVERTISER : PostingPlanActor.PUBLISHER;

    await prisma.$transaction([
      prisma.dealPostingPlanProposal.updateMany({
        where: {
          dealId,
          status: PostingPlanProposalStatus.PENDING,
          proposedBy: {
            not: proposedBy,
          },
        },
        data: {
          status: PostingPlanProposalStatus.COUNTERED,
          respondedAt: new Date(),
        },
      }),
      prisma.dealPostingPlanProposal.create({
        data: {
          dealId,
          proposedBy,
          method: PostingPlanMethod.AUTO,
          scheduledAt: new Date(payload.scheduledAt),
          windowHours: payload.windowHours ?? null,
          guaranteeTermHours: payload.guaranteeTermHours,
          status: PostingPlanProposalStatus.PENDING,
        },
      }),
    ]);

    const refreshed = await prisma.deal.findUniqueOrThrow({
      where: { id: dealId },
      select: {
        postingMethod: true,
        scheduledTime: true,
        manualPostWindowHours: true,
        postingGuaranteeTermHours: true,
        postingPlanProposals: {
          select: {
            id: true,
            proposedBy: true,
            method: true,
            scheduledAt: true,
            windowHours: true,
            guaranteeTermHours: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    res.status(201).json({
      postingPlan: buildPostingPlanPayload(refreshed),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/deals/{id}/posting-plan/proposals/{proposalId}/respond:
 *   post:
 *     tags:
 *       - Deals
 *     summary: Respond to posting plan proposal
 *     security:
 *       - BearerAuth: []
 */
router.post('/:id/posting-plan/proposals/:proposalId/respond', telegramAuth, async (req, res, next) => {
  try {
    const payload = respondPostingPlanProposalSchema.parse(req.body);
    const dealId = getSingleParam(req.params.id);
    const proposalId = getSingleParam(req.params.proposalId);

    const proposal = await prisma.dealPostingPlanProposal.findUnique({
      where: { id: proposalId },
      include: {
        deal: {
          include: {
            creative: true,
          },
        },
      },
    });

    if (!proposal || proposal.dealId !== dealId) {
      throw new NotFoundError('Posting plan proposal');
    }

    const role = getRoleForDeal(proposal.deal, req.user!.id);
    if (!role) {
      throw new ForbiddenError('Not a party to this deal');
    }

    const actor = role === 'advertiser' ? PostingPlanActor.ADVERTISER : PostingPlanActor.PUBLISHER;
    if (proposal.proposedBy === actor) {
      throw new ValidationError('You cannot respond to your own proposal');
    }

    if (proposal.status !== PostingPlanProposalStatus.PENDING) {
      throw new ValidationError('Proposal is no longer pending');
    }

    if (payload.action === 'accept') {
      if (proposal.method !== PostingPlanMethod.AUTO) {
        throw new ValidationError('Only AUTO posting method is supported in this phase');
      }

      await prisma.$transaction([
        prisma.dealPostingPlanProposal.update({
          where: { id: proposal.id },
          data: {
            status: PostingPlanProposalStatus.ACCEPTED,
            respondedAt: new Date(),
          },
        }),
        prisma.deal.update({
          where: { id: proposal.dealId },
          data: {
            postingMethod: PostingPlanMethod.AUTO,
            scheduledTime: proposal.scheduledAt,
            postingPlanAgreedAt: new Date(),
            postingGuaranteeTermHours: proposal.guaranteeTermHours,
            manualPostWindowHours: null,
          },
        }),
      ]);

      if (proposal.deal.status === DealStatus.AWAITING_POSTING_PLAN) {
        await dealService.updateStatus(proposal.deal.id, DealStatus.POSTING_PLAN_AGREED, req.user!.id, {
          proposalId: proposal.id,
        });
      }
      await dealService.updateStatus(proposal.deal.id, DealStatus.SCHEDULED, req.user!.id, {
        proposalId: proposal.id,
      });

      if (!proposal.deal.creative?.id) {
        throw new ValidationError('Cannot schedule publish without approved creative');
      }

      const now = Date.now();
      const scheduledTs = proposal.scheduledAt.getTime();
      const delay = Math.max(0, scheduledTs - now);
      await jobQueue.addJob(
        JobType.PUBLISH_POST,
        {
          dealId: proposal.deal.id,
          creativeId: proposal.deal.creative.id,
        },
        {
          delay,
          jobId: `publish:${proposal.deal.id}:${proposal.deal.creative.id}`,
        },
      );
    } else if (payload.action === 'reject') {
      await prisma.dealPostingPlanProposal.update({
        where: { id: proposal.id },
        data: {
          status: PostingPlanProposalStatus.REJECTED,
          respondedAt: new Date(),
        },
      });
    } else {
      if (!payload.counter) {
        throw new ValidationError('Counter payload is required for counter action');
      }
      if (payload.counter.method !== 'AUTO') {
        throw new ValidationError('Only AUTO posting method is supported in this phase');
      }

      await prisma.$transaction([
        prisma.dealPostingPlanProposal.update({
          where: { id: proposal.id },
          data: {
            status: PostingPlanProposalStatus.COUNTERED,
            respondedAt: new Date(),
          },
        }),
        prisma.dealPostingPlanProposal.create({
          data: {
            dealId: proposal.dealId,
            proposedBy: actor,
            method: PostingPlanMethod.AUTO,
            scheduledAt: new Date(payload.counter.scheduledAt),
            windowHours: payload.counter.windowHours ?? null,
            guaranteeTermHours: payload.counter.guaranteeTermHours,
            status: PostingPlanProposalStatus.PENDING,
          },
        }),
      ]);
    }

    const refreshed = await prisma.deal.findUniqueOrThrow({
      where: { id: proposal.dealId },
      select: {
        status: true,
        postingMethod: true,
        scheduledTime: true,
        manualPostWindowHours: true,
        postingGuaranteeTermHours: true,
        postingPlanProposals: {
          select: {
            id: true,
            proposedBy: true,
            method: true,
            scheduledAt: true,
            windowHours: true,
            guaranteeTermHours: true,
            status: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    res.json({
      status: refreshed.status,
      postingPlan: buildPostingPlanPayload(refreshed),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/deals/{id}/cancel:
 *   post:
 *     tags:
 *       - Deals
 *     summary: Cancel deal
 *     description: Cancel a deal (only allowed in certain states)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Deal ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *                 description: Reason for cancellation
 *     responses:
 *       200:
 *         description: Deal cancelled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       400:
 *         description: Deal cannot be cancelled in current status
 *       401:
 *         description: Unauthorized - invalid or missing token
 *       403:
 *         description: Forbidden - user is not a party to this deal
 *       404:
 *         description: Deal not found
 */
router.post('/:id/cancel', telegramAuth, async (req, res, next) => {
  try {
    const { reason } = req.body;

    const dealId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
    });

    if (!deal) {
      throw new NotFoundError('Deal');
    }

    if (deal.advertiserId !== req.user!.id && deal.channelOwnerId !== req.user!.id) {
      throw new ForbiddenError('Not a party to this deal');
    }

    // Can only cancel in certain states
    const cancellableStates = [
      'CREATED',
      'NEGOTIATING',
      'TERMS_AGREED',
      'AWAITING_PAYMENT',
    ];

    if (!cancellableStates.includes(deal.status)) {
      throw new ValidationError('Deal cannot be cancelled in current status');
    }

    await dealService.updateStatus(deal.id, 'CANCELLED', req.user!.id, { reason });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
