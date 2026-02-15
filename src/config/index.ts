function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseNumberMbToBytes(value: string | undefined, defaultMb: number): number {
  const mb = parseNumber(value, defaultMb);
  return Math.max(mb, 1) * 1024 * 1024;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : fallback;
}

function normalizeOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, '').toLowerCase();
  }
}

function normalizeCurrencyCode(value: string): string {
  return value.trim().toUpperCase();
}

function parseCurrencyList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  const normalized = value
    .split(',')
    .map((entry) => normalizeCurrencyCode(entry))
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized));
}

function stripUrlCredentials(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const parsed = new URL(trimmed);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function joinUrl(base: string, ...parts: string[]): string {
  const normalizedBase = trimTrailingSlash(base);
  const suffix = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return suffix ? `${normalizedBase}/${suffix}` : normalizedBase;
}

const supportedCurrencies = (() => {
  const parsed = parseCurrencyList(process.env.SUPPORTED_CURRENCIES);
  return parsed.length > 0 ? parsed : ['TON'];
})();

const defaultCurrency = (() => {
  const raw = process.env.DEFAULT_CURRENCY;
  if (!raw) {
    return supportedCurrencies[0];
  }

  const normalized = normalizeCurrencyCode(raw);
  if (!normalized) {
    return supportedCurrencies[0];
  }

  if (!supportedCurrencies.includes(normalized)) {
    throw new Error(
      `Invalid DEFAULT_CURRENCY: "${normalized}". Must be one of [${supportedCurrencies.join(', ')}].`,
    );
  }

  return normalized;
})();

const mediaPublicBaseUrl = stripUrlCredentials(
  process.env.MEDIA_PUBLIC_BASE_URL || `http://localhost:${parseNumber(process.env.PORT, 3000)}`,
);
const s3Endpoint = stripUrlCredentials(
  process.env.AWS_ENDPOINT_URL || '',
);
const s3Bucket = process.env.AWS_S3_BUCKET_NAME || '';
const awsPublicEndpoint = stripUrlCredentials(process.env.AWS_PUBLIC_ENDPOINT_URL || '');
const s3PublicEndpoint = awsPublicEndpoint
  || s3Endpoint;
const s3PublicBaseUrl = s3PublicEndpoint && s3Bucket
  ? joinUrl(s3PublicEndpoint, encodeURIComponent(s3Bucket))
  : '';

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Security
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  corsOrigins: Array.from(new Set(
    parseList(process.env.CORS_ORIGINS, ['http://localhost:5173'])
      .map(normalizeOrigin)
      .filter(Boolean),
  )),

  // Currency
  supportedCurrencies,
  defaultCurrency,
  
  // Rate limiting
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  
  // Telegram
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || '',
  miniAppBaseUrl: process.env.MINI_APP_BASE_URL || process.env.WEB_APP_URL || 'http://localhost:5173',
  telegramApiId: parseInt(process.env.TELEGRAM_API_ID || '0', 10),
  telegramApiHash: process.env.TELEGRAM_API_HASH || '',
  mtprotoSessionEncryptionKey: process.env.MTPROTO_SESSION_ENCRYPTION_KEY || '',
  mtprotoEnabled:
    parseInt(process.env.TELEGRAM_API_ID || '0', 10) > 0 &&
    !!process.env.TELEGRAM_API_HASH,
  dealChat: {
    deleteTopicsOnClose: parseBoolean(process.env.DEAL_CHAT_DELETE_TOPICS_ON_CLOSE, true),
  },
  
  // TON
  tonNetwork: (process.env.TON_NETWORK || 'testnet') as 'mainnet' | 'testnet',
  tonCenterApiUrl: process.env.TON_ENDPOINT || process.env.TON_CENTER_API_URL || 'https://testnet.toncenter.com/api/v2/jsonRPC',
  tonCenterApiKey: process.env.TON_API_KEY || process.env.TON_CENTER_API_KEY || '',
  
  // Platform wallets
  platformFeeWalletAddress: process.env.PLATFORM_WALLET_ADDRESS || process.env.PLATFORM_FEE_WALLET_ADDRESS || '',
  platformMnemonic: process.env.PLATFORM_MNEMONIC || '',
  
  // Backend wallet (for creating escrow deals via factory)
  backendWalletMnemonic: process.env.BACKEND_WALLET_MNEMONIC || '',
  backendWalletAddress: process.env.BACKEND_WALLET_ADDRESS || '',
  
  // Escrow Factory Contract
  escrowFactoryAddress: process.env.ESCROW_FACTORY_ADDRESS || '',
  
  // Commission
  platformFeeBps: parseInt(process.env.PLATFORM_FEE_BPS || '500', 10), // 5% default
  platformFeePercent: parseInt(process.env.PLATFORM_FEE_PERCENT || '5', 10),
  
  // Verification
  verificationSignerSecret: process.env.VERIFICATION_SIGNER_SECRET || '',
  
  // Timeouts (in hours)
  timeouts: {
    negotiation: 72,
    payment: 48,
    creative: 48,
    creativeReview: 48,
    postVerification: 24,
  },
  
  // Escrow settings
  escrow: {
    refundDeadlineSeconds: 7 * 24 * 60 * 60, // 7 days after funding
    minDealAmountTon: 0.1,
    deployGasTon: 0.05, // todo: adjust based on actual deployment costs
    operationGasTon: 0.01, // Gas for Release/Refund operations
  },

  // Analytics refresh schedule
  analyticsRefresh: {
    enabled: parseBoolean(process.env.ANALYTICS_REFRESH_ENABLED, true),
    cron: process.env.ANALYTICS_REFRESH_CRON || '0 3 * * *',
    timezone: process.env.ANALYTICS_REFRESH_TZ || 'UTC',
  },

  media: {
    driver: (process.env.MEDIA_STORAGE_DRIVER || 'local') as 'local' | 's3',
    maxFiles: parseNumber(process.env.MEDIA_MAX_FILES, 5),
    maxImageBytes: parseNumberMbToBytes(process.env.MEDIA_MAX_IMAGE_MB, 10),
    maxVideoBytes: parseNumberMbToBytes(process.env.MEDIA_MAX_VIDEO_MB, 50),
    allowedMime: parseList(process.env.MEDIA_ALLOWED_MIME, ['image/*', 'video/*']),
    local: {
      dir: process.env.MEDIA_LOCAL_DIR || '.uploads',
      publicBaseUrl: mediaPublicBaseUrl,
      signingSecret: process.env.MEDIA_UPLOAD_SIGNING_SECRET || process.env.JWT_SECRET || 'dev-media-upload-secret',
      uploadTokenTtlSeconds: parseNumber(process.env.MEDIA_UPLOAD_TOKEN_TTL_SECONDS, 600),
    },
    s3: {
      endpoint: s3Endpoint,
      publicBaseUrl: s3PublicBaseUrl,
      bucket: s3Bucket,
      region: process.env.AWS_DEFAULT_REGION || 'auto',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      forcePathStyle: parseBoolean(process.env.AWS_S3_FORCE_PATH_STYLE, true),
      readUrlTtlSeconds: parseNumber(process.env.AWS_S3_READ_URL_TTL_SECONDS, 300),
    },
  },
} as const;

