import { Router } from 'express';
import { telegramAuth } from '../middleware/auth.js';
import { ForbiddenError } from '../middleware/error.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

// Simple admin check - in production, use proper RBAC
const requireAdmin = async (telegramId: bigint) => {
  // Add admin telegram IDs here
  const adminIds = process.env.ADMIN_TELEGRAM_IDS?.split(',').map((id) => BigInt(id)) || [];
  if (!adminIds.includes(telegramId)) {
    throw new ForbiddenError('Admin access required');
  }
};

/**
 * @openapi
 * /api/admin/stats:
 *   get:
 *     tags: [Admin]
 *     summary: Platform statistics
 *     description: Returns comprehensive platform statistics (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 stats:
 *                   type: object
 *                   properties:
 *                     totalUsers:
 *                       type: integer
 *                     totalChannels:
 *                       type: integer
 *                     totalDeals:
 *                       type: integer
 *                     completedDeals:
 *                       type: integer
 *                     activeListings:
 *                       type: integer
 *                     activeBriefs:
 *                       type: integer
 *                     totalVolume:
 *                       type: string
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin access required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/stats', telegramAuth, async (req, res, next) => {
  try {
    await requireAdmin(req.user!.telegramId);

    const [
      totalUsers,
      totalChannels,
      totalDeals,
      completedDealsCount,
      activeListings,
      activeBriefs,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.channel.count({ where: { deletedAt: null } }),
      prisma.deal.count(),
      prisma.deal.count({ where: { status: 'COMPLETED' } }),
      prisma.listing.count({ where: { status: 'ACTIVE' } }),
      prisma.brief.count({ where: { status: 'ACTIVE' } }),
    ]);

    // Calculate total volume from completed deals
    const completedDeals = await prisma.deal.findMany({
      where: { status: 'COMPLETED' },
      select: { agreedPrice: true },
    });
    const totalVolume = completedDeals.reduce(
      (sum: bigint, deal) => sum + BigInt(deal.agreedPrice),
      BigInt(0)
    );

    res.json({
      stats: {
        totalUsers,
        totalChannels,
        totalDeals,
        completedDeals: completedDealsCount,
        activeListings,
        activeBriefs,
        totalVolume: totalVolume.toString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/admin/config:
 *   get:
 *     tags: [Admin]
 *     summary: Get system configuration
 *     description: Returns system configuration settings (admin only)
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 config:
 *                   type: object
 *                   additionalProperties: true
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin access required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/config', telegramAuth, async (req, res, next) => {
  try {
    await requireAdmin(req.user!.telegramId);

    const configs = await prisma.systemConfig.findMany();

    res.json({
      config: Object.fromEntries(configs.map((c: any) => [c.key, c.value])),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/admin/config:
 *   put:
 *     tags: [Admin]
 *     summary: Update system configuration
 *     description: Updates system configuration settings (admin only)
 *     security:
 *       - BearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *             description: Key-value pairs of configuration updates
 *     responses:
 *       200:
 *         description: Configuration updated successfully
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
 *         description: Admin access required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put('/config', telegramAuth, async (req, res, next) => {
  try {
    await requireAdmin(req.user!.telegramId);

    const updates = req.body as Record<string, unknown>;

    for (const [key, value] of Object.entries(updates)) {
      await prisma.systemConfig.upsert({
        where: { key },
        update: { value: value as any },
        create: { key, value: value as any },
      });
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/admin/disputes:
 *   get:
 *     tags: [Admin]
 *     summary: Get open disputes
 *     description: Returns all open disputes requiring admin attention
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Disputes retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 disputes:
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
 *         description: Admin access required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get('/disputes', telegramAuth, async (req, res, next) => {
  try {
    await requireAdmin(req.user!.telegramId);

    const disputes = await prisma.dispute.findMany({
      where: {
        status: { in: ['OPEN', 'UNDER_REVIEW', 'AWAITING_RESPONSE'] },
      },
      include: {
        deal: {
          include: {
            advertiser: {
              select: { id: true, username: true, firstName: true },
            },
            channelOwner: {
              select: { id: true, username: true, firstName: true },
            },
            channel: {
              select: { id: true, username: true, title: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ disputes });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/admin/disputes/{id}/resolve:
 *   post:
 *     tags: [Admin]
 *     summary: Resolve a dispute
 *     description: Resolves a dispute with outcome and fund distribution (admin only)
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Dispute ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - outcome
 *               - resolution
 *             properties:
 *               outcome:
 *                 type: string
 *                 enum: [ADVERTISER_FAVOR, PUBLISHER_FAVOR, SPLIT, REFUND_ALL]
 *                 description: Dispute resolution outcome
 *               resolution:
 *                 type: string
 *                 description: Detailed resolution explanation
 *               advertiserRefundPercent:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 100
 *                 description: Percentage refund to advertiser
 *     responses:
 *       200:
 *         description: Dispute resolved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dispute:
 *                   type: object
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Admin access required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Dispute not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/disputes/:id/resolve', telegramAuth, async (req, res, next) => {
  try {
    await requireAdmin(req.user!.telegramId);

    const { outcome, resolution, advertiserRefundPercent } = req.body;

    const dispute = await prisma.dispute.update({
      where: { id: Array.isArray(req.params.id) ? req.params.id[0] : req.params.id },
      data: {
        status: 'RESOLVED',
        outcome,
        resolution,
        advertiserRefundPercent,
        resolvedBy: req.user!.id,
        resolvedAt: new Date(),
      },
    });

    // TODO: Handle fund distribution based on outcome

    res.json({ dispute });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/admin/categories:
 *   get:
 *     tags: [Admin]
 *     summary: Get all categories
 *     description: Returns all channel categories with hierarchy and channel counts
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
 */
router.get('/categories', async (req, res, next) => {
  try {
    const categories = await prisma.channelCategory.findMany({
      include: {
        children: true,
        _count: {
          select: { channels: true },
        },
      },
      where: { parentId: null },
      orderBy: { name: 'asc' },
    });

    res.json({ categories });
  } catch (error) {
    next(error);
  }
});

export default router;
