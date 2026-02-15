export type StorageProvider = 'local' | 's3';

export type CreativeMediaType = 'IMAGE' | 'VIDEO' | 'GIF' | 'DOCUMENT' | 'AUDIO';

export interface UploadPrepareFileInput {
  dealId: string;
  clientId: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  mediaType: CreativeMediaType;
  storageKey: string;
}

export interface CreativeMediaMeta {
  url: string;
  type: CreativeMediaType;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  provider?: StorageProvider | 'legacy' | string;
  storageKey?: string;
}

export interface PreparedUpload {
  clientId: string;
  provider: StorageProvider;
  mediaType: CreativeMediaType;
  storageKey: string;
  publicUrl: string | null;
  expiresAt: string;
  upload: {
    method: 'PUT';
    url: string;
    headers?: Record<string, string>;
  };
}

export interface StorageProviderAdapter {
  readonly provider: StorageProvider;
  prepareUpload(input: UploadPrepareFileInput): Promise<PreparedUpload>;
  isAllowedMediaUrl(url: URL): boolean;
}
