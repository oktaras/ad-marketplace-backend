import { Router } from 'express';
import { z } from 'zod';
import { telegramAuth } from '../middleware/auth.js';
import { prisma } from '../lib/prisma.js';
import { NotFoundError, ValidationError } from '../middleware/error.js';
import {
  buildNotificationSettingsCatalog,
  projectUserNotificationSettings,
} from '../services/notifications/preferences.js';
import {
  disconnectUserTelegramAuth,
  getUserTelegramAuthStatus,
  startUserTelegramAuth,
  submitUserTelegramAuthCode,
  submitUserTelegramAuthPassword,
} from '../services/telegram/userAuth.js';

const router = Router();

const userNotificationSettingsUpdateSchema = z.object({
  advertiserMessages: z.boolean().optional(),
  publisherMessages: z.boolean().optional(),
  paymentMessages: z.boolean().optional(),
  systemMessages: z.boolean().optional(),
}).strict();

/**
 * @openapi
 * /api/users/me:
 *   get:
 *     tags: [Users]
 *     summary: Get current user profile
 *     description: Returns the authenticated user's complete profile and statistics
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   $ref: '#/components/schemas/User'
 *                 notificationSettingsCatalog:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       key:
 *                         type: string
 *                       title:
 *                         type: string
 *                       description:
 *                         type: string
 *                       templateIds:
 *                         type: array
 *                         items:
 *                           type: string
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/me', telegramAuth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user!.id },
    include: {
      _count: {
        select: {
          ownedChannels: true,
          advertiserDeals: true,
          channelOwnerDeals: true,
          briefs: true,
        },
      },
    },
  });

  res.json({
    user: {
      id: user!.id,
      telegramId: user!.telegramId.toString(),
      username: user!.username,
      firstName: user!.firstName,
      lastName: user!.lastName,
      languageCode: user!.languageCode,
      isPremium: user!.isPremium,
      photoUrl: user!.photoUrl,
      isAdvertiser: user!.isAdvertiser,
      isChannelOwner: user!.isChannelOwner,
      walletAddress: user!.walletAddress,
      onboardingCompleted: !!user!.onboardingCompletedAt,
      notificationSettings: projectUserNotificationSettings(user!),
      createdAt: user!.createdAt,
      stats: {
        channels: user!._count.ownedChannels,
        dealsAsAdvertiser: user!._count.advertiserDeals,
        dealsAsPublisher: user!._count.channelOwnerDeals,
        briefs: user!._count.briefs,
      },
    },
    notificationSettingsCatalog: buildNotificationSettingsCatalog(),
  });
});

/**
 * @openapi
 * /api/users/me:
 *   put:
 *     tags: [Users]
 *     summary: Update current user profile
 *     description: Updates the authenticated user's profile settings
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               isAdvertiser:
 *                 type: boolean
 *                 description: Set user as advertiser
 *               isChannelOwner:
 *                 type: boolean
 *                 description: Set user as channel owner
 *               languageCode:
 *                 type: string
 *                 description: User's preferred language
 *               notificationSettings:
 *                 type: object
 *                 properties:
 *                   advertiserMessages:
 *                     type: boolean
 *                   publisherMessages:
 *                     type: boolean
 *                   paymentMessages:
 *                     type: boolean
 *                   systemMessages:
 *                     type: boolean
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/me', telegramAuth, async (req, res, next) => {
  try {
    const { isAdvertiser, isChannelOwner, languageCode, notificationSettings } = req.body;
    const currentUser = req.user!;

    // If both flags are provided, user must keep at least one role enabled.
    if (typeof isAdvertiser === 'boolean' && typeof isChannelOwner === 'boolean') {
      if (!isAdvertiser && !isChannelOwner) {
        return res.status(400).json({ error: 'User must have at least one role' });
      }
    }

    let parsedNotificationSettings: z.infer<typeof userNotificationSettingsUpdateSchema> | undefined;
    if (notificationSettings !== undefined) {
      const parseResult = userNotificationSettingsUpdateSchema.safeParse(notificationSettings);
      if (!parseResult.success) {
        throw new ValidationError('Invalid notificationSettings payload');
      }
      parsedNotificationSettings = parseResult.data;
    }

    const nextIsAdvertiser = typeof isAdvertiser === 'boolean' ? isAdvertiser : currentUser.isAdvertiser;
    const nextIsChannelOwner = typeof isChannelOwner === 'boolean' ? isChannelOwner : currentUser.isChannelOwner;
    const shouldMarkOnboardingCompletedAt =
      (nextIsAdvertiser || nextIsChannelOwner) && !currentUser.onboardingCompletedAt;

    const user = await prisma.user.update({
      where: { id: currentUser.id },
      data: {
        ...(typeof isAdvertiser === 'boolean' && { isAdvertiser }),
        ...(typeof isChannelOwner === 'boolean' && { isChannelOwner }),
        ...(languageCode && { languageCode }),
        ...(typeof parsedNotificationSettings?.advertiserMessages === 'boolean' && {
          notifyAdvertiserMessages: parsedNotificationSettings.advertiserMessages,
        }),
        ...(typeof parsedNotificationSettings?.publisherMessages === 'boolean' && {
          notifyPublisherMessages: parsedNotificationSettings.publisherMessages,
        }),
        ...(typeof parsedNotificationSettings?.paymentMessages === 'boolean' && {
          notifyPaymentMessages: parsedNotificationSettings.paymentMessages,
        }),
        ...(typeof parsedNotificationSettings?.systemMessages === 'boolean' && {
          notifySystemMessages: parsedNotificationSettings.systemMessages,
        }),
        ...(shouldMarkOnboardingCompletedAt && { onboardingCompletedAt: new Date() }),
      },
    });

    res.json({
      user: {
        id: user.id,
        isAdvertiser: user.isAdvertiser,
        isChannelOwner: user.isChannelOwner,
        languageCode: user.languageCode,
        onboardingCompleted: !!user.onboardingCompletedAt,
        notificationSettings: projectUserNotificationSettings(user),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/users/complete-onboarding:
 *   post:
 *     tags: [Users]
 *     summary: Complete user onboarding with role selection
 *     description: Sets user roles and marks onboarding as completed
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - isAdvertiser
 *               - isChannelOwner
 *             properties:
 *               isAdvertiser:
 *                 type: boolean
 *               isChannelOwner:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Onboarding completed successfully
 */
