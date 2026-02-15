import express from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { NotFoundError, ValidationError } from '../middleware/error.js';
import { getLocalStorageProvider } from '../services/storage/index.js';
import { resolveLocalStoragePath, verifyLocalUploadToken } from '../services/storage/providers/local.js';

const router = express.Router();
const localProvider = getLocalStorageProvider();
const maxUploadBytes = Math.max(config.media.maxImageBytes, config.media.maxVideoBytes);

function resolveRequestBaseUrl(req: express.Request): string {
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
      : (req.get('host') || 'localhost:3000'));

  return `${protocol}://${host}`;
}

router.put(
  '/local/:uploadId',
  express.raw({ type: '*/*', limit: `${Math.ceil(maxUploadBytes / (1024 * 1024))}mb` }),
  async (req, res, next) => {
    try {
      if (config.media.driver !== 'local') {
        throw new NotFoundError('Media upload target');
      }

      const uploadId = Array.isArray(req.params.uploadId) ? req.params.uploadId[0] : req.params.uploadId;
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      if (!token) {
        throw new ValidationError('Missing upload token');
      }

      const payload = verifyLocalUploadToken(token, localProvider.signingSecret);
      if (!payload) {
        throw new ValidationError('Invalid upload token');
      }
      if (payload.uploadId !== uploadId) {
        throw new ValidationError('Upload token does not match upload id');
      }
      if (Date.now() > payload.expiresAt) {
        throw new ValidationError('Upload token has expired');
      }

      const body = req.body;
      if (!Buffer.isBuffer(body)) {
        throw new ValidationError('Upload body must be binary');
      }
      if (body.byteLength === 0) {
        throw new ValidationError('Upload body is empty');
      }
      if (body.byteLength > payload.sizeBytes) {
        throw new ValidationError('Uploaded file is larger than declared size');
      }

      const requestMimeType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (requestMimeType && requestMimeType !== payload.mimeType.toLowerCase()) {
        throw new ValidationError('Upload content type does not match prepared file type');
      }

      const absolutePath = resolveLocalStoragePath(localProvider.rootDir, payload.storageKey);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, body);

      const normalizedPublicBaseUrl = resolveRequestBaseUrl(req).replace(/\/+$/, '');
      res.status(200).json({
        ok: true,
        storageKey: payload.storageKey,
        url: `${normalizedPublicBaseUrl}/media/${payload.storageKey}`,
      });
    } catch (error) {
      next(error);
    }
  },
);

export default router;
