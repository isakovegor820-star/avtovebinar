import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { env } from './env.js';
import { AppError } from './http.js';
import { createLocalMediaStorageFromEnv } from './mediaStorageLocal.js';
import { createS3MediaStorageFromEnv } from './mediaStorageS3.js';

export type CompletedUploadPart = { partNumber: number; etag: string };
export type MultipartCompletionResult = {
  mimeType: string;
  sizeBytes: bigint;
};
export type MediaProbeResult = {
  mimeType: string;
  sizeBytes: bigint;
  checksumSha256: string;
  durationSeconds: number;
  signatureValid: boolean;
  integrityValid: boolean;
};
export type MediaProcessingResult = MediaProbeResult & {
  containerFormat: string;
  videoCodec: string;
  audioCodec: string | null;
  width: number;
  height: number;
  audioStorageKey: string;
  manifestStorageKey: string;
  posterStorageKey: string;
  manifestValid: boolean;
};
export type MediaObjectResponse = {
  body: Readable;
  contentType: string;
  contentLength?: number;
  contentRange?: string;
  etag?: string;
  lastModified?: Date;
};

export type MediaStorageCapacity = {
  totalBytes: bigint;
  availableBytes: bigint;
  totalInodes: bigint;
  availableInodes: bigint;
};

export interface PrivateMediaStorageAdapter {
  readonly name: string;
  createMultipartUpload(input: {
    applicationUploadId: string;
    storageKey: string;
    mimeType: string;
    partCount: number;
    expiresAt: Date;
  }): Promise<{ providerUploadKey: string; partUrls: Array<{ partNumber: number; url: string; expiresAt: Date }> }>;
  signMultipartUploadParts(input: {
    applicationUploadId: string;
    providerUploadKey: string;
    storageKey: string;
    partNumbers: number[];
    expiresAt: Date;
  }): Promise<Array<{ partNumber: number; url: string; expiresAt: Date }>>;
  writeMultipartUploadPart?(input: {
    applicationUploadId: string;
    providerUploadKey: string;
    storageKey: string;
    partNumber: number;
    expectedSizeBytes: number;
    body: Readable;
  }): Promise<{ etag: string; sizeBytes: number }>;
  listMultipartUploadParts?(input: { providerUploadKey: string; storageKey: string }): Promise<CompletedUploadPart[]>;
  completeMultipartUpload(input: {
    providerUploadKey: string;
    storageKey: string;
    parts: CompletedUploadPart[];
    expectedMimeType: string;
    expectedSizeBytes: bigint;
  }): Promise<MultipartCompletionResult>;
  processVideo(input: {
    storageKey: string;
    expectedMimeType: string;
    expectedSizeBytes: bigint;
    expectedChecksumSha256?: string | null;
  }): Promise<MediaProcessingResult>;
  abortMultipartUpload(input: { providerUploadKey: string; storageKey: string }): Promise<void>;
  readObject?(input: { storageKey: string; range?: string }): Promise<MediaObjectResponse>;
  checkReady?(): Promise<boolean>;
  getCapacity?(): Promise<MediaStorageCapacity>;
}

class UnconfiguredMediaStorage implements PrivateMediaStorageAdapter {
  readonly name = 'unconfigured';
  private unavailable(): never {
    throw new AppError(503, 'Хранилище видео ещё не настроено', undefined, 'media_storage_unconfigured');
  }
  async createMultipartUpload(): Promise<never> {
    return this.unavailable();
  }
  async signMultipartUploadParts(): Promise<never> {
    return this.unavailable();
  }
  async completeMultipartUpload(): Promise<never> {
    return this.unavailable();
  }
  async processVideo(): Promise<never> {
    return this.unavailable();
  }
  async abortMultipartUpload(): Promise<never> {
    return this.unavailable();
  }
}

