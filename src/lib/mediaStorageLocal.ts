import crypto from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  statfs,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { env } from './env.js';
import { AppError } from './http.js';
import type {
  CompletedUploadPart,
  MediaObjectResponse,
  MediaProcessingResult,
  MultipartCompletionResult,
  PrivateMediaStorageAdapter,
} from './mediaStorage.js';
import {
  contentTypeForMediaArtifact,
  prepareMediaRenditions,
  SafeMediaProviderError,
  sha256File,
} from './mediaTranscoder.js';

const STORAGE_KEY_SEGMENT = /^[A-Za-z0-9._-]{1,191}$/;
const APPLICATION_UPLOAD_ID = /^[A-Za-z0-9_-]{1,191}$/;
const PROVIDER_UPLOAD_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const PART_POINTER = /^part-(\d{6})\.json$/;
const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);

type UploadMetadata = {
  version: 1;
  applicationUploadId: string;
  providerUploadKey: string;
  storageKey: string;
  mimeType: string;
  partCount: number;
  createdAt: string;
};

type PartMetadata = {
  version: 1;
  partNumber: number;
  etag: string;
  sizeBytes: number;
  fileName: string;
};

type ObjectMetadata = {
  version: 1;
  storageKey: string;
  contentType: string;
  sizeBytes: string;
  checksumSha256: string;
  completedAt: string;
};

type LocalPart = CompletedUploadPart & { sizeBytes: number; path: string };

function normalizeEtag(value: string) {
  return value.trim().replace(/^"|"$/g, '').toLowerCase();
}

