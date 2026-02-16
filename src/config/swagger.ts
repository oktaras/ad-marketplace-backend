import swaggerJSDoc from 'swagger-jsdoc';
import path from 'path';
import { fileURLToPath } from 'url';

const swaggerDefinition = {
  openapi: '3.0.0',
  info: {
    title: 'Ads Marketplace API',
    version: '1.0.0',
    description: 'API documentation for the Ads Marketplace platform - connecting advertisers with channel owners on Telegram',
    contact: {
      name: 'API Support',
    },
  },
  servers: [
    {
      // Use same-origin to avoid http/https mismatch in Swagger "Try it out".
      // This keeps docs working both for local HTTP and local HTTPS cert mode.
      url: '/',
      description: 'Current server origin',
    },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT authorization token',
      },
      TelegramAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'X-Telegram-Init-Data',
        description: 'Telegram Mini App init data',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            description: 'Error message',
          },
          details: {
            type: 'object',
            description: 'Additional error details',
          },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          telegramId: { type: 'string' },
          username: { type: 'string', nullable: true },
          firstName: { type: 'string', nullable: true },
          lastName: { type: 'string', nullable: true },
          languageCode: { type: 'string', nullable: true },
          isPremium: { type: 'boolean' },
          photoUrl: { type: 'string', nullable: true },
          isAdvertiser: { type: 'boolean' },
          isChannelOwner: { type: 'boolean' },
          walletAddress: { type: 'string', nullable: true },
          onboardingCompleted: { type: 'boolean' },
          stats: {
            type: 'object',
            properties: {
              channels: { type: 'integer' },
              dealsAsAdvertiser: { type: 'integer' },
              dealsAsPublisher: { type: 'integer' },
              briefs: { type: 'integer' },
            },
          },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Channel: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          telegramChatId: { type: 'string' },
          title: { type: 'string' },
          username: { type: 'string', nullable: true },
          description: { type: 'string', nullable: true },
          language: { type: 'string' },
          status: { type: 'string', enum: ['PENDING', 'ACTIVE', 'PAUSED', 'SUSPENDED', 'REMOVED'] },
          isVerified: { type: 'boolean' },
          categories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                slug: { type: 'string' },
                name: { type: 'string' },
                icon: { type: 'string', nullable: true },
              },
            },
          },
          stats: {
            type: 'object',
            nullable: true,
            properties: {
              subscribers: { type: 'integer' },
              avgViews: { type: 'integer', nullable: true },
              engagementRate: { type: 'number', nullable: true },
            },
          },
          formats: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                name: { type: 'string' },
                priceAmount: { type: 'string' },
                priceCurrency: { type: 'string' },
              },
            },
          },
          ownerId: { type: 'string' },
          completedDeals: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Listing: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          channelId: { type: 'string' },
          adFormatId: { type: 'string' },
          priceNanoTon: { type: 'string' },
          isActive: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Brief: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          advertiserId: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          adFormatTypes: { type: 'array', items: { type: 'string' } },
          customFormatDescription: { type: 'string', nullable: true },
          channelsLimit: { type: 'integer', nullable: true },
          targetCategories: { type: 'array', items: { type: 'string' } },
          targetLanguages: { type: 'array', items: { type: 'string' } },
          minSubscribers: { type: 'integer', nullable: true },
          maxSubscribers: { type: 'integer', nullable: true },
          minAvgViews: { type: 'integer', nullable: true },
          budgetMin: { type: 'string', nullable: true },
          budgetMax: { type: 'string', nullable: true },
          totalBudget: { type: 'string', nullable: true },
          currency: { type: 'string' },
          desiredStartDate: { type: 'string', format: 'date-time', nullable: true },
          desiredEndDate: { type: 'string', format: 'date-time', nullable: true },
          flexibility: { type: 'string', enum: ['STRICT', 'FLEXIBLE', 'ANYTIME'] },
          hasCreative: { type: 'boolean' },
          creativeGuidelines: { type: 'string', nullable: true },
          applicationCount: { type: 'integer', nullable: true },
          status: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Deal: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          dealNumber: { type: 'integer' },
          origin: { type: 'string', enum: ['LISTING', 'BRIEF', 'DIRECT'] },
          channelId: { type: 'string' },
          advertiserId: { type: 'string' },
          channelOwnerId: { type: 'string' },
          adFormatId: { type: 'string' },
          briefId: { type: 'string', nullable: true },
          agreedPrice: { type: 'string' },
          currency: { type: 'string' },
          scheduledTime: { type: 'string', format: 'date-time', nullable: true },
          durationHours: { type: 'integer', nullable: true },
          isAdvertiser: { type: 'boolean' },
          isPublisher: { type: 'boolean' },
          channel: { type: 'object', nullable: true, additionalProperties: true },
          advertiser: { type: 'object', nullable: true, additionalProperties: true },
          channelOwner: { type: 'object', nullable: true, additionalProperties: true },
          adFormat: { type: 'object', nullable: true, additionalProperties: true },
          status: {
            type: 'string',
            enum: [
              'CREATED',
              'NEGOTIATING',
              'TERMS_AGREED',
              'AWAITING_PAYMENT',
              'FUNDED',
              'AWAITING_CREATIVE',
              'CREATIVE_SUBMITTED',
              'CREATIVE_REVISION',
              'CREATIVE_APPROVED',
              'AWAITING_POSTING_PLAN',
              'POSTING_PLAN_AGREED',
              'SCHEDULED',
              'AWAITING_MANUAL_POST',
              'POSTING',
              'POSTED',
              'VERIFIED',
              'COMPLETED',
              'DISPUTED',
              'RESOLVED',
              'CANCELLED',
              'REFUNDED',
              'EXPIRED',
            ],
          },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  tags: [
    { name: 'Auth', description: 'Authentication endpoints' },
    { name: 'Users', description: 'User management' },
    { name: 'Channels', description: 'Channel management' },
    { name: 'Listings', description: 'Ad listings' },
    { name: 'Briefs', description: 'Advertiser briefs' },
    { name: 'Deals', description: 'Deal management' },
    { name: 'Admin', description: 'Admin operations' },
  ],
};

function buildApiGlobs(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const cwd = process.cwd();

  // Support both:
  // 1) service root = backend/ (cwd points to backend)
  // 2) monorepo root deploys (cwd points to repo root, backend is nested)
  const baseDirs = new Set([
    cwd,
    path.resolve(cwd, 'backend'),
    path.resolve(moduleDir, '../..'),
    path.resolve(moduleDir, '../../..'),
  ]);

  const globs: string[] = [];
  for (const baseDir of baseDirs) {
    globs.push(path.join(baseDir, 'src/routes/*.ts'));
    globs.push(path.join(baseDir, 'src/routes/*.js'));
    globs.push(path.join(baseDir, 'dist/routes/*.js'));
  }

  return globs;
}

const options: swaggerJSDoc.Options = {
  swaggerDefinition,
  apis: buildApiGlobs(),
};

export const swaggerSpec = swaggerJSDoc(options);
