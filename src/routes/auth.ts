import { Router } from 'express';
import { z } from 'zod';
import { telegramAuth, generateToken } from '../middleware/auth.js';
import { ValidationError } from '../middleware/error.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

/**
 * @openapi
 * /api/auth/telegram:
 *   post:
 *     tags: [Auth]
 *     summary: Authenticate via Telegram Mini App
 *     description: Authenticates a user using Telegram Mini App init data and returns a JWT token
 *     security:
 *       - TelegramAuth: []
 *     responses:
 *       200:
 *         description: Successfully authenticated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                   description: JWT authentication token
 *                 user:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     telegramId:
 *                       type: string
 *                     username:
 *                       type: string
 *                       nullable: true
 *                     firstName:
 *                       type: string
 *                       nullable: true
 *                     lastName:
 *                       type: string
 *                       nullable: true
 *                     isAdvertiser:
 *                       type: boolean
 *                     isChannelOwner:
 *                       type: boolean
 *       401:
 *         description: Invalid or missing Telegram init data
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/telegram', telegramAuth, async (req, res) => {
  const user = req.user!;
  
  const token = generateToken(user.id);
  
  res.json({
    token,
    user: {
      id: user.id,
      telegramId: user.telegramId.toString(),
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      languageCode: user.languageCode,
      photoUrl: user.photoUrl,
      walletAddress: user.walletAddress,
      isAdvertiser: user.isAdvertiser,
      isChannelOwner: user.isChannelOwner,
      onboardingCompleted: !!user.onboardingCompletedAt,
    },
  });
});

/**
 * @openapi
 * /api/auth/wallet/connect:
 *   post:
 *     tags: [Auth]
 *     summary: Connect TON wallet to user account
 *     description: Links a TON wallet address to the authenticated user's account
 *     security:
 *       - TelegramAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - address
 *             properties:
 *               address:
 *                 type: string
 *                 description: TON wallet address
 *                 example: "EQD..."
 *               publicKey:
 *                 type: string
 *                 description: Wallet public key
 *     responses:
 *       200:
 *         description: Wallet successfully connected
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 wallet:
 *                   type: object
 *                   properties:
 *                     address:
 *                       type: string
 *                     connectedAt:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Invalid request or wallet already connected
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
const connectWalletSchema = z.object({
  address: z.string().min(1),
  publicKey: z.string().optional(),
});

router.post('/wallet/connect', telegramAuth, async (req, res, next) => {
  try {
    const { address: rawAddress } = connectWalletSchema.parse(req.body);
    const user = req.user!;
    const address = rawAddress.trim();

    if (!address) {
      throw new ValidationError('Wallet address is required');
    }

    const existingUser = await prisma.user.findFirst({
      where: {
        walletAddress: address,
        id: { not: user.id },
      },
      select: { id: true },
    });

    if (existingUser) {
      throw new ValidationError('Wallet already connected to another account');
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        walletAddress: address,
        walletConnectedAt: new Date(),
      },
      select: {
        walletAddress: true,
        walletConnectedAt: true,
      },
    });

    res.json({
      wallet: {
        address: updatedUser.walletAddress,
        connectedAt: updatedUser.walletConnectedAt?.toISOString() ?? null,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @openapi
 * /api/auth/wallet/{address}:
 *   delete:
 *     tags: [Auth]
 *     summary: Disconnect a wallet from user account
 *     description: Removes the wallet connection from the authenticated user's account
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema:
 *           type: string
 *         description: TON wallet address to disconnect
 *     responses:
 *       200:
 *         description: Wallet disconnected successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *       400:
 *         description: Wallet not found
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
router.delete('/wallet/:address', telegramAuth, async (req, res, next) => {
  try {
    const addressParam = typeof req.params.address === 'string' ? req.params.address : req.params.address[0];
    const user = req.user!;
    const requestedAddress = addressParam.trim();
    const linkedAddress = user.walletAddress?.trim() ?? null;

    if (!requestedAddress || !linkedAddress || linkedAddress.toLowerCase() !== requestedAddress.toLowerCase()) {
      throw new ValidationError('Wallet not found');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        walletAddress: null,
        walletConnectedAt: null,
      },
    });

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

export default router;