function isWithin(parent: string, candidate: string) {
  const value = relative(parent, candidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function safeStorageSegments(storageKey: string) {
  if (!storageKey || storageKey.length > 1_024 || storageKey.includes('\\')) {
    throw new SafeMediaProviderError('media_storage_key_invalid');
  }
  const segments = storageKey.split('/');
  if (!segments.length || segments.some(segment => !STORAGE_KEY_SEGMENT.test(segment) || segment === '..')) {
    throw new SafeMediaProviderError('media_storage_key_invalid');
  }
  return segments;
}

function assertProviderUploadKey(value: string) {
  if (!PROVIDER_UPLOAD_KEY.test(value)) throw new SafeMediaProviderError('media_upload_reference_invalid');
}

function assertApplicationUploadId(value: string) {
  if (!APPLICATION_UPLOAD_ID.test(value)) throw new SafeMediaProviderError('media_upload_reference_invalid');
}

async function writeExclusiveJson(path: string, value: unknown) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomicJson(directory: string, path: string, value: unknown) {
  const temporary = join(directory, `.metadata-${crypto.randomUUID()}.tmp`);
  try {
    await writeExclusiveJson(temporary, value);
    await rename(temporary, path);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readSafeJson<T>(parent: string, path: string): Promise<T> {
  const requested = await lstat(path);
  if (!requested.isFile() || requested.isSymbolicLink()) {
    throw new SafeMediaProviderError('media_storage_path_invalid');
  }
  const actual = await realpath(path);
  if (!isWithin(parent, actual)) throw new SafeMediaProviderError('media_storage_path_invalid');
  try {
    return JSON.parse(await readFile(actual, 'utf8')) as T;
  } catch (error) {
    if (error instanceof SafeMediaProviderError) throw error;
    throw new SafeMediaProviderError('media_storage_metadata_invalid');
  }
}

async function assertDirectoryTreeNoSymlinks(base: string, segments: string[]) {
  let current = base;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new SafeMediaProviderError('media_storage_path_invalid');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function writeReadableToHandle(input: {
  body: Readable;
  handle: Awaited<ReturnType<typeof open>>;
  maximumBytes: number;
  exactBytes?: number;
}) {
  const hash = crypto.createHash('sha256');
  let position = 0;
  for await (const value of input.body) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    if (position + chunk.length > input.maximumBytes) {
      throw new SafeMediaProviderError('media_upload_part_size_mismatch');
    }
    await input.handle.write(chunk, 0, chunk.length, position);
    hash.update(chunk);
    position += chunk.length;
  }
  if (input.exactBytes !== undefined && position !== input.exactBytes) {
    throw new SafeMediaProviderError('media_upload_part_size_mismatch');
  }
  return { sizeBytes: position, checksumSha256: hash.digest('hex') };
}

async function openNoFollowReadStream(path: string, range?: { start: number; end: number }) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  return handle.createReadStream({ ...range, autoClose: true });
}

export class LocalFilesystemMediaStorage implements PrivateMediaStorageAdapter {
  readonly name = 'local_fs';
  private readonly root: string;
  private readonly objectsRoot: string;
  private readonly multipartRoot: string;

  constructor(root: string) {
    const normalized = resolve(root);
    if (!isAbsolute(root) || normalized === parse(normalized).root) {
      throw new SafeMediaProviderError('media_local_root_invalid');
    }
    this.root = normalized;
    this.objectsRoot = join(normalized, 'objects');
    this.multipartRoot = join(normalized, 'multipart');
  }

  private async ensureRoots() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const configuredRoot = await lstat(this.root);
    if (!configuredRoot.isDirectory() || configuredRoot.isSymbolicLink()) {
      throw new SafeMediaProviderError('media_local_root_invalid');
    }
    await chmod(this.root, 0o700);
    await mkdir(this.objectsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.multipartRoot, { recursive: true, mode: 0o700 });
    const objectsInfo = await lstat(this.objectsRoot);
    const multipartInfo = await lstat(this.multipartRoot);
    if (
      !objectsInfo.isDirectory() ||
      objectsInfo.isSymbolicLink() ||
      !multipartInfo.isDirectory() ||
      multipartInfo.isSymbolicLink()
    ) {
      throw new SafeMediaProviderError('media_local_root_invalid');
    }
    await chmod(this.objectsRoot, 0o700);
    await chmod(this.multipartRoot, 0o700);
    const actualRoot = await realpath(this.root);
    const actualObjects = await realpath(this.objectsRoot);
    const actualMultipart = await realpath(this.multipartRoot);
    if (!isWithin(actualRoot, actualObjects) || !isWithin(actualRoot, actualMultipart)) {
      throw new SafeMediaProviderError('media_local_root_invalid');
    }
  }

  private uploadDirectory(providerUploadKey: string) {
    assertProviderUploadKey(providerUploadKey);
    return join(this.multipartRoot, providerUploadKey);
  }

  private async checkedUploadDirectory(providerUploadKey: string) {
    await this.ensureRoots();
    const expected = this.uploadDirectory(providerUploadKey);
    const expectedInfo = await lstat(expected);
    if (!expectedInfo.isDirectory() || expectedInfo.isSymbolicLink()) {
      throw new SafeMediaProviderError('media_storage_path_invalid');
    }
    const actual = await realpath(expected);
    const root = await realpath(this.multipartRoot);
    if (!isWithin(root, actual)) throw new SafeMediaProviderError('media_storage_path_invalid');
    return actual;
  }

  private async objectDirectory(storageKey: string, create = false) {
    await this.ensureRoots();
    const segments = safeStorageSegments(storageKey);
    await assertDirectoryTreeNoSymlinks(this.objectsRoot, segments);
    const expected = join(this.objectsRoot, ...segments);
    if (create) await mkdir(expected, { recursive: true, mode: 0o700 });
    await assertDirectoryTreeNoSymlinks(this.objectsRoot, segments);
    if (create) await chmod(expected, 0o700);
    const actual = await realpath(expected);
    const root = await realpath(this.objectsRoot);
    if (!isWithin(root, actual)) throw new SafeMediaProviderError('media_storage_path_invalid');
    return actual;
  }

  private async readUploadMetadata(providerUploadKey: string) {
    const directory = await this.checkedUploadDirectory(providerUploadKey);
    const metadata = await readSafeJson<UploadMetadata>(directory, join(directory, 'metadata.json'));
    if (
      metadata.version !== 1 ||
      metadata.providerUploadKey !== providerUploadKey ||
      !APPLICATION_UPLOAD_ID.test(metadata.applicationUploadId) ||
      !VIDEO_MIME_TYPES.has(metadata.mimeType) ||
      !Number.isInteger(metadata.partCount) ||
      metadata.partCount < 1 ||
      metadata.partCount > 1_000
    ) {
      throw new SafeMediaProviderError('media_storage_metadata_invalid');
    }
    safeStorageSegments(metadata.storageKey);
    return { directory, metadata };
  }

  private async assertUploadBinding(input: {
    applicationUploadId?: string;
    providerUploadKey: string;
    storageKey: string;
  }) {
    const result = await this.readUploadMetadata(input.providerUploadKey);
    if (
      result.metadata.storageKey !== input.storageKey ||
      (input.applicationUploadId && result.metadata.applicationUploadId !== input.applicationUploadId)
    ) {
      throw new SafeMediaProviderError('media_upload_reference_invalid');
    }
    return result;
  }

  private partUrl(applicationUploadId: string, partNumber: number) {
    return `/api/v1/creator/uploads/${encodeURIComponent(applicationUploadId)}/parts/${partNumber}/content`;
  }

  async createMultipartUpload(input: {
    applicationUploadId: string;
    storageKey: string;
    mimeType: string;
    partCount: number;
    expiresAt: Date;
  }) {
    assertApplicationUploadId(input.applicationUploadId);
    const storageSegments = safeStorageSegments(input.storageKey);
    if (!Number.isInteger(input.partCount) || input.partCount < 1 || input.partCount > 1_000) {
      throw new SafeMediaProviderError('media_upload_init_failed');
    }
    await this.ensureRoots();
    await assertDirectoryTreeNoSymlinks(this.objectsRoot, storageSegments);
    const providerUploadKey = crypto.randomUUID();
    const directory = this.uploadDirectory(providerUploadKey);
    try {
      await mkdir(directory, { recursive: false, mode: 0o700 });
      const metadata: UploadMetadata = {
        version: 1,
        applicationUploadId: input.applicationUploadId,
        providerUploadKey,
        storageKey: input.storageKey,
        mimeType: input.mimeType,
        partCount: input.partCount,
        createdAt: new Date().toISOString(),
      };
      await writeExclusiveJson(join(directory, 'metadata.json'), metadata);
      await syncDirectory(directory);
      await syncDirectory(this.multipartRoot);
      return {
        providerUploadKey,
        partUrls: Array.from({ length: input.partCount }, (_, index) => ({
          partNumber: index + 1,
          url: this.partUrl(input.applicationUploadId, index + 1),
          expiresAt: input.expiresAt,
        })),
      };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      if (error instanceof SafeMediaProviderError) throw error;
      throw new SafeMediaProviderError('media_upload_init_failed');
    }
  }

  async signMultipartUploadParts(input: {
    applicationUploadId: string;
    providerUploadKey: string;
    storageKey: string;
    partNumbers: number[];
    expiresAt: Date;
  }) {
    const { metadata } = await this.assertUploadBinding(input);
    if (input.partNumbers.some(part => !Number.isInteger(part) || part < 1 || part > metadata.partCount)) {
      throw new SafeMediaProviderError('media_upload_sign_failed');
    }
    return input.partNumbers.map(partNumber => ({
      partNumber,
      url: this.partUrl(input.applicationUploadId, partNumber),
      expiresAt: input.expiresAt,
    }));
  }

  async writeMultipartUploadPart(input: {
    applicationUploadId: string;
    providerUploadKey: string;
    storageKey: string;
    partNumber: number;
    expectedSizeBytes: number;
    body: Readable;
  }) {
    const { directory, metadata } = await this.assertUploadBinding(input);
    if (!Number.isInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > metadata.partCount) {
      throw new SafeMediaProviderError('media_upload_part_invalid');
    }
    const temporary = join(directory, `.part-${input.partNumber}-${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    let completed = false;
    try {
      const written = await writeReadableToHandle({
        body: input.body,
        handle,
        maximumBytes: input.expectedSizeBytes,
        exactBytes: input.expectedSizeBytes,
      });
      await handle.sync();
      await handle.close();
      completed = true;
      const fileName = `part-${String(input.partNumber).padStart(6, '0')}-${written.checksumSha256}.part`;
      const finalPath = join(directory, fileName);
      await rename(temporary, finalPath);
      const pointerPath = join(directory, `part-${String(input.partNumber).padStart(6, '0')}.json`);
      const pointerTemporary = join(directory, `.pointer-${input.partNumber}-${crypto.randomUUID()}.tmp`);
      const part: PartMetadata = {
        version: 1,
        partNumber: input.partNumber,
        etag: written.checksumSha256,
        sizeBytes: written.sizeBytes,
        fileName,
      };
      try {
        await writeExclusiveJson(pointerTemporary, part);
        try {
          await link(pointerTemporary, pointerPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const existing = await readSafeJson<PartMetadata>(directory, pointerPath);
          if (
            existing.version !== 1 ||
            existing.partNumber !== part.partNumber ||
            existing.etag !== part.etag ||
            existing.sizeBytes !== part.sizeBytes
          ) {
            await rm(finalPath, { force: true });
            throw new SafeMediaProviderError('media_upload_part_conflict');
          }
        }
      } finally {
        await rm(pointerTemporary, { force: true });
      }
      await syncDirectory(directory);
      return { etag: written.checksumSha256, sizeBytes: written.sizeBytes };
    } catch (error) {
      if (!completed) await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      if (error instanceof SafeMediaProviderError) throw error;
      throw new SafeMediaProviderError('media_upload_part_failed');
    }
  }

  private async listPartsDetailed(providerUploadKey: string, storageKey: string): Promise<LocalPart[]> {
    let binding;
    try {
      binding = await this.assertUploadBinding({ providerUploadKey, storageKey });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          const existing = await this.readObjectMetadata(storageKey);
          if (existing) throw new SafeMediaProviderError('media_upload_already_completed');
        } catch (objectError) {
          if (
            objectError instanceof SafeMediaProviderError &&
            objectError.safeCode === 'media_upload_already_completed'
          ) {
            throw objectError;
          }
        }
      }
      if (error instanceof SafeMediaProviderError) throw error;
      throw new SafeMediaProviderError('media_upload_reconciliation_failed');
    }
    const names = await readdir(binding.directory);
    const parts: LocalPart[] = [];
    for (const name of names.sort()) {
      const match = PART_POINTER.exec(name);
      if (!match) continue;
      const pointer = await readSafeJson<PartMetadata>(binding.directory, join(binding.directory, name));
      const partNumber = Number(match[1]);
      if (
        pointer.version !== 1 ||
        pointer.partNumber !== partNumber ||
        partNumber < 1 ||
        partNumber > binding.metadata.partCount ||
        !SHA256.test(pointer.etag) ||
        pointer.fileName !== `part-${match[1]}-${pointer.etag}.part` ||
        !Number.isInteger(pointer.sizeBytes) ||
        pointer.sizeBytes <= 0
      ) {
        throw new SafeMediaProviderError('media_storage_metadata_invalid');
      }
      const partPath = join(binding.directory, pointer.fileName);
      const requested = await lstat(partPath);
      if (!requested.isFile() || requested.isSymbolicLink()) {
        throw new SafeMediaProviderError('media_storage_path_invalid');
      }
      const actual = await realpath(partPath);
      if (!isWithin(binding.directory, actual)) throw new SafeMediaProviderError('media_storage_path_invalid');
      const info = await lstat(actual);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== pointer.sizeBytes) {
        throw new SafeMediaProviderError('media_upload_part_integrity_failed');
      }
      parts.push({ partNumber, etag: pointer.etag, sizeBytes: pointer.sizeBytes, path: actual });
    }
    return parts.sort((left, right) => left.partNumber - right.partNumber);
  }

  async listMultipartUploadParts(input: { providerUploadKey: string; storageKey: string }) {
    return (await this.listPartsDetailed(input.providerUploadKey, input.storageKey)).map(part => ({
      partNumber: part.partNumber,
      etag: part.etag,
    }));
  }

  private async readObjectMetadata(storageKey: string): Promise<ObjectMetadata | null> {
    let directory: string;
    try {
      directory = await this.objectDirectory(storageKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let metadata: ObjectMetadata;
    try {
      metadata = await readSafeJson<ObjectMetadata>(directory, join(directory, 'metadata.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (
      metadata.version !== 1 ||
      metadata.storageKey !== storageKey ||
      !/^\d+$/.test(metadata.sizeBytes) ||
      !SHA256.test(metadata.checksumSha256) ||
      !metadata.contentType
    ) {
      throw new SafeMediaProviderError('media_storage_metadata_invalid');
    }
    return metadata;
  }

  private async checkedObjectData(storageKey: string) {
    const directory = await this.objectDirectory(storageKey);
    const requestedPath = join(directory, 'data');
    const requested = await lstat(requestedPath);
    if (!requested.isFile() || requested.isSymbolicLink()) {
      throw new SafeMediaProviderError('media_storage_path_invalid');
    }
    const dataPath = await realpath(requestedPath);
    if (!isWithin(directory, dataPath)) throw new SafeMediaProviderError('media_storage_path_invalid');
    const info = await lstat(dataPath);
    if (!info.isFile()) throw new SafeMediaProviderError('media_storage_path_invalid');
    return { directory, dataPath, info };
  }

  private async cleanupCompletedUpload(providerUploadKey: string, storageKey: string) {
    try {
      await this.assertUploadBinding({ providerUploadKey, storageKey });
      await rm(this.uploadDirectory(providerUploadKey), { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async completeMultipartUpload(input: {
    providerUploadKey: string;
    storageKey: string;
    parts: CompletedUploadPart[];
    expectedMimeType: string;
    expectedSizeBytes: bigint;
  }): Promise<MultipartCompletionResult> {
    const existing = await this.readObjectMetadata(input.storageKey);
    if (existing) {
      const object = await this.checkedObjectData(input.storageKey);
      if (
        existing.contentType !== input.expectedMimeType ||
        BigInt(existing.sizeBytes) !== input.expectedSizeBytes ||
        BigInt(object.info.size) !== input.expectedSizeBytes ||
        (await sha256File(object.dataPath)) !== existing.checksumSha256
      ) {
        throw new SafeMediaProviderError('media_source_metadata_mismatch');
      }
      await this.cleanupCompletedUpload(input.providerUploadKey, input.storageKey);
      return { mimeType: existing.contentType, sizeBytes: BigInt(existing.sizeBytes) };
    }
    const localParts = await this.listPartsDetailed(input.providerUploadKey, input.storageKey);
    if (
      localParts.length !== input.parts.length ||
      localParts.some(
        (part, index) =>
          part.partNumber !== input.parts[index]?.partNumber ||
          part.etag !== normalizeEtag(input.parts[index]?.etag ?? ''),
      )
    ) {
      throw new SafeMediaProviderError('media_upload_parts_invalid');
    }
    const directory = await this.objectDirectory(input.storageKey, true);
    const temporary = join(directory, `.data-${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    const objectHash = crypto.createHash('sha256');
    let position = 0;
    try {
      for (const part of localParts) {
        const partHash = crypto.createHash('sha256');
        let partBytes = 0;
        const stream = await openNoFollowReadStream(part.path);
        for await (const value of stream) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          await handle.write(chunk, 0, chunk.length, position);
          position += chunk.length;
          partBytes += chunk.length;
          partHash.update(chunk);
          objectHash.update(chunk);
        }
        if (partBytes !== part.sizeBytes || partHash.digest('hex') !== part.etag) {
          throw new SafeMediaProviderError('media_upload_part_integrity_failed');
        }
      }
      if (BigInt(position) !== input.expectedSizeBytes) throw new SafeMediaProviderError('media_size_mismatch');
      await handle.sync();
      await handle.close();
      await rename(temporary, join(directory, 'data'));
      const metadata: ObjectMetadata = {
        version: 1,
        storageKey: input.storageKey,
        contentType: input.expectedMimeType,
        sizeBytes: String(position),
        checksumSha256: objectHash.digest('hex'),
        completedAt: new Date().toISOString(),
      };
      await writeAtomicJson(directory, join(directory, 'metadata.json'), metadata);
      await rm(this.uploadDirectory(input.providerUploadKey), { recursive: true, force: true });
      await syncDirectory(this.multipartRoot);
      return { mimeType: input.expectedMimeType, sizeBytes: BigInt(position) };
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      if (error instanceof SafeMediaProviderError) throw error;
      throw new SafeMediaProviderError('media_upload_complete_failed');
    }
  }

  private async storeObjectFromFile(storageKey: string, sourcePath: string, contentType: string) {
    const directory = await this.objectDirectory(storageKey, true);
    const temporary = join(directory, `.data-${crypto.randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      const source = await openNoFollowReadStream(sourcePath);
      const written = await writeReadableToHandle({ body: source, handle, maximumBytes: Number.MAX_SAFE_INTEGER });
      await handle.sync();
      await handle.close();
      await rename(temporary, join(directory, 'data'));
      const metadata: ObjectMetadata = {
        version: 1,
        storageKey,
        contentType,
        sizeBytes: String(written.sizeBytes),
        checksumSha256: written.checksumSha256,
        completedAt: new Date().toISOString(),
      };
      await writeAtomicJson(directory, join(directory, 'metadata.json'), metadata);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temporary, { force: true });
      if (error instanceof SafeMediaProviderError) throw error;
      throw new SafeMediaProviderError('media_artifact_store_failed');
    }
  }

  async processVideo(input: {
    storageKey: string;
    expectedMimeType: string;
    expectedSizeBytes: bigint;
    expectedChecksumSha256?: string | null;
  }): Promise<MediaProcessingResult> {
    const metadata = await this.readObjectMetadata(input.storageKey);
    if (
      !metadata ||
      metadata.contentType !== input.expectedMimeType ||
      BigInt(metadata.sizeBytes) !== input.expectedSizeBytes
    ) {
      throw new SafeMediaProviderError('media_source_metadata_mismatch');
    }
    const source = await this.checkedObjectData(input.storageKey);
    if (BigInt(source.info.size) !== input.expectedSizeBytes) throw new SafeMediaProviderError('media_size_mismatch');
    const workDirectory = await mkdtemp(join(tmpdir(), 'aspb-media-local-'));
    try {
      const output = await prepareMediaRenditions({
        sourcePath: source.dataPath,
        workDirectory,
        expectedMimeType: input.expectedMimeType,
        expectedSizeBytes: input.expectedSizeBytes,
        expectedChecksumSha256: input.expectedChecksumSha256 ?? metadata.checksumSha256,
      });
      const outputPrefix = `${input.storageKey}/renditions/v1`;
      for (const fileName of output.artifactNames) {
        await this.storeObjectFromFile(
          `${outputPrefix}/hls/${fileName}`,
          join(output.hlsDirectory, fileName),
          contentTypeForMediaArtifact(fileName),
        );
      }
      const posterStorageKey = `${outputPrefix}/poster.jpg`;
      const audioStorageKey = `${outputPrefix}/speech.ogg`;
      await this.storeObjectFromFile(posterStorageKey, output.posterPath, 'image/jpeg');
      await this.storeObjectFromFile(audioStorageKey, output.speechAudioPath, 'audio/ogg');
      return {
        mimeType: output.mimeType,
        sizeBytes: input.expectedSizeBytes,
        checksumSha256: output.checksumSha256,
        durationSeconds: output.durationSeconds,
        signatureValid: true,
        integrityValid: true,
        containerFormat: output.containerFormat,
        videoCodec: output.videoCodec,
        audioCodec: output.audioCodec,
        width: output.width,
        height: output.height,
        audioStorageKey,
        manifestStorageKey: `${outputPrefix}/hls/master.m3u8`,
        posterStorageKey,
        manifestValid: true,
      };
    } finally {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }

  async abortMultipartUpload(input: { providerUploadKey: string; storageKey: string }) {
    try {
      await this.assertUploadBinding(input);
      await rm(this.uploadDirectory(input.providerUploadKey), { recursive: true, force: true });
      await syncDirectory(this.multipartRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (error instanceof SafeMediaProviderError) throw error;
      throw new SafeMediaProviderError('media_upload_abort_failed');
    }
  }

  async readObject(input: { storageKey: string; range?: string }): Promise<MediaObjectResponse> {
    const metadata = await this.readObjectMetadata(input.storageKey);
    if (!metadata) throw new SafeMediaProviderError('media_object_unavailable');
    const object = await this.checkedObjectData(input.storageKey);
    if (BigInt(object.info.size) !== BigInt(metadata.sizeBytes)) {
      throw new SafeMediaProviderError('media_object_unavailable');
    }
    let start = 0;
    let end = object.info.size - 1;
    let contentRange: string | undefined;
    if (input.range) {
      const match = /^bytes=(?:(\d+)-(\d*)|-(\d+))$/.exec(input.range);
      if (!match) throw new AppError(416, 'Invalid media range', undefined, 'media_range_invalid');
      if (match[3]) {
        const suffixLength = Number(match[3]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
          throw new AppError(416, 'Invalid media range', undefined, 'media_range_invalid');
        }
        start = Math.max(0, object.info.size - suffixLength);
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), object.info.size - 1) : object.info.size - 1;
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        start >= object.info.size
      ) {
        throw new AppError(416, 'Invalid media range', undefined, 'media_range_invalid');
      }
      contentRange = `bytes ${start}-${end}/${object.info.size}`;
    }
    return {
      body: await openNoFollowReadStream(object.dataPath, { start, end }),
      contentType: metadata.contentType,
      contentLength: end - start + 1,
      contentRange,
      etag: `"${metadata.checksumSha256}"`,
      lastModified: object.info.mtime,
    };
  }

  async checkReady() {
    try {
      await this.ensureRoots();
      const marker = join(this.root, `.health-${crypto.randomUUID()}`);
      const handle = await open(marker, 'wx', 0o600);
      try {
        await handle.writeFile('ok', 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
        await unlink(marker).catch(() => undefined);
      }
      return true;
    } catch {
      return false;
    }
  }

  async getCapacity() {
    await this.ensureRoots();
    const stats = await statfs(this.root, { bigint: true });
    return {
      totalBytes: stats.blocks * stats.bsize,
      availableBytes: stats.bavail * stats.bsize,
      totalInodes: stats.files,
      availableInodes: stats.ffree,
    };
  }
}

export function createLocalMediaStorageFromEnv() {
  if (!env.MEDIA_LOCAL_ROOT) {
    throw new AppError(503, 'Хранилище видео ещё не настроено', undefined, 'media_storage_unconfigured');
  }
  return new LocalFilesystemMediaStorage(env.MEDIA_LOCAL_ROOT);
}
