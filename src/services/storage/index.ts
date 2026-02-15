import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../../config/index.js';
import { ValidationError } from '../../middleware/error.js';
import { LocalStorageProvider } from './providers/local.js';
import { S3StorageProvider } from './providers/s3.js';
import type {
  CreativeMediaMeta,
  CreativeMediaType,
  PreparedUpload,
  StorageProviderAdapter,
  UploadPrepareFileInput,
} from './types.js';

export interface UploadFileSpec {
  clientId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

const localProvider = new LocalStorageProvider({
  rootDir: config.media.local.dir,
  publicBaseUrl: config.media.local.publicBaseUrl,
  signingSecret: config.media.local.signingSecret,
  uploadTokenTtlSeconds: config.media.local.uploadTokenTtlSeconds,
});

const s3Provider = new S3StorageProvider({
  endpoint: config.media.s3.endpoint,
  region: config.media.s3.region,
  bucket: config.media.s3.bucket,
  accessKeyId: config.media.s3.accessKeyId,
  secretAccessKey: config.media.s3.secretAccessKey,
  publicBaseUrl: config.media.s3.publicBaseUrl,
  forcePathStyle: config.media.s3.forcePathStyle,
  uploadTokenTtlSeconds: config.media.local.uploadTokenTtlSeconds,
});

function getProvider(): StorageProviderAdapter {
  if (config.media.driver === 's3') {
    return s3Provider;
  }

  return localProvider;
}

function normalizeMimeType(value: string): string {
  return value.trim().toLowerCase();
}

function inferMediaType(mimeType: string): CreativeMediaType | null {
  if (mimeType.startsWith('image/')) {
    if (mimeType === 'image/gif') {
      return 'GIF';
    }
    return 'IMAGE';
  }

  if (mimeType.startsWith('video/')) {
    return 'VIDEO';
  }

  return null;
}

function matchesMimeRule(mimeType: string, rule: string): boolean {
  if (rule.endsWith('/*')) {
    const prefix = rule.slice(0, -1);
    return mimeType.startsWith(prefix);
  }
  return mimeType === rule;
}

function extractExtension(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (!extension || extension.length > 10) {
    return '';
  }
  return extension.replace(/[^a-z0-9.]/gi, '');
}

function createStorageKey(dealId: string, fileName: string): string {
  const extension = extractExtension(fileName);
  return `creative/${dealId}/${Date.now()}-${nanoid(12)}${extension}`;
}

export function validateUploadFileSpec(file: UploadFileSpec): {
  mediaType: CreativeMediaType;
  normalizedMimeType: string;
} {
  const normalizedMimeType = normalizeMimeType(file.mimeType);
  const mediaType = inferMediaType(normalizedMimeType);

  if (!mediaType) {
    throw new ValidationError(`Unsupported media mime type: ${file.mimeType}`);
  }

  const isAllowed = config.media.allowedMime.some((rule) => matchesMimeRule(normalizedMimeType, rule.toLowerCase()));
  if (!isAllowed) {
    throw new ValidationError(`MIME type ${file.mimeType} is not allowed`);
  }

  if (!Number.isFinite(file.sizeBytes) || file.sizeBytes <= 0) {
    throw new ValidationError(`Invalid file size for ${file.name}`);
  }

  if (mediaType === 'IMAGE' || mediaType === 'GIF') {
    if (file.sizeBytes > config.media.maxImageBytes) {
      throw new ValidationError(`Image ${file.name} exceeds ${Math.floor(config.media.maxImageBytes / (1024 * 1024))}MB limit`);
    }
  } else if (mediaType === 'VIDEO') {
    if (file.sizeBytes > config.media.maxVideoBytes) {
      throw new ValidationError(`Video ${file.name} exceeds ${Math.floor(config.media.maxVideoBytes / (1024 * 1024))}MB limit`);
    }
  }

  return { mediaType, normalizedMimeType };
}

export async function prepareUploads(
  dealId: string,
  files: UploadFileSpec[],
): Promise<PreparedUpload[]> {
  if (files.length === 0) {
    return [];
  }

  if (files.length > config.media.maxFiles) {
    throw new ValidationError(`You can upload up to ${config.media.maxFiles} files`);
  }

  const provider = getProvider();

  const prepared = await Promise.all(files.map(async (file): Promise<PreparedUpload> => {
    const { mediaType, normalizedMimeType } = validateUploadFileSpec(file);
    const input: UploadPrepareFileInput = {
      dealId,
      clientId: file.clientId,
      name: file.name,
      mimeType: normalizedMimeType,
      sizeBytes: file.sizeBytes,
      mediaType,
      storageKey: createStorageKey(dealId, file.name),
    };

    return provider.prepareUpload(input);
  }));

  if (provider.provider === 'local') {
    await localProvider.ensureStorageRootExists();
  }

  return prepared;
}

export function getActiveStorageProvider(): StorageProviderAdapter {
  return getProvider();
}

export function getLocalStorageProvider(): LocalStorageProvider {
  return localProvider;
}

export function validateSubmittedMediaUrl(url: string, providerHint?: string | null): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ValidationError('Media URL must be a valid absolute URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ValidationError('Media URL protocol must be http or https');
  }

  if (providerHint === 'local') {
    if (!localProvider.isAllowedMediaUrl(parsed)) {
      throw new ValidationError('Media URL is not allowed for local provider');
    }
    return;
  }

  if (providerHint === 's3') {
    if (!s3Provider.isAllowedMediaUrl(parsed)) {
      throw new ValidationError('Media URL is not allowed for s3 provider');
    }
    return;
  }


  if (
    localProvider.isAllowedMediaUrl(parsed)
    || s3Provider.isAllowedMediaUrl(parsed)
  ) {
    return;
  }

  throw new ValidationError('Media URL host is not in the allowlist');
}

export function normalizeCreativeMediaMeta(input: unknown): CreativeMediaMeta[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((item): CreativeMediaMeta | null => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const candidate = item as Record<string, unknown>;
      const url = typeof candidate.url === 'string' ? candidate.url.trim() : '';
      if (!url) {
        return null;
      }

      const typeRaw = typeof candidate.type === 'string' ? candidate.type.toUpperCase() : 'IMAGE';
      const type = (['IMAGE', 'VIDEO', 'GIF', 'DOCUMENT', 'AUDIO'] as const).includes(typeRaw as CreativeMediaType)
        ? (typeRaw as CreativeMediaType)
        : 'IMAGE';

      const normalized: CreativeMediaMeta = { url, type };
      if (typeof candidate.name === 'string' && candidate.name.trim()) {
        normalized.name = candidate.name.trim();
      }
      if (typeof candidate.mimeType === 'string' && candidate.mimeType.trim()) {
        normalized.mimeType = candidate.mimeType.trim();
      }
      if (typeof candidate.sizeBytes === 'number') {
        normalized.sizeBytes = candidate.sizeBytes;
      }
      if (typeof candidate.provider === 'string' && candidate.provider.trim()) {
        normalized.provider = candidate.provider;
      }
      if (typeof candidate.storageKey === 'string' && candidate.storageKey.trim()) {
        normalized.storageKey = candidate.storageKey;
      }

      return normalized;
    })
    .filter((item): item is CreativeMediaMeta => item !== null);
}
