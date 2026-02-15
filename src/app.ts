import 'dotenv/config';
import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';

import { config } from './config/index.js';
import { errorHandler } from './middleware/error.js';
import { swaggerSpec } from './config/swagger.js';

// Routes
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import channelsRoutes from './routes/channels.js';
import listingsRoutes from './routes/listings.js';
import briefsRoutes from './routes/briefs.js';
import dealsRoutes from './routes/deals.js';
import adminRoutes from './routes/admin.js';
import mediaRoutes from './routes/media.js';

const app = express();

// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS configuration
app.use(cors({
  origin: (origin, callback) => {
    const normalizedOrigin = origin ? origin.replace(/\/+$/, '').toLowerCase() : undefined;

    // In development, allow all origins including undefined (for Telegram WebApp)
    if (config.nodeEnv === 'development') {
      callback(null, true);
      return;
    }

    // In production, check against allowed origins
    if (!origin || (normalizedOrigin && config.corsOrigins.includes(normalizedOrigin))) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (config.media.driver === 'local') {
  const mediaStaticDir = path.resolve(process.cwd(), config.media.local.dir);
  app.use('/media', express.static(mediaStaticDir, {
    maxAge: '1d',
    immutable: false,
    fallthrough: true,
  }));
}

// Compression
app.use(compression());

// Logging
app.use(morgan(config.nodeEnv === 'development' ? 'dev' : 'combined'));

// Additional request logging for debugging
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Health check
app.get('/health', (_, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

function resolvePublicBaseUrl(req: express.Request): string {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const forwardedHost = req.headers['x-forwarded-host'];

  const protocol = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : (typeof forwardedProto === 'string' && forwardedProto.trim()
      ? forwardedProto.split(',')[0].trim()
      : req.protocol);

  const host = Array.isArray(forwardedHost)
    ? forwardedHost[0]
    : (typeof forwardedHost === 'string' && forwardedHost.trim()
      ? forwardedHost.split(',')[0].trim()
      : (req.get('host') || `localhost:${config.port}`));

  return `${protocol}://${host}`;
}

function resolveBaseUrl(configuredBaseUrl: string | undefined, fallbackBaseUrl: string): string {
  const normalizedFallback = fallbackBaseUrl.endsWith('/') ? fallbackBaseUrl : `${fallbackBaseUrl}/`;
  const normalizedConfigured = configuredBaseUrl?.trim();

  if (normalizedConfigured) {
    try {
      return new URL(normalizedConfigured, normalizedFallback).toString();
    } catch {
      // Fall back to request-derived URL when MINI_APP_BASE_URL is malformed.
    }
  }

  return new URL('/', normalizedFallback).toString();
}

function resolveAppRoute(baseUrl: string, routePath: string): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(routePath, normalizedBase).toString();
}

app.get('/api/tonconnect-manifest.json', (req, res) => {
  const publicBaseUrl = resolvePublicBaseUrl(req);
  const miniAppBaseUrl = resolveBaseUrl(config.miniAppBaseUrl, publicBaseUrl);

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    url: resolveAppRoute(miniAppBaseUrl, '/'),
    name: 'Ads Marketplace MVP Bot',
    iconUrl: resolveAppRoute(miniAppBaseUrl, '/tonconnect-icon.png'),
    termsOfUseUrl: resolveAppRoute(miniAppBaseUrl, '/terms'),
    privacyPolicyUrl: resolveAppRoute(miniAppBaseUrl, '/privacy'),
  });
});

// API Documentation
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: 'Ads Marketplace API Docs',
  swaggerOptions: {
    docExpansion: 'none',
  },
}));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/channels', channelsRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/briefs', briefsRoutes);
app.use('/api/deals', dealsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/media', mediaRoutes);

// 404 handler
app.use((_, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use(errorHandler);

export { app };
export default app;