// Validation
if (config.nodeEnv === 'production') {
  const required = [
    'JWT_SECRET',
    'TELEGRAM_BOT_TOKEN',
    'PLATFORM_FEE_WALLET_ADDRESS',
    'VERIFICATION_SIGNER_SECRET',
  ];
  
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }
}

if (config.media.driver === 's3') {
  if (!config.media.s3.endpoint) {
    throw new Error(
      'Missing S3 endpoint (set AWS_ENDPOINT_URL) (MEDIA_STORAGE_DRIVER=s3)',
    );
  }
  if (!config.media.s3.bucket) {
    throw new Error(
      'Missing S3 bucket (set AWS_S3_BUCKET_NAME) (MEDIA_STORAGE_DRIVER=s3)',
    );
  }
  if (!config.media.s3.accessKeyId) {
    throw new Error(
      'Missing S3 access key id (set AWS_ACCESS_KEY_ID) (MEDIA_STORAGE_DRIVER=s3)',
    );
  }
  if (!config.media.s3.secretAccessKey) {
    throw new Error(
      'Missing S3 secret access key (set AWS_SECRET_ACCESS_KEY) (MEDIA_STORAGE_DRIVER=s3)',
    );
  }
  if (!config.media.s3.publicBaseUrl) {
    throw new Error(
      'Missing public S3 endpoint (set AWS_PUBLIC_ENDPOINT_URL or use a public AWS_ENDPOINT_URL) (MEDIA_STORAGE_DRIVER=s3)',
    );
  }
}
