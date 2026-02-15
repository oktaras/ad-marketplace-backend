import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadValidatorWithEnv(overrides: Record<string, string | undefined>) {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  vi.resetModules();
  const module = await import('./index.js');

  return {
    validateSubmittedMediaUrl: module.validateSubmittedMediaUrl,
    prepareUploads: module.prepareUploads,
    restore: () => {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      vi.resetModules();
    },
  };
}

afterEach(() => {
  vi.resetModules();
});

describe('validateSubmittedMediaUrl', () => {
  it('accepts local media url when provider is local', async () => {
    const { validateSubmittedMediaUrl, restore } = await loadValidatorWithEnv({});
    try {
      expect(() => validateSubmittedMediaUrl('http://localhost:3000/media/creative/deal/file.png', 'local')).not.toThrow();
    } finally {
      restore();
    }
  });

  it('accepts s3 media url when provider hint is s3 and proxy origin matches request', async () => {
    const { validateSubmittedMediaUrl, restore } = await loadValidatorWithEnv({
      MEDIA_PUBLIC_BASE_URL: 'https://api.example.com',
      AWS_ENDPOINT_URL: 'https://bucket-private.example.com',
      AWS_S3_BUCKET_NAME: 'creative',
      AWS_ACCESS_KEY_ID: 'AKIA_TEST',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });
    try {
      expect(() =>
        validateSubmittedMediaUrl(
          'https://api.example.com/api/media/s3/creative/deal/file.png',
          's3',
          'https://api.example.com',
        ),
      ).not.toThrow();
    } finally {
      restore();
    }
  });

  it('rejects unsupported host', async () => {
    const { validateSubmittedMediaUrl, restore } = await loadValidatorWithEnv({});
    try {
      expect(() => validateSubmittedMediaUrl('https://example.com/file.png')).toThrowError('Media URL host is not in the allowlist');
    } finally {
      restore();
    }
  });

  it('strips credentials from derived s3 public url', async () => {
    const { prepareUploads, restore } = await loadValidatorWithEnv({
      MEDIA_STORAGE_DRIVER: 's3',
      AWS_ENDPOINT_URL: 'https://access:secret@bucket-private.example.com',
      AWS_S3_BUCKET_NAME: 'creative',
      AWS_ACCESS_KEY_ID: 'AKIA_TEST',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });
    try {
      const prepared = await prepareUploads('deal-1', [
        {
          clientId: 'client-1',
          name: 'image.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
        },
      ]);

      expect(prepared).toHaveLength(1);
      expect(prepared[0]?.publicUrl).toMatch(/^http:\/\/localhost:3000\/api\/media\/s3\/creative\//);
      expect(prepared[0]?.publicUrl).not.toContain('@');
    } finally {
      restore();
    }
  });
});
