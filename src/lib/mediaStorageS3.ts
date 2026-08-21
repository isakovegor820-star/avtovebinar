import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat } from 'node:fs/promises';
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
import type {
  CompletedUploadPart,
  MediaObjectResponse,
  MediaProcessingResult,
  MultipartCompletionResult,
  PrivateMediaStorageAdapter,
} from './mediaStorage.js';

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export class SafeMediaProviderError extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
    this.name = 'SafeMediaProviderError';
  }
}

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

function contentTypeForArtifact(fileName: string) {
  if (fileName.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (fileName.endsWith('.ts')) return 'video/mp2t';
  if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) return 'image/jpeg';
  if (fileName.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

async function sha256File(path: string) {
  const hash = crypto.createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

function sniffVideoMime(header: Buffer) {
  if (header.length >= 12 && header.subarray(4, 8).toString('ascii') === 'ftyp') {
    return header.subarray(8, 12).toString('ascii') === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return 'video/webm';
  }
  return null;
}

function runTool(command: string, args: string[], timeoutMs: number, timeoutCode: string, failureCode: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const append = (current: string, chunk: Buffer) => (current + chunk.toString('utf8')).slice(-MAX_DIAGNOSTIC_BYTES);
    child.stdout.on('data', chunk => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', chunk => {
      stderr = append(stderr, chunk);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new SafeMediaProviderError(timeoutCode));
    }, timeoutMs);
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new SafeMediaProviderError(failureCode));
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new SafeMediaProviderError(failureCode));
    });
  });
}

type ProbeJson = {
  format?: { duration?: string; format_name?: string };
  streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number }>;
};

async function probeVideo(path: string, expectedMimeType: string) {
  const header = Buffer.alloc(32);
  const handle = await open(path, 'r');
  let bytesRead: number;
  try {
    ({ bytesRead } = await handle.read(header, 0, header.length, 0));
  } finally {
    await handle.close();
  }
  const detectedMimeType = sniffVideoMime(header.subarray(0, bytesRead));
  if (!detectedMimeType || detectedMimeType !== expectedMimeType) {
    throw new SafeMediaProviderError('media_signature_invalid');
  }
  const result = await runTool(
    env.MEDIA_FFPROBE_PATH,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration,format_name:stream=codec_type,codec_name,width,height',
      '-of',
      'json',
      path,
    ],
    Math.min(env.MEDIA_TRANSCODE_TIMEOUT_SECONDS * 1_000, 120_000),
    'media_probe_timeout',
    'media_probe_failed',
  );
  let probe: ProbeJson;
  try {
    probe = JSON.parse(result.stdout) as ProbeJson;
  } catch {
    throw new SafeMediaProviderError('media_probe_response_invalid');
  }
  const duration = Number(probe.format?.duration);
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
  const allowedVideoCodecs = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
  const allowedAudioCodecs = new Set(['aac', 'opus', 'vorbis', 'mp3']);
  if (!Number.isFinite(duration) || duration <= 0 || !video?.codec_name || !allowedVideoCodecs.has(video.codec_name)) {
    throw new SafeMediaProviderError('media_codec_unsupported');
  }
  if (!audio?.codec_name) {
    throw new SafeMediaProviderError('media_audio_missing');
  }
  if (!allowedAudioCodecs.has(audio.codec_name)) {
    throw new SafeMediaProviderError('media_codec_unsupported');
  }
  if (duration > env.MEDIA_MAX_DURATION_SECONDS) {
    throw new SafeMediaProviderError('media_duration_exceeded');
  }
  if (!video.width || !video.height || video.width <= 0 || video.height <= 0) {
    throw new SafeMediaProviderError('media_probe_response_invalid');
  }
  return {
    mimeType: detectedMimeType,
    durationSeconds: Math.ceil(duration),
    containerFormat: probe.format?.format_name ?? 'unknown',
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
    width: video.width,
    height: video.height,
  };
}

function validateManifest(manifest: string, artifactNames: Set<string>) {
  if (!manifest.startsWith('#EXTM3U') || !manifest.includes('#EXTINF:')) return false;
  const resources = manifest
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  return (
    resources.length > 0 &&
    resources.every(resource => {
      if (resource.includes('://') || resource.includes('..') || resource.startsWith('/')) return false;
      return artifactNames.has(resource);
    })
  );
}

