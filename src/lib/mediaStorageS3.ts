import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from './env.js';
import { AppError } from './http.js';
import { contentTypeForMediaArtifact, prepareMediaRenditions, SafeMediaProviderError } from './mediaTranscoder.js';
import type {
  CompletedUploadPart,
  MediaObjectResponse,
  MediaProcessingResult,
  MultipartCompletionResult,
  PrivateMediaStorageAdapter,
} from './mediaStorage.js';

export { SafeMediaProviderError } from './mediaTranscoder.js';

function isNoSuchUpload(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      ('$metadata' in error || 'name' in error) &&
      ('name' in error ? error.name === 'NoSuchUpload' : false),
  );
}

function providerHttpStatus(error: unknown) {
  if (!error || typeof error !== 'object' || !('$metadata' in error)) return undefined;
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}

function signedUrlTtl(expiresAt: Date) {
  return Math.max(60, Math.min(3_600, Math.floor((expiresAt.getTime() - Date.now()) / 1_000)));
}

function normalizeEtag(value: string | undefined) {
  return (value ?? '').trim().replace(/^"|"$/g, '');
}

function nodeReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof body === 'object' && 'transformToWebStream' in body) {
    const stream = (body as { transformToWebStream(): ReadableStream }).transformToWebStream();
    return Readable.fromWeb(stream as never);
  }
  throw new SafeMediaProviderError('media_storage_response_invalid');
}