class TestFakeMediaStorage implements PrivateMediaStorageAdapter {
  readonly name = 'test_fake';
  private assertTest() {
    if (env.NODE_ENV !== 'test') {
      throw new AppError(503, 'Test media adapter is unavailable', undefined, 'media_storage_unconfigured');
    }
  }
  async createMultipartUpload(input: {
    applicationUploadId: string;
    storageKey: string;
    mimeType: string;
    partCount: number;
    expiresAt: Date;
  }) {
    this.assertTest();
    const providerUploadKey = `fake_${crypto.randomUUID()}`;
    return {
      providerUploadKey,
      partUrls: Array.from({ length: input.partCount }, (_, index) => ({
        partNumber: index + 1,
        url: `https://private-storage.invalid/multipart/${providerUploadKey}/${index + 1}?signature=test-only`,
        expiresAt: input.expiresAt,
      })),
    };
  }
  async signMultipartUploadParts(input: {
    applicationUploadId: string;
    providerUploadKey: string;
    storageKey: string;
    partNumbers: number[];
    expiresAt: Date;
  }) {
    this.assertTest();
    return input.partNumbers.map(partNumber => ({
      partNumber,
      url: `https://private-storage.invalid/multipart/${input.providerUploadKey}/${partNumber}?signature=test-only-resume`,
      expiresAt: input.expiresAt,
    }));
  }
  async completeMultipartUpload(input: {
    providerUploadKey: string;
    storageKey: string;
    parts: CompletedUploadPart[];
    expectedMimeType: string;
    expectedSizeBytes: bigint;
  }): Promise<MultipartCompletionResult> {
    this.assertTest();
    return {
      mimeType: input.expectedMimeType,
      sizeBytes: input.expectedSizeBytes,
    };
  }
  async processVideo(input: {
    storageKey: string;
    expectedMimeType: string;
    expectedSizeBytes: bigint;
    expectedChecksumSha256?: string | null;
  }) {
    this.assertTest();
    const checksumSha256 = crypto.createHash('sha256').update(`${input.storageKey}:processed`).digest('hex');
    if (input.expectedChecksumSha256 && input.expectedChecksumSha256 !== checksumSha256) {
      throw new AppError(422, 'Видео не прошло проверку', undefined, 'media_checksum_mismatch');
    }
    const manifestStorageKey = `${input.storageKey}/renditions/v1/hls/master.m3u8`;
    const segmentStorageKey = `${input.storageKey}/renditions/v1/hls/segment-000000.ts`;
    const posterStorageKey = `${input.storageKey}/renditions/v1/poster.jpg`;
    const audioStorageKey = `${input.storageKey}/renditions/v1/speech.ogg`;
    TEST_MEDIA_OBJECTS.set(manifestStorageKey, {
      contentType: 'application/vnd.apple.mpegurl',
      body: Buffer.from('#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:6.000,\nsegment-000000.ts\n#EXT-X-ENDLIST\n'),
    });
    TEST_MEDIA_OBJECTS.set(segmentStorageKey, { contentType: 'video/mp2t', body: Buffer.from('test-hls-segment') });
    TEST_MEDIA_OBJECTS.set(posterStorageKey, { contentType: 'image/jpeg', body: Buffer.from('test-poster') });
    TEST_MEDIA_OBJECTS.set(audioStorageKey, { contentType: 'audio/ogg', body: Buffer.from('test-speech-audio') });
    return {
      mimeType: input.expectedMimeType,
      sizeBytes: input.expectedSizeBytes,
      checksumSha256,
      durationSeconds: Math.min(3_600, env.MEDIA_MAX_DURATION_SECONDS),
      signatureValid: true,
      integrityValid: true,
      containerFormat: input.expectedMimeType === 'video/webm' ? 'webm' : 'mov,mp4,m4a,3gp,3g2,mj2',
      videoCodec: input.expectedMimeType === 'video/webm' ? 'vp9' : 'h264',
      audioCodec: input.expectedMimeType === 'video/webm' ? 'opus' : 'aac',
      width: 1280,
      height: 720,
      audioStorageKey,
      manifestStorageKey,
      posterStorageKey,
      manifestValid: true,
    };
  }
  async abortMultipartUpload() {
    this.assertTest();
  }
  async readObject(input: { storageKey: string; range?: string }) {
    this.assertTest();
    const object = TEST_MEDIA_OBJECTS.get(input.storageKey);
    if (!object) throw new AppError(404, 'Media object not found', undefined, 'media_object_not_found');
    let body = object.body;
    let contentRange: string | undefined;
    if (input.range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(input.range);
      if (!match) throw new AppError(416, 'Invalid media range', undefined, 'media_range_invalid');
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : body.length - 1;
      if (start > end || start >= body.length || end >= body.length) {
        throw new AppError(416, 'Invalid media range', undefined, 'media_range_invalid');
      }
      body = body.subarray(start, end + 1);
      contentRange = `bytes ${start}-${end}/${object.body.length}`;
    }
    return {
      body: Readable.from(body),
      contentType: object.contentType,
      contentLength: body.length,
      contentRange,
    };
  }
}

const TEST_MEDIA_OBJECTS = new Map<string, { contentType: string; body: Buffer }>();

export function getPrivateMediaStorageAdapter(): PrivateMediaStorageAdapter {
  if (env.MEDIA_STORAGE_PROVIDER === 'test_fake') return new TestFakeMediaStorage();
  if (env.MEDIA_STORAGE_PROVIDER === 'local_fs') return createLocalMediaStorageFromEnv();
  if (env.MEDIA_STORAGE_PROVIDER === 's3') return createS3MediaStorageFromEnv();
  return new UnconfiguredMediaStorage();
}

export function getMediaUploadCspOrigins() {
  const configured = env.MEDIA_UPLOAD_CSP_ORIGINS.split(',')
    .map(value => value.trim())
    .filter(Boolean);
  if (env.NODE_ENV === 'test' && env.MEDIA_STORAGE_PROVIDER === 'test_fake') {
    configured.push('https://private-storage.invalid');
  }
  return [...new Set(configured)];
}
