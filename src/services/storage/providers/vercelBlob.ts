import type { PreparedUpload, StorageProviderAdapter, UploadPrepareFileInput } from '../types.js';

interface VercelBlobStorageProviderOptions {
  readWriteToken: string;
  uploadTokenTtlSeconds?: number;
}

const VERCEL_BLOB_UPLOAD_BASE = 'https://blob.vercel-storage.com';

function encodeStorageKey(storageKey: string): string {
  return storageKey
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function createClientUploadToken(
  readWriteToken: string,
  pathname: string,
  validUntil: number,
): Promise<string> {
  try {
    const vercelBlob = await import('@vercel/blob');
    const maybeGenerator = (vercelBlob as { generateClientTokenFromReadWriteToken?: unknown }).generateClientTokenFromReadWriteToken;
    if (typeof maybeGenerator === 'function') {
      const token = await (maybeGenerator as (value: unknown) => Promise<string>)({
        token: readWriteToken,
        pathname,
        validUntil,
      });
      if (token) {
        return token;
      }
    }
  } catch {
    // Keep the error handled below with a clear remediation message.
  }

  throw new Error('Unable to generate Vercel Blob client upload token. Install @vercel/blob in backend dependencies.');
}

export class VercelBlobStorageProvider implements StorageProviderAdapter {
  readonly provider = 'vercel_blob' as const;

  constructor(private readonly options: VercelBlobStorageProviderOptions) {}

  async prepareUpload(input: UploadPrepareFileInput): Promise<PreparedUpload> {
    const encodedPathname = encodeStorageKey(input.storageKey);
    const uploadUrl = `${VERCEL_BLOB_UPLOAD_BASE}/${encodedPathname}`;
    const expiresAt = Date.now() + ((this.options.uploadTokenTtlSeconds || 600) * 1000);
    const uploadToken = await createClientUploadToken(this.options.readWriteToken, input.storageKey, expiresAt);

    return {
      clientId: input.clientId,
      provider: this.provider,
      mediaType: input.mediaType,
      storageKey: input.storageKey,
      publicUrl: null,
      expiresAt: new Date(expiresAt).toISOString(),
      upload: {
        method: 'PUT',
        url: uploadUrl,
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          'x-content-type': input.mimeType,
          'content-type': input.mimeType,
        },
      },
    };
  }

  isAllowedMediaUrl(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    return host.endsWith('.blob.vercel-storage.com');
  }
}
