import { createHash, createHmac } from 'node:crypto';
import type { PreparedUpload, StorageProviderAdapter, UploadPrepareFileInput } from '../types.js';

interface S3StorageProviderOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicBaseUrl: string;
  forcePathStyle: boolean;
  uploadTokenTtlSeconds?: number;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function encodeStorageKey(storageKey: string): string {
  return storageKey
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

export class S3StorageProvider implements StorageProviderAdapter {
  readonly provider = 's3' as const;

  constructor(private readonly options: S3StorageProviderOptions) {
    // No-op: S3 signing is done in-process to avoid external SDK dependency.
  }

  async prepareUpload(input: UploadPrepareFileInput): Promise<PreparedUpload> {
    const expiresIn = Math.max(1, this.options.uploadTokenTtlSeconds || 600);
    const uploadUrl = this.createPresignedPutUrl(input.storageKey, expiresIn);
    const publicBase = normalizeBaseUrl(this.options.publicBaseUrl);
    const publicUrl = `${publicBase}/${encodeStorageKey(input.storageKey)}`;
    const expiresAt = Date.now() + (expiresIn * 1000);

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

  isAllowedMediaUrl(url: URL): boolean {
    const baseRaw = this.options.publicBaseUrl?.trim();
    if (!baseRaw) {
      return false;
    }

    try {
      const base = new URL(baseRaw);
      if (url.origin.toLowerCase() !== base.origin.toLowerCase()) {
        return false;
      }

      const basePath = base.pathname.replace(/\/+$/, '');
      if (!basePath || basePath === '/') {
        return url.pathname.startsWith('/');
      }

      return url.pathname.startsWith(`${basePath}/`);
    } catch {
      return false;
    }
  }

  private createPresignedPutUrl(storageKey: string, expiresIn: number): string {
    const endpointUrl = new URL(this.options.endpoint);
    const now = new Date();
    const amzDate = formatAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const credentialScope = `${dateStamp}/${this.options.region}/s3/aws4_request`;

    const basePath = endpointUrl.pathname.replace(/\/+$/, '');
    const encodedKey = encodeStorageKey(storageKey);
    const path = this.options.forcePathStyle
      ? `${basePath}/${encodeURIComponent(this.options.bucket)}/${encodedKey}`
      : `${basePath}/${encodedKey}`;
    const canonicalUri = path.startsWith('/') ? path : `/${path}`;

    const host = this.options.forcePathStyle
      ? endpointUrl.host
      : `${encodeURIComponent(this.options.bucket)}.${endpointUrl.host}`;

    const query = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.options.accessKeyId}/${credentialScope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresIn),
      'X-Amz-SignedHeaders': 'host',
    });

    const canonicalQueryString = toCanonicalQueryString(query);
    const canonicalHeaders = `host:${host.toLowerCase()}\n`;
    const signedHeaders = 'host';
    const payloadHash = 'UNSIGNED-PAYLOAD';

    const canonicalRequest = [
      'PUT',
      canonicalUri,
      canonicalQueryString,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');

    const signingKey = getSigningKey(
      this.options.secretAccessKey,
      dateStamp,
      this.options.region,
      's3',
    );
    const signature = hmacHex(signingKey, stringToSign);
    query.set('X-Amz-Signature', signature);

    const finalHost = this.options.forcePathStyle
      ? endpointUrl.host
      : `${encodeURIComponent(this.options.bucket)}.${endpointUrl.host}`;
    const origin = `${endpointUrl.protocol}//${finalHost}`;
    return `${origin}${canonicalUri}?${toCanonicalQueryString(query)}`;
  }
}

function formatAmzDate(date: Date): string {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return iso.slice(0, 15) + 'Z';
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => {
    return `%${char.charCodeAt(0).toString(16).toUpperCase()}`;
  });
}

function toCanonicalQueryString(params: URLSearchParams): string {
  const pairs: Array<{ key: string; value: string }> = [];
  params.forEach((value, key) => {
    pairs.push({ key, value });
  });

  pairs.sort((a, b) => {
    if (a.key === b.key) {
      return a.value.localeCompare(b.value);
    }
    return a.key.localeCompare(b.key);
  });

  return pairs.map(({ key, value }) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`).join('&');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function hmacHex(key: Buffer | string, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

function getSigningKey(secretAccessKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}
