import { describe, expect, it } from 'vitest';
import { validateSubmittedMediaUrl } from './index.js';

describe('validateSubmittedMediaUrl', () => {
  it('accepts local media url when provider is local', () => {
    expect(() => validateSubmittedMediaUrl('http://localhost:3000/media/creative/deal/file.png', 'local')).not.toThrow();
  });

  it('rejects unsupported host', () => {
    expect(() => validateSubmittedMediaUrl('https://example.com/file.png')).toThrowError('Media URL host is not in the allowlist');
  });
});
