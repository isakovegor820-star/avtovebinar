import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { env } from '../lib/env.js';
import { LocalFilesystemMediaStorage } from '../lib/mediaStorageLocal.js';
import { SafeMediaProviderError } from '../lib/mediaTranscoder.js';

const FIXTURE_TIMEOUT_MS = 60_000;
const RESTART_STATE_FILE = '.media-restart-acceptance.json';

type PendingUpload = {
  version: 1;
  providerUploadKey: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: string;
  checksumSha256: string;
  parts: Array<{ partNumber: number; etag: string }>;
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    child.stderr.on('data', chunk => {
      diagnostic = (diagnostic + String(chunk)).slice(-4_096);
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Fixture command timed out: ${command}`));
    }, FIXTURE_TIMEOUT_MS);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Fixture command failed (${code ?? 'unknown'}): ${diagnostic}`));
    });
  });
}

async function createFixture(path: string, container: 'mp4' | 'mov' | 'webm') {
  const common = [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=25',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=1000:sample_rate=48000',
    '-t',
    '1',
    '-shortest',
  ];
  const codecArgs =
    container === 'webm'
      ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-f', 'webm']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', container];
  await run(env.MEDIA_FFMPEG_PATH, [...common, ...codecArgs, path]);
}

async function bodyBuffer(body: Readable) {
  const chunks: Buffer[] = [];
  for await (const value of body) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  return Buffer.concat(chunks);
}

async function beginUploadSource(
  storage: LocalFilesystemMediaStorage,
  input: { bytes: Buffer; mimeType: string; storageKey: string },
) {
  const uploadId = crypto.randomUUID();
  const initialized = await storage.createMultipartUpload({
    applicationUploadId: uploadId,
    storageKey: input.storageKey,
    mimeType: input.mimeType,
    partCount: 2,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const splitAt = Math.ceil(input.bytes.length / 2);
  const chunks = [input.bytes.subarray(0, splitAt), input.bytes.subarray(splitAt)];
  const parts = [];
  for (const [index, chunk] of chunks.entries()) {
    const written = await storage.writeMultipartUploadPart({
      applicationUploadId: uploadId,
      providerUploadKey: initialized.providerUploadKey,
      storageKey: input.storageKey,
      partNumber: index + 1,
      expectedSizeBytes: chunk.length,
      body: Readable.from(chunk),
    });
    parts.push({ partNumber: index + 1, etag: written.etag });
  }
  return {
    providerUploadKey: initialized.providerUploadKey,
    storageKey: input.storageKey,
    mimeType: input.mimeType,
    sizeBytes: BigInt(input.bytes.length),
    checksumSha256: crypto.createHash('sha256').update(input.bytes).digest('hex'),
    parts,
  };
}

async function uploadSource(
  storage: LocalFilesystemMediaStorage,
  input: { bytes: Buffer; mimeType: string; storageKey: string },
) {
  const pending = await beginUploadSource(storage, input);
  await storage.completeMultipartUpload({
    providerUploadKey: pending.providerUploadKey,
    storageKey: pending.storageKey,
    parts: pending.parts,
    expectedMimeType: pending.mimeType,
    expectedSizeBytes: pending.sizeBytes,
  });
  return {
    storageKey: pending.storageKey,
    expectedMimeType: pending.mimeType,
    expectedSizeBytes: pending.sizeBytes,
    expectedChecksumSha256: pending.checksumSha256,
  };
}

async function verifyProcessed(
  storage: LocalFilesystemMediaStorage,
  processed: Awaited<ReturnType<LocalFilesystemMediaStorage['processVideo']>>,
  name: string,
) {
  invariant(processed.durationSeconds > 0, `${name}: duration is absent`);
  invariant(
    processed.signatureValid && processed.integrityValid && processed.manifestValid,
    `${name}: validation failed`,
  );

  const manifestObject = await storage.readObject({ storageKey: processed.manifestStorageKey });
  const manifest = (await bodyBuffer(manifestObject.body)).toString('utf8');
  const mediaManifestName = manifest
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.endsWith('.m3u8'));
  invariant(mediaManifestName, `${name}: HLS media manifest is absent`);
  const manifestDirectory = processed.manifestStorageKey.slice(0, processed.manifestStorageKey.lastIndexOf('/'));
  const mediaManifestObject = await storage.readObject({
    storageKey: `${manifestDirectory}/${mediaManifestName}`,
  });
  const mediaManifest = (await bodyBuffer(mediaManifestObject.body)).toString('utf8');
  const segment = mediaManifest
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.endsWith('.ts'));
  invariant(segment, `${name}: HLS segment is absent`);
  const segmentObject = await storage.readObject({
    storageKey: `${manifestDirectory}/${segment}`,
    range: 'bytes=0-3',
  });
  invariant(
    segmentObject.contentLength === 4 && segmentObject.contentRange?.startsWith('bytes 0-3/'),
    `${name}: Range failed`,
  );
  invariant((await bodyBuffer(segmentObject.body)).length === 4, `${name}: Range body failed`);

  const poster = await bodyBuffer((await storage.readObject({ storageKey: processed.posterStorageKey })).body);
  invariant(poster.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), `${name}: poster is not JPEG`);
  const speech = await bodyBuffer((await storage.readObject({ storageKey: processed.audioStorageKey })).body);
  invariant(speech.subarray(0, 4).toString('ascii') === 'OggS', `${name}: speech rendition is not OGG`);
}

