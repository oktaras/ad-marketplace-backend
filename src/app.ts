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
    // In development, allow all origins including undefined (for Telegram WebApp)
    if (config.nodeEnv === 'development') {
      callback(null, true);
      return;
    }

    // In production, check against allowed origins
    if (!origin || config.corsOrigins.includes(origin)) {
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

app.get('/api/tonconnect-manifest.json', (req, res) => {
  const baseUrl = resolvePublicBaseUrl(req);

  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json({
    url: baseUrl,
    name: 'Ads Marketplace MVP Bot',
    iconUrl: `${baseUrl}/api/tonconnect-icon.svg`,
    termsOfUseUrl: `${baseUrl}/terms`,
    privacyPolicyUrl: `${baseUrl}/privacy`,
  });
});

app.get('/api/tonconnect-icon.svg', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.type('image/svg+xml').send(
    `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192" fill="none">
      <rect width="192" height="192" rx="48" fill="#0B84FF"/>
      <path d="M96 36C83.2 36 73 46.2 73 59V112.3C73 122.1 78.9 131 87.9 134.8L96 138.3L104.1 134.8C113.1 131 119 122.1 119 112.3V59C119 46.2 108.8 36 96 36Z" fill="white"/>
      <path d="M62 104.5C62 95.4 69.4 88 78.5 88H113.5C122.6 88 130 95.4 130 104.5C130 113.6 122.6 121 113.5 121H78.5C69.4 121 62 113.6 62 104.5Z" fill="#0B84FF"/>
      <path d="M84 102L96 114L108 102" stroke="white" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`,
  );
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