export class S3CompatibleMediaStorage implements PrivateMediaStorageAdapter {
  readonly name = 's3';

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async createMultipartUpload(input: {
    applicationUploadId: string;
    storageKey: string;
    mimeType: string;
    partCount: number;
    expiresAt: Date;
  }) {
    const created = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: input.storageKey,
        ContentType: input.mimeType,
        Metadata: { 'aspb-upload-version': '1' },
      }),
    );
    if (!created.UploadId) throw new SafeMediaProviderError('media_upload_init_failed');
    const partUrls = await this.signMultipartUploadParts({
      applicationUploadId: input.applicationUploadId,
      providerUploadKey: created.UploadId,
      storageKey: input.storageKey,
      partNumbers: Array.from({ length: input.partCount }, (_, index) => index + 1),
      expiresAt: input.expiresAt,
    });
    return { providerUploadKey: created.UploadId, partUrls };
  }

  async signMultipartUploadParts(input: {
    applicationUploadId: string;
    providerUploadKey: string;
    storageKey: string;
    partNumbers: number[];
    expiresAt: Date;
  }) {
    const expiresIn = signedUrlTtl(input.expiresAt);
    return Promise.all(
      input.partNumbers.map(async partNumber => ({
        partNumber,
        url: await getSignedUrl(
          this.client,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: input.storageKey,
            UploadId: input.providerUploadKey,
            PartNumber: partNumber,
          }),
          { expiresIn },
        ),
        expiresAt: new Date(Date.now() + expiresIn * 1_000),
      })),
    );
  }

  async listMultipartUploadParts(input: { providerUploadKey: string; storageKey: string }) {
    const parts: CompletedUploadPart[] = [];
    let marker: string | undefined;
    do {
      let response;
      try {
        response = await this.client.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: input.storageKey,
            UploadId: input.providerUploadKey,
            PartNumberMarker: marker,
          }),
        );
      } catch (error) {
        if (isNoSuchUpload(error)) {
          throw new SafeMediaProviderError('media_upload_already_completed');
        }
        throw new SafeMediaProviderError('media_upload_reconciliation_failed');
      }
      for (const part of response.Parts ?? []) {
        if (part.PartNumber && part.ETag) {
          parts.push({ partNumber: part.PartNumber, etag: normalizeEtag(part.ETag) });
        }
      }
      marker = response.IsTruncated ? response.NextPartNumberMarker : undefined;
    } while (marker);
    return parts.sort((left, right) => left.partNumber - right.partNumber);
  }

  async completeMultipartUpload(input: {
    providerUploadKey: string;
    storageKey: string;
    parts: CompletedUploadPart[];
    expectedMimeType: string;
    expectedSizeBytes: bigint;
  }): Promise<MultipartCompletionResult> {
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: input.storageKey,
          UploadId: input.providerUploadKey,
          MultipartUpload: {
            Parts: input.parts.map(part => ({ PartNumber: part.partNumber, ETag: part.etag })),
          },
        }),
      );
    } catch (error) {
      if (!isNoSuchUpload(error)) throw new SafeMediaProviderError('media_upload_complete_failed');
    }
    const object = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: input.storageKey }));
    if (object.ContentLength === undefined) throw new SafeMediaProviderError('media_storage_response_invalid');
    return {
      mimeType: object.ContentType ?? input.expectedMimeType,
      sizeBytes: BigInt(object.ContentLength),
    };
  }

  async processVideo(input: {
    storageKey: string;
    expectedMimeType: string;
    expectedSizeBytes: bigint;
    expectedChecksumSha256?: string | null;
  }): Promise<MediaProcessingResult> {
    const workDirectory = await mkdtemp(join(tmpdir(), 'aspb-media-'));
    const sourcePath = join(workDirectory, 'source');
    try {
      const metadata = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: input.storageKey }));
      if (
        metadata.ContentLength === undefined ||
        BigInt(metadata.ContentLength) !== input.expectedSizeBytes ||
        metadata.ContentType !== input.expectedMimeType
      ) {
        throw new SafeMediaProviderError('media_source_metadata_mismatch');
      }
      const source = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: input.storageKey }));
      if (!source.Body) throw new SafeMediaProviderError('media_source_unavailable');
      await pipeline(nodeReadable(source.Body), createWriteStream(sourcePath, { flags: 'wx' }));
      const output = await prepareMediaRenditions({
        sourcePath,
        workDirectory,
        expectedMimeType: input.expectedMimeType,
        expectedSizeBytes: input.expectedSizeBytes,
        expectedChecksumSha256: input.expectedChecksumSha256,
      });
      const outputPrefix = `${input.storageKey}/renditions/v1`;
      for (const fileName of output.artifactNames) {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: `${outputPrefix}/hls/${fileName}`,
            Body: createReadStream(join(output.hlsDirectory, fileName)),
            ContentType: contentTypeForMediaArtifact(fileName),
            CacheControl: 'private, max-age=31536000, immutable',
          }),
        );
      }
      const posterStorageKey = `${outputPrefix}/poster.jpg`;
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: posterStorageKey,
          Body: createReadStream(output.posterPath),
          ContentType: 'image/jpeg',
          CacheControl: 'private, max-age=31536000, immutable',
        }),
      );
      const audioStorageKey = `${outputPrefix}/speech.ogg`;
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: audioStorageKey,
          Body: createReadStream(output.speechAudioPath),
          ContentType: 'audio/ogg',
          CacheControl: 'private, max-age=31536000, immutable',
        }),
      );
      return {
        mimeType: output.mimeType,
        durationSeconds: output.durationSeconds,
        containerFormat: output.containerFormat,
        videoCodec: output.videoCodec,
        audioCodec: output.audioCodec,
        width: output.width,
        height: output.height,
        sizeBytes: input.expectedSizeBytes,
        checksumSha256: output.checksumSha256,
        signatureValid: true,
        integrityValid: true,
        manifestStorageKey: `${outputPrefix}/hls/master.m3u8`,
        posterStorageKey,
        audioStorageKey,
        manifestValid: true,
      };
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }

  async abortMultipartUpload(input: { providerUploadKey: string; storageKey: string }) {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: input.storageKey,
          UploadId: input.providerUploadKey,
        }),
      );
    } catch (error) {
      if (!isNoSuchUpload(error)) throw new SafeMediaProviderError('media_upload_abort_failed');
    }
  }

  async readObject(input: { storageKey: string; range?: string }): Promise<MediaObjectResponse> {
    let object;
    try {
      object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: input.storageKey,
          Range: input.range,
        }),
      );
    } catch (error) {
      if (providerHttpStatus(error) === 416) {
        throw new AppError(416, 'Invalid media range', undefined, 'media_range_invalid');
      }
      throw new SafeMediaProviderError('media_object_unavailable');
    }
    if (!object.Body) throw new SafeMediaProviderError('media_object_unavailable');
    return {
      body: nodeReadable(object.Body),
      contentType: object.ContentType ?? 'application/octet-stream',
      contentLength: object.ContentLength,
      contentRange: object.ContentRange,
      etag: object.ETag,
      lastModified: object.LastModified,
    };
  }
}

export function createS3MediaStorageFromEnv() {
  if (
    !env.MEDIA_S3_ENDPOINT ||
    !env.MEDIA_S3_BUCKET ||
    !env.MEDIA_S3_ACCESS_KEY_ID ||
    !env.MEDIA_S3_SECRET_ACCESS_KEY
  ) {
    throw new AppError(503, 'Хранилище видео ещё не настроено', undefined, 'media_storage_unconfigured');
  }
  const client = new S3Client({
    endpoint: env.MEDIA_S3_ENDPOINT,
    region: env.MEDIA_S3_REGION,
    forcePathStyle: env.MEDIA_S3_FORCE_PATH_STYLE === 'true',
    credentials: {
      accessKeyId: env.MEDIA_S3_ACCESS_KEY_ID,
      secretAccessKey: env.MEDIA_S3_SECRET_ACCESS_KEY,
    },
    maxAttempts: 3,
  });
  return new S3CompatibleMediaStorage(client, env.MEDIA_S3_BUCKET);
}

export function mediaEtagsEqual(left: string, right: string) {
  return normalizeEtag(left) === normalizeEtag(right);
}
