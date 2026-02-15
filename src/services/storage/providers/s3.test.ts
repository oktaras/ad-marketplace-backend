import { describe, expect, it, vi } from 'vitest';
import { S3StorageProvider } from './s3.js';

describe('S3StorageProvider', () => {
  it('prepares signed upload and deterministic public url', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-02-15T12:00:00.000Z'));

      const provider = new S3StorageProvider({
        endpoint: 'https://bucket-private.example.com',
        region: 'auto',
        bucket: 'creative',
        accessKeyId: 'AKIA_TEST',
        secretAccessKey: 'secret',
        publicBaseUrl: 'https://bucket-public.example.com',
        forcePathStyle: true,
        uploadTokenTtlSeconds: 600,
      });

      const result = await provider.prepareUpload({
        dealId: 'deal-1',
        clientId: 'client-1',
        name: 'file.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        mediaType: 'IMAGE',
        storageKey: 'creative/deal 1/file #1.png',
      });

      expect(result.provider).toBe('s3');
      expect(result.publicUrl).toBe('https://bucket-public.example.com/creative/deal%201/file%20%231.png');
      expect(result.upload.url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
      expect(result.upload.url).toContain('X-Amz-Signature=');
      expect(result.upload.url).toContain('/creative/deal%201/file%20%231.png');
      expect(result.upload.headers?.['Content-Type']).toBe('image/png');
    } finally {
      vi.useRealTimers();
    }
  });

  it('validates url against configured public base', () => {
    const provider = new S3StorageProvider({
      endpoint: 'https://bucket-private.example.com',
      region: 'auto',
      bucket: 'creative',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
      publicBaseUrl: 'https://bucket-public.example.com/files',
      forcePathStyle: true,
      uploadTokenTtlSeconds: 600,
    });

    expect(provider.isAllowedMediaUrl(new URL('https://bucket-public.example.com/files/creative/file.png'))).toBe(true);
    expect(provider.isAllowedMediaUrl(new URL('https://bucket-public.example.com/creative/file.png'))).toBe(false);
    expect(provider.isAllowedMediaUrl(new URL('https://example.com/files/creative/file.png'))).toBe(false);
  });

  it('creates signed read url for private object access', () => {
    const provider = new S3StorageProvider({
      endpoint: 'https://bucket-private.example.com',
      region: 'auto',
      bucket: 'creative',
      accessKeyId: 'AKIA_TEST',
      secretAccessKey: 'secret',
      publicBaseUrl: 'https://api.example.com/api/media/s3',
      forcePathStyle: true,
      uploadTokenTtlSeconds: 600,
    });

    const url = provider.createPresignedGetUrl('creative/deal/file.png', 300);
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=300');
    expect(url).toContain('/creative/creative/deal/file.png');
  });
});