router.post('/complete-onboarding', telegramAuth, async (req, res, next) => {
  try {
    const { isAdvertiser, isChannelOwner } = req.body;

    // At least one role must be selected
    if (!isAdvertiser && !isChannelOwner) {
      return res.status(400).json({ error: 'At least one role must be selected' });
    }

    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        isAdvertiser: !!isAdvertiser,
        isChannelOwner: !!isChannelOwner,
        onboardingCompletedAt: new Date(),
      },
    });

    res.json({
      user: {
        id: user.id,
        telegramId: user.telegramId.toString(),
        username: user.username,
        firstName: user.firstName,
        lastName: user.lastName,
        isAdvertiser: user.isAdvertiser,
        isChannelOwner: user.isChannelOwner,
        onboardingCompleted: true,
      },
    });
  } catch (error) {
    next(error);
  }
});

const userTelegramStartSchema = z.object({
  phoneNumber: z.string().trim().min(7).max(32),
  forceSms: z.boolean().optional().default(false),
});

const userTelegramCodeSchema = z.object({
  code: z.string().trim().min(3).max(16),
});

const userTelegramPasswordSchema = z.object({
  password: z.string().min(1).max(256),
});

/**
 * @openapi
 * /api/users/telegram-auth/status:
 *   get:
 *     tags: [Users]
 *     summary: Get Telegram account connection status
 *     description: Returns MTProto user session status for the authenticated user
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Telegram auth status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 telegramAuth:
 *                   type: object
 *       401:
 *         description: Unauthorized
 */
router.get('/telegram-auth/status', telegramAuth, async (req, res, next) => {
  try {
    const status = await getUserTelegramAuthStatus(req.user!.id);
    res.json({ telegramAuth: status });
  } catch (error: any) {
    next(new ValidationError(error?.message || 'Failed to load Telegram auth status'));
  }
});

/**
 * @openapi
 * /api/users/telegram-auth/start:
 *   post:
 *     tags: [Users]
 *     summary: Start Telegram account connection
 *     description: Sends verification code via Telegram app or SMS
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - phoneNumber
 *             properties:
 *               phoneNumber:
 *                 type: string
 *               forceSms:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Verification code request result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 telegramAuth:
 *                   type: object
 *       400:
 *         description: Invalid input or request failed
 */
router.post('/telegram-auth/start', telegramAuth, async (req, res, next) => {
  try {
    const data = userTelegramStartSchema.parse(req.body);
    const result = await startUserTelegramAuth({
      userId: req.user!.id,
      phoneNumber: data.phoneNumber,
      forceSms: data.forceSms,
    });

    res.json({
      message: data.forceSms
        ? result.deliveryMethod === 'SMS'
          ? 'SMS verification code sent.'
          : 'SMS delivery is not available right now. Verification code was sent to Telegram app (chat 777000).'
        : result.deliveryMethod === 'TELEGRAM_APP'
          ? 'Verification code sent to Telegram app (chat 777000).'
          : 'Verification code sent by SMS.',
      telegramAuth: result,
    });
  } catch (error: any) {
    next(new ValidationError(error?.message || 'Failed to start Telegram authentication'));
  }
});