export class S3CompatibleMediaStorage implements PrivateMediaStorageAdapter {
  readonly name = 's3';

  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async createMultipartUpload(input: { storageKey: string; mimeType: string; partCount: number; expiresAt: Date }) {
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
      providerUploadKey: created.UploadId,
      storageKey: input.storageKey,
      partNumbers: Array.from({ length: input.partCount }, (_, index) => index + 1),
      expiresAt: input.expiresAt,
    });
    return { providerUploadKey: created.UploadId, partUrls };
  }

  async signMultipartUploadParts(input: {
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
    const hlsDirectory = join(workDirectory, 'hls');
    const posterPath = join(workDirectory, 'poster.jpg');
    const speechAudioPath = join(workDirectory, 'speech.ogg');
    try {
      await mkdir(hlsDirectory, { recursive: true });
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
      const sourceStat = await stat(sourcePath);
      if (BigInt(sourceStat.size) !== input.expectedSizeBytes) {
        throw new SafeMediaProviderError('media_size_mismatch');
      }
      const checksumSha256 = await sha256File(sourcePath);
      if (input.expectedChecksumSha256 && checksumSha256 !== input.expectedChecksumSha256) {
        throw new SafeMediaProviderError('media_checksum_mismatch');
      }
      const probe = await probeVideo(sourcePath, input.expectedMimeType);
      await runTool(
        env.MEDIA_FFMPEG_PATH,
        [
          '-nostdin',
          '-y',
          '-i',
          sourcePath,
          '-map',
          '0:v:0',
          '-map',
          '0:a:0?',
          '-c:v',
          'libx264',
          '-preset',
          'medium',
          '-crf',
          '22',
          '-pix_fmt',
          'yuv420p',
          '-vf',
          'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-ac',
          '2',
          '-ar',
          '48000',
          '-sn',
          '-hls_time',
          String(env.MEDIA_HLS_SEGMENT_SECONDS),
          '-hls_playlist_type',
          'vod',
          '-hls_flags',
          'independent_segments+temp_file',
          '-hls_segment_filename',
          join(hlsDirectory, 'segment-%06d.ts'),
          join(hlsDirectory, 'master.m3u8'),
        ],
        env.MEDIA_TRANSCODE_TIMEOUT_SECONDS * 1_000,
        'media_transcode_timeout',
        'media_transcode_failed',
      );
      await runTool(
        env.MEDIA_FFMPEG_PATH,
        [
          '-nostdin',
          '-y',
          '-i',
          sourcePath,
          '-map',
          '0:a:0',
          '-vn',
          '-c:a',
          'libopus',
          '-b:a',
          '32k',
          '-ac',
          '1',
          '-ar',
          '48000',
          speechAudioPath,
        ],
        env.MEDIA_TRANSCODE_TIMEOUT_SECONDS * 1_000,
        'media_audio_extract_timeout',
        'media_audio_extract_failed',
      );
      const posterAt = Math.max(0, Math.min(10, Math.floor(probe.durationSeconds / 10)));
      await runTool(
        env.MEDIA_FFMPEG_PATH,
        [
          '-nostdin',
          '-y',
          '-ss',
          String(posterAt),
          '-i',
          sourcePath,
          '-frames:v',
          '1',
          '-vf',
          'scale=trunc(iw/2)*2:trunc(ih/2)*2',
          '-c:v',
          'mjpeg',
          '-q:v',
          '2',
          posterPath,
        ],
        Math.min(env.MEDIA_TRANSCODE_TIMEOUT_SECONDS * 1_000, 300_000),
        'media_poster_timeout',
        'media_poster_failed',
      );
      const artifactNames = new Set(await readdir(hlsDirectory));
      const manifest = await readFile(join(hlsDirectory, 'master.m3u8'), 'utf8');
      if (!validateManifest(manifest, artifactNames)) {
        throw new SafeMediaProviderError('media_manifest_invalid');
      }
      const outputPrefix = `${input.storageKey}/renditions/v1`;
      for (const fileName of [...artifactNames].sort()) {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: `${outputPrefix}/hls/${fileName}`,
            Body: createReadStream(join(hlsDirectory, fileName)),
            ContentType: contentTypeForArtifact(fileName),
            CacheControl: 'private, max-age=31536000, immutable',
          }),
        );
      }
      const posterStorageKey = `${outputPrefix}/poster.jpg`;
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: posterStorageKey,
          Body: createReadStream(posterPath),
          ContentType: 'image/jpeg',
          CacheControl: 'private, max-age=31536000, immutable',
        }),
      );
      const audioStorageKey = `${outputPrefix}/speech.ogg`;
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: audioStorageKey,
          Body: createReadStream(speechAudioPath),
          ContentType: 'audio/ogg',
          CacheControl: 'private, max-age=31536000, immutable',
        }),
      );
      return {
        ...probe,
        sizeBytes: input.expectedSizeBytes,
        checksumSha256,
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