async function acceptContainer(
  storage: LocalFilesystemMediaStorage,
  fixturePath: string,
  name: 'mp4' | 'mov' | 'webm',
  mimeType: string,
) {
  const source = await uploadSource(storage, {
    bytes: await readFile(fixturePath),
    mimeType,
    storageKey: `acceptance/${name}/source`,
  });
  const processed = await storage.processVideo(source);
  await verifyProcessed(storage, processed, name);
  return { container: name, durationSeconds: processed.durationSeconds, range: true, poster: true, speech: true };
}

async function expectSafeCode(task: () => Promise<unknown>, expectedCode: string) {
  try {
    await task();
  } catch (error) {
    if (error instanceof SafeMediaProviderError && error.safeCode === expectedCode) return expectedCode;
    throw error;
  }
  throw new Error(`Expected safe media failure: ${expectedCode}`);
}

function restartRoot() {
  invariant(env.NODE_ENV === 'test', 'Restart acceptance is test-only');
  invariant(process.env.MEDIA_ACCEPTANCE_RESTART === 'on', 'MEDIA_ACCEPTANCE_RESTART=on is required');
  invariant(env.MEDIA_LOCAL_ROOT, 'MEDIA_LOCAL_ROOT is required');
  return env.MEDIA_LOCAL_ROOT;
}

function parsePendingUpload(raw: string): PendingUpload {
  const value = JSON.parse(raw) as Partial<PendingUpload>;
  invariant(value.version === 1, 'Restart state version is invalid');
  invariant(
    typeof value.providerUploadKey === 'string' && /^[0-9a-f-]{36}$/i.test(value.providerUploadKey),
    'Restart upload key is invalid',
  );
  invariant(value.storageKey === 'acceptance/restart/source', 'Restart storage key is invalid');
  invariant(value.mimeType === 'video/mp4', 'Restart MIME is invalid');
  invariant(typeof value.sizeBytes === 'string' && /^\d+$/.test(value.sizeBytes), 'Restart size is invalid');
  invariant(
    typeof value.checksumSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.checksumSha256),
    'Restart checksum is invalid',
  );
  invariant(
    Array.isArray(value.parts) &&
      value.parts.length === 2 &&
      value.parts.every(
        (part, index) =>
          part.partNumber === index + 1 && typeof part.etag === 'string' && /^[0-9a-f]{64}$/.test(part.etag),
      ),
    'Restart parts are invalid',
  );
  return value as PendingUpload;
}

