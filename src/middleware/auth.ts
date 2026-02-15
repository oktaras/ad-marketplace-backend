import { Request, Response, NextFunction } from 'express';
import { validate, parse } from '@telegram-apps/init-data-node';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { UnauthorizedError } from './error.js';
import { prisma } from '../lib/prisma.js';

export interface AuthUser {
  id: string;
  telegramId: bigint;
  username: string | null;
  firstName: string;
  lastName: string | null;
  languageCode: string | null;
  photoUrl: string | null;
  walletAddress: string | null;
  isAdvertiser: boolean;
  isChannelOwner: boolean;
  onboardingCompletedAt: Date | null;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      telegramInitData?: ReturnType<typeof parse>;
    }
  }
}

/**
 * Validate Telegram Mini App init data
 */
export async function telegramAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const initData = req.headers['x-telegram-init-data'] as string;
    
    if (!initData) {
      throw new UnauthorizedError('Missing Telegram init data');
    }

    // Validate init data signature
    try {
      validate(initData, config.telegramBotToken, {
        expiresIn: 3600, // 1 hour
      });
    } catch {
      throw new UnauthorizedError('Invalid Telegram init data');
    }

    // Parse init data
    let parsed: any;
    try {
      parsed = parse(initData);
    } catch {
      throw new UnauthorizedError('Invalid Telegram init data payload');
    }
    
    if (!parsed.user) {
      throw new UnauthorizedError('No user in init data');
    }

    req.telegramInitData = parsed as any;

    // Find or create user
    const telegramUser = parsed.user;
    const telegramUserId = (telegramUser as any).id;

    if (telegramUserId === undefined || telegramUserId === null) {
      throw new UnauthorizedError('Invalid Telegram user payload');
    }
    
    let user = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramUserId) },
    });

    if (!user) {
      // Create new user
      user = await prisma.user.create({
        data: {
          telegramId: BigInt(telegramUserId),
          username: telegramUser.username || null,
          firstName: (telegramUser as any).firstName || (telegramUser as any).first_name || 'User',
          lastName: (telegramUser as any).lastName || (telegramUser as any).last_name || null,
          languageCode: (telegramUser as any).languageCode || (telegramUser as any).language_code || 'en',
          isPremium: (telegramUser as any).isPremium || (telegramUser as any).is_premium || false,
          photoUrl: (telegramUser as any).photoUrl || (telegramUser as any).photo_url || null,
        },
      });
    } else {
      // Update last active
      await prisma.user.update({
        where: { id: user.id },
        data: {
          lastActiveAt: new Date(),
          username: telegramUser.username || user.username,
          firstName: (telegramUser as any).firstName || (telegramUser as any).first_name || user.firstName,
          lastName: (telegramUser as any).lastName || (telegramUser as any).last_name || user.lastName,
          isPremium: (telegramUser as any).isPremium || (telegramUser as any).is_premium || user.isPremium,
          photoUrl: (telegramUser as any).photoUrl || (telegramUser as any).photo_url || user.photoUrl,
        },
      });
    }

    req.user = {
      id: user.id,
      telegramId: user.telegramId,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      languageCode: user.languageCode,
      photoUrl: user.photoUrl,
      walletAddress: user.walletAddress,
      isAdvertiser: user.isAdvertiser,
      isChannelOwner: user.isChannelOwner,
      onboardingCompletedAt: user.onboardingCompletedAt,
    };

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * JWT-based auth for service-to-service or long-lived tokens
 */
export async function jwtAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing authorization token');
    }

    const token = authHeader.slice(7);
    
    const decoded = jwt.verify(token, config.jwtSecret) as {
      userId: string;
    };

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
    });

    if (!user) {
      throw new UnauthorizedError('User not found');
    }

    if (user.isBanned) {
      throw new UnauthorizedError('User is banned');
    }

    req.user = {
      id: user.id,
      telegramId: user.telegramId,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      languageCode: user.languageCode,
      photoUrl: user.photoUrl,
      walletAddress: user.walletAddress,
      isAdvertiser: user.isAdvertiser,
      isChannelOwner: user.isChannelOwner,
      onboardingCompletedAt: user.onboardingCompletedAt,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      next(new UnauthorizedError('Invalid token'));
    } else {
      next(error);
    }
  }
}

/**
 * Optional auth - doesn't fail if no token
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const initData = req.headers['x-telegram-init-data'];
  const authHeader = req.headers.authorization;

  if (initData) {
    return telegramAuth(req, res, next);
  }

  if (authHeader) {
    return jwtAuth(req, res, next);
  }

  next();
}

/**
 * Generate JWT token for a user
 */
export function generateToken(userId: string): string {
  return jwt.sign({ userId }, config.jwtSecret, {
    expiresIn: '7d',
  });
}
