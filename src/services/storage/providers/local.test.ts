import { describe, expect, it } from 'vitest';
import {
  resolveLocalStoragePath,
  signLocalUploadToken,
  verifyLocalUploadToken,
} from './local.js';

describe('local storage upload token', () => {
  it('verifies a valid token payload', () => {
    const token = signLocalUploadToken({
      uploadId: 'upload-1',
      storageKey: 'creative/deal-1/file.png',
      mimeType: 'image/png',
      sizeBytes: 12345,
      expiresAt: Date.now() + 60_000,
    }, 'test-secret');

    const parsed = verifyLocalUploadToken(token, 'test-secret');
    expect(parsed).not.toBeNull();
    expect(parsed?.uploadId).toBe('upload-1');
    expect(parsed?.storageKey).toBe('creative/deal-1/file.png');
  });

  it('rejects token with invalid signature', () => {
    const token = signLocalUploadToken({
      uploadId: 'upload-1',
      storageKey: 'creative/deal-1/file.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      expiresAt: Date.now() + 60_000,
    }, 'test-secret');

    const tampered = `${token}tampered`;
    expect(verifyLocalUploadToken(tampered, 'test-secret')).toBeNull();
  });
});

describe('local storage path resolution', () => {
  it('rejects path traversal', () => {
    expect(() => resolveLocalStoragePath('/tmp/uploads', '../secrets.txt')).toThrowError('Unsafe storage key path');
  });

  it('resolves regular file path', () => {
    const resolved = resolveLocalStoragePath('/tmp/uploads', 'creative/deal/file.png');
    expect(resolved).toContain('/tmp/uploads/creative/deal/file.png');
  });
});