/**
 * @openapi
 * /api/users/telegram-auth/code:
 *   post:
 *     tags: [Users]
 *     summary: Submit Telegram verification code
 *     description: Verifies code and may transition to password-required state
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - code
 *             properties:
 *               code:
 *                 type: string
 *     responses:
 *       200:
 *         description: Code verification result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 telegramAuth:
 *                   type: object
 *       400:
 *         description: Invalid or expired code
 */
router.post('/telegram-auth/code', telegramAuth, async (req, res, next) => {
  try {
    const data = userTelegramCodeSchema.parse(req.body);
    const result = await submitUserTelegramAuthCode({
      userId: req.user!.id,
      code: data.code,
    });

    res.json({
      message:
        result.status === 'PENDING_PASSWORD'
          ? '2FA password required to complete login.'
          : 'Telegram account connected successfully.',
      telegramAuth: result,
    });
  } catch (error: any) {
    next(new ValidationError(error?.message || 'Failed to verify code'));
  }
});

/**
 * @openapi
 * /api/users/telegram-auth/password:
 *   post:
 *     tags: [Users]
 *     summary: Submit Telegram 2FA password
 *     description: Completes Telegram account connection when password is required
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Password accepted, Telegram account connected
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                 telegramAuth:
 *                   type: object
 *       400:
 *         description: Invalid password or session state
 */
router.post('/telegram-auth/password', telegramAuth, async (req, res, next) => {
  try {
    const data = userTelegramPasswordSchema.parse(req.body);
    const result = await submitUserTelegramAuthPassword({
      userId: req.user!.id,
      password: data.password,
    });

    res.json({
      message: 'Telegram account connected successfully.',
      telegramAuth: result,
    });
  } catch (error: any) {
    next(new ValidationError(error?.message || 'Failed to verify 2FA password'));
  }
});

/**
 * @openapi
 * /api/users/telegram-auth/disconnect:
 *   post:
 *     tags: [Users]
 *     summary: Disconnect Telegram account session
 *     description: Removes stored MTProto session for the authenticated user
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Telegram account disconnected
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *       400:
 *         description: Disconnect failed
 */
router.post('/telegram-auth/disconnect', telegramAuth, async (req, res, next) => {
  try {
    await disconnectUserTelegramAuth({ userId: req.user!.id });
    res.json({ message: 'Telegram account disconnected' });
  } catch (error: any) {
    next(new ValidationError(error?.message || 'Failed to disconnect Telegram account'));
  }
});

/**
 * @openapi
 * /api/users/{id}:
 *   get:
 *     tags: [Users]
 *     summary: Get public user profile
 *     description: Returns public information about a user including reviews and ratings
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *     responses:
 *       200:
 *         description: User profile retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 user:
 *                   type: object
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/:id', async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        photoUrl: true,
        isAdvertiser: true,
        isChannelOwner: true,
        createdAt: true,
        receivedReviews: {
          where: { isPublic: true },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            rating: true,
            comment: true,
            createdAt: true,
            author: {
              select: {
                id: true,
                username: true,
                firstName: true,
                photoUrl: true,
              },
            },
          },
        },
        _count: {
          select: {
            receivedReviews: { where: { isPublic: true } },
          },
        },
      },
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    // Calculate average rating
    const avgRating = await prisma.review.aggregate({
      where: { targetId: user.id, isPublic: true },
      _avg: { rating: true },
    });

    res.json({
      user: {
        ...user,
        avgRating: avgRating._avg.rating,
        reviewCount: user._count.receivedReviews,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/users/{id}/reviews:
 *   get:
 *     tags: [Users]
 *     summary: Get user's reviews
 *     description: Returns paginated list of reviews for a specific user
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
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
 *     responses:
 *       200:
 *         description: Reviews retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 reviews:
 *                   type: array
 *                   items:
 *                     type: object
 *                 pagination:
 *                   type: object
 */
router.get('/:id/reviews', async (req, res, next) => {
  try {
    const { page = '1', limit = '20' } = req.query;
    const skip = (parseInt(page as string) - 1) * parseInt(limit as string);

    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where: { targetId: req.params.id, isPublic: true },
        orderBy: { createdAt: 'desc' },
        skip,
        take: parseInt(limit as string),
        include: {
          author: {
            select: {
              id: true,
              username: true,
              firstName: true,
              photoUrl: true,
            },
          },
          deal: {
            select: {
              id: true,
              dealNumber: true,
            },
          },
        },
      }),
      prisma.review.count({
        where: { targetId: req.params.id, isPublic: true },
      }),
    ]);

    res.json({
      reviews,
      pagination: {
        page: parseInt(page as string),
        limit: parseInt(limit as string),
        total,
        pages: Math.ceil(total / parseInt(limit as string)),
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;