async function writeRestartCheckpoint() {
  const root = restartRoot();
  const workspace = await mkdtemp(join(tmpdir(), 'aspb-media-restart-upload-'));
  try {
    const fixture = join(workspace, 'restart.mp4');
    await createFixture(fixture, 'mp4');
    const pending = await beginUploadSource(new LocalFilesystemMediaStorage(root), {
      bytes: await readFile(fixture),
      mimeType: 'video/mp4',
      storageKey: 'acceptance/restart/source',
    });
    const state: PendingUpload = {
      version: 1,
      providerUploadKey: pending.providerUploadKey,
      storageKey: pending.storageKey,
      mimeType: pending.mimeType,
      sizeBytes: String(pending.sizeBytes),
      checksumSha256: pending.checksumSha256,
      parts: pending.parts,
    };
    await writeFile(join(root, RESTART_STATE_FILE), `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: true, phase: 'upload', checkpointedParts: state.parts.length })}\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function resumeAfterRestart() {
  const root = restartRoot();
  const statePath = join(root, RESTART_STATE_FILE);
  const state = parsePendingUpload(await readFile(statePath, 'utf8'));
  const storage = new LocalFilesystemMediaStorage(root);
  const reconciled = await storage.listMultipartUploadParts({
    providerUploadKey: state.providerUploadKey,
    storageKey: state.storageKey,
  });
  invariant(JSON.stringify(reconciled) === JSON.stringify(state.parts), 'Restart reconciliation differs');
  await storage.completeMultipartUpload({
    providerUploadKey: state.providerUploadKey,
    storageKey: state.storageKey,
    parts: state.parts,
    expectedMimeType: state.mimeType,
    expectedSizeBytes: BigInt(state.sizeBytes),
  });
  const processed = await storage.processVideo({
    storageKey: state.storageKey,
    expectedMimeType: state.mimeType,
    expectedSizeBytes: BigInt(state.sizeBytes),
    expectedChecksumSha256: state.checksumSha256,
  });
  await verifyProcessed(storage, processed, 'restart');
  await rm(statePath, { force: true });
  process.stdout.write(`${JSON.stringify({ ok: true, phase: 'resume', reconciledParts: reconciled.length })}\n`);
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 'aspb-media-acceptance-'));
  const storageRoot = join(workspace, 'storage');
  const storage = new LocalFilesystemMediaStorage(storageRoot);
  const original = {
    ffmpegPath: env.MEDIA_FFMPEG_PATH,
    ffprobePath: env.MEDIA_FFPROBE_PATH,
    transcodeTimeoutSeconds: env.MEDIA_TRANSCODE_TIMEOUT_SECONDS,
    maxDurationSeconds: env.MEDIA_MAX_DURATION_SECONDS,
    minFreeInodes: env.MEDIA_MIN_FREE_INODES,
  };
  try {
    const fixtures = {
      mp4: join(workspace, 'fixture.mp4'),
      mov: join(workspace, 'fixture.mov'),
      webm: join(workspace, 'fixture.webm'),
    };
    await createFixture(fixtures.mp4, 'mp4');
    await createFixture(fixtures.mov, 'mov');
    await createFixture(fixtures.webm, 'webm');

    const accepted = [];
    accepted.push(await acceptContainer(storage, fixtures.mp4, 'mp4', 'video/mp4'));
    accepted.push(await acceptContainer(storage, fixtures.mov, 'mov', 'video/quicktime'));
    accepted.push(await acceptContainer(storage, fixtures.webm, 'webm', 'video/webm'));

    const mp4Bytes = await readFile(fixtures.mp4);
    const corrupt = await uploadSource(storage, {
      bytes: Buffer.alloc(1_024, 0xa5),
      mimeType: 'video/mp4',
      storageKey: 'acceptance/corrupt/source',
    });
    const wrongMime = await uploadSource(storage, {
      bytes: mp4Bytes,
      mimeType: 'video/webm',
      storageKey: 'acceptance/wrong-mime/source',
    });
    const validSource = {
      storageKey: 'acceptance/mp4/source',
      expectedMimeType: 'video/mp4',
      expectedSizeBytes: BigInt(mp4Bytes.length),
      expectedChecksumSha256: crypto.createHash('sha256').update(mp4Bytes).digest('hex'),
    };
    const rejected = [
      await expectSafeCode(() => storage.processVideo(corrupt), 'media_signature_invalid'),
      await expectSafeCode(() => storage.processVideo(wrongMime), 'media_mime_mismatch'),
      await expectSafeCode(
        () => storage.processVideo({ ...validSource, expectedChecksumSha256: '0'.repeat(64) }),
        'media_integrity_failed',
      ),
    ];

    env.MEDIA_MAX_DURATION_SECONDS = 0.5;
    rejected.push(await expectSafeCode(() => storage.processVideo(validSource), 'media_duration_exceeded'));
    env.MEDIA_MAX_DURATION_SECONDS = original.maxDurationSeconds;

    const malformedProbe = join(workspace, 'malformed-probe');
    await writeFile(malformedProbe, '#!/usr/bin/env node\nprocess.stdout.write("{malformed");\n', { mode: 0o700 });
    await chmod(malformedProbe, 0o700);
    env.MEDIA_FFPROBE_PATH = malformedProbe;
    rejected.push(await expectSafeCode(() => storage.processVideo(validSource), 'media_processing_failed'));
    env.MEDIA_FFPROBE_PATH = original.ffprobePath;

    const unsupportedContainerProbe = join(workspace, 'unsupported-container-probe');
    await writeFile(
      unsupportedContainerProbe,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({format:{duration:"1",format_name:"avi"},streams:[{codec_type:"video",codec_name:"h264",width:320,height:180},{codec_type:"audio",codec_name:"aac"}]}));\n',
      { mode: 0o700 },
    );
    await chmod(unsupportedContainerProbe, 0o700);
    env.MEDIA_FFPROBE_PATH = unsupportedContainerProbe;
    rejected.push(await expectSafeCode(() => storage.processVideo(validSource), 'media_container_unsupported'));

    const unsupportedCodecProbe = join(workspace, 'unsupported-codec-probe');
    await writeFile(
      unsupportedCodecProbe,
      '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({format:{duration:"1",format_name:"mov,mp4,m4a,3gp,3g2,mj2"},streams:[{codec_type:"video",codec_name:"mpeg2video",width:320,height:180},{codec_type:"audio",codec_name:"aac"}]}));\n',
      { mode: 0o700 },
    );
    await chmod(unsupportedCodecProbe, 0o700);
    env.MEDIA_FFPROBE_PATH = unsupportedCodecProbe;
    rejected.push(await expectSafeCode(() => storage.processVideo(validSource), 'media_codec_unsupported'));
    env.MEDIA_FFPROBE_PATH = original.ffprobePath;

    const hangingProbe = join(workspace, 'hanging-ffprobe');
    await writeFile(hangingProbe, '#!/usr/bin/env node\nsetTimeout(() => undefined, 60_000);\n', { mode: 0o700 });
    await chmod(hangingProbe, 0o700);
    env.MEDIA_FFPROBE_PATH = hangingProbe;
    env.MEDIA_TRANSCODE_TIMEOUT_SECONDS = 0.05;
    rejected.push(await expectSafeCode(() => storage.processVideo(validSource), 'media_probe_timeout'));
    env.MEDIA_FFPROBE_PATH = original.ffprobePath;
    env.MEDIA_TRANSCODE_TIMEOUT_SECONDS = original.transcodeTimeoutSeconds;

    const hangingFfmpeg = join(workspace, 'hanging-ffmpeg');
    await writeFile(hangingFfmpeg, '#!/usr/bin/env node\nsetTimeout(() => undefined, 60_000);\n', { mode: 0o700 });
    await chmod(hangingFfmpeg, 0o700);
    env.MEDIA_FFMPEG_PATH = hangingFfmpeg;
    env.MEDIA_TRANSCODE_TIMEOUT_SECONDS = 0.05;
    rejected.push(await expectSafeCode(() => storage.processVideo(validSource), 'media_transcode_timeout'));

    env.MEDIA_FFMPEG_PATH = original.ffmpegPath;
    env.MEDIA_TRANSCODE_TIMEOUT_SECONDS = original.transcodeTimeoutSeconds;
    env.MEDIA_MIN_FREE_INODES = Number.MAX_SAFE_INTEGER;
    rejected.push(await expectSafeCode(() => storage.processVideo(validSource), 'media_capacity_insufficient'));

    process.stdout.write(`${JSON.stringify({ ok: true, accepted, rejected })}\n`);
  } finally {
    env.MEDIA_FFMPEG_PATH = original.ffmpegPath;
    env.MEDIA_FFPROBE_PATH = original.ffprobePath;
    env.MEDIA_TRANSCODE_TIMEOUT_SECONDS = original.transcodeTimeoutSeconds;
    env.MEDIA_MAX_DURATION_SECONDS = original.maxDurationSeconds;
    env.MEDIA_MIN_FREE_INODES = original.minFreeInodes;
    await rm(workspace, { recursive: true, force: true });
  }
}

const command = process.argv[2];
const task =
  command === '--restart-upload'
    ? writeRestartCheckpoint()
    : command === '--restart-resume'
      ? resumeAfterRestart()
      : main();

task.catch(error => {
  const code = error instanceof SafeMediaProviderError ? error.safeCode : 'media_acceptance_failed';
  process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`);
  process.exitCode = 1;
});
