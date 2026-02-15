import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { nanoid } from 'nanoid';
import type { PreparedUpload, StorageProviderAdapter, UploadPrepareFileInput } from '../types.js';

export interface LocalUploadTokenPayload {
  uploadId: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  expiresAt: number;
}

interface LocalStorageProviderOptions {
  rootDir: string;
  publicBaseUrl: string;
  signingSecret: string;
  uploadTokenTtlSeconds: number;
}

function toBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signData(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function signLocalUploadToken(payload: LocalUploadTokenPayload, secret: string): string {
  const serializedPayload = JSON.stringify(payload);
  const encodedPayload = toBase64Url(serializedPayload);
  const signature = signData(encodedPayload, secret);
  return `${encodedPayload}.${signature}`;
}

export function verifyLocalUploadToken(token: string, secret: string): LocalUploadTokenPayload | null {
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signData(encodedPayload, secret);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length) {
    return null;
  }

  if (!timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(encodedPayload)) as LocalUploadTokenPayload;
    if (!payload || typeof payload !== 'object') {
      return null;
    }
    if (
      typeof payload.uploadId !== 'string'
      || typeof payload.storageKey !== 'string'
      || typeof payload.mimeType !== 'string'
      || typeof payload.sizeBytes !== 'number'
      || typeof payload.expiresAt !== 'number'
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function resolveLocalStoragePath(rootDir: string, storageKey: string): string {
  const normalizedKey = storageKey.replace(/^\/+/, '');
  const destination = path.resolve(rootDir, normalizedKey);
  const normalizedRoot = path.resolve(rootDir);
  if (!destination.startsWith(`${normalizedRoot}${path.sep}`) && destination !== normalizedRoot) {
    throw new Error('Unsafe storage key path');
  }
  return destination;
}

export class LocalStorageProvider implements StorageProviderAdapter {
  readonly provider = 'local' as const;

  constructor(private readonly options: LocalStorageProviderOptions) {}

  async prepareUpload(input: UploadPrepareFileInput): Promise<PreparedUpload> {
    const uploadId = nanoid(24);
    const expiresAt = Date.now() + (this.options.uploadTokenTtlSeconds * 1000);
    const tokenPayload: LocalUploadTokenPayload = {
      uploadId,
      storageKey: input.storageKey,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      expiresAt,
    };
    const token = signLocalUploadToken(tokenPayload, this.options.signingSecret);
    const publicBase = normalizeBaseUrl(this.options.publicBaseUrl);
    const uploadUrl = `${publicBase}/api/media/local/${uploadId}?token=${encodeURIComponent(token)}`;
    const publicUrl = `${publicBase}/media/${input.storageKey}`;

    return {
      clientId: input.clientId,
      provider: this.provider,
      mediaType: input.mediaType,
      storageKey: input.storageKey,
      publicUrl,
      expiresAt: new Date(expiresAt).toISOString(),
      upload: {
        method: 'PUT',
        url: uploadUrl,
        headers: {
          'Content-Type': input.mimeType,
        },
      },
    };
  }

  async ensureStorageRootExists(): Promise<void> {
    await mkdir(this.options.rootDir, { recursive: true });
  }

  get rootDir(): string {
    return this.options.rootDir;
  }

  get signingSecret(): string {
    return this.options.signingSecret;
  }

  isAllowedMediaUrl(url: URL): boolean {
    const base = normalizeBaseUrl(this.options.publicBaseUrl);
    return url.href.startsWith(`${base}/media/`);
  }
}
