import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, stat, statfs, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { env } from './env.js';

const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

export class SafeMediaProviderError extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
    this.name = 'SafeMediaProviderError';
  }
}

export function contentTypeForMediaArtifact(fileName: string) {
  if (fileName.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (fileName.endsWith('.ts')) return 'video/mp2t';
  if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) return 'image/jpeg';
  if (fileName.endsWith('.ogg')) return 'audio/ogg';
  return 'application/octet-stream';
}

export async function sha256File(path: string) {
  const hash = crypto.createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export async function getMediaWorkCapacity() {
  const root = env.MEDIA_WORK_ROOT ?? tmpdir();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const capacity = await statfs(root, { bigint: true });
  return {
    totalBytes: capacity.blocks * capacity.bsize,
    availableBytes: capacity.bavail * capacity.bsize,
    totalInodes: capacity.files,
    availableInodes: capacity.ffree,
  };
}

export async function createMediaWorkDirectory(prefix: string, expectedSourceBytes: bigint) {
  const capacity = await getMediaWorkCapacity();
  const requiredBytes =
    expectedSourceBytes * BigInt(env.MEDIA_PROCESSING_SPACE_MULTIPLIER) + BigInt(env.MEDIA_PROCESSING_RESERVE_BYTES);
  if (capacity.availableBytes < requiredBytes || capacity.availableInodes < BigInt(env.MEDIA_MIN_FREE_INODES)) {
    throw new SafeMediaProviderError('media_capacity_insufficient');
  }
  return mkdtemp(join(env.MEDIA_WORK_ROOT ?? tmpdir(), prefix));
}

export function sniffVideoMime(header: Buffer) {
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
    throw new SafeMediaProviderError(detectedMimeType ? 'media_mime_mismatch' : 'media_signature_invalid');
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
    'media_processing_failed',
  );
  let probe: ProbeJson;
  try {
    probe = JSON.parse(result.stdout) as ProbeJson;
  } catch {
    throw new SafeMediaProviderError('media_processing_failed');
  }
  const duration = Number(probe.format?.duration);
  const video = probe.streams?.find(stream => stream.codec_type === 'video');
  const audio = probe.streams?.find(stream => stream.codec_type === 'audio');
  const allowedVideoCodecs = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
  const allowedAudioCodecs = new Set(['aac', 'opus', 'vorbis', 'mp3']);
  const allowedContainersByMime: Record<string, Set<string>> = {
    'video/mp4': new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2']),
    'video/quicktime': new Set(['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2']),
    'video/webm': new Set(['matroska', 'webm']),
  };
  const containers = new Set((probe.format?.format_name ?? '').split(',').filter(Boolean));
  if (![...containers].some(container => allowedContainersByMime[expectedMimeType]?.has(container))) {
    throw new SafeMediaProviderError('media_container_unsupported');
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new SafeMediaProviderError('media_processing_failed');
  }
  if (!video?.codec_name || !allowedVideoCodecs.has(video.codec_name)) {
    throw new SafeMediaProviderError('media_codec_unsupported');
  }
  if (!audio?.codec_name) throw new SafeMediaProviderError('media_codec_unsupported');
  if (!allowedAudioCodecs.has(audio.codec_name)) throw new SafeMediaProviderError('media_codec_unsupported');
  if (duration > env.MEDIA_MAX_DURATION_SECONDS) throw new SafeMediaProviderError('media_duration_exceeded');
  if (!video.width || !video.height || video.width <= 0 || video.height <= 0) {
    throw new SafeMediaProviderError('media_processing_failed');
  }
  return {
    mimeType: detectedMimeType,
    durationSeconds: Math.ceil(duration),
    containerFormat: probe.format?.format_name ?? 'unknown',
    videoCodec: video.codec_name,
    audioCodec: audio.codec_name,
    width: video.width,
    height: video.height,
  };
}

function manifestResources(manifest: string) {
  return manifest
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

function resourcesArePrivateRelative(resources: string[], artifactNames: Set<string>) {
  return resources.every(resource => {
    if (resource.includes('://') || resource.includes('..') || resource.startsWith('/')) return false;
    return artifactNames.has(resource);
  });
}

function validateMediaManifest(manifest: string, artifactNames: Set<string>, expectedDurationSeconds: number) {
  if (!manifest.startsWith('#EXTM3U') || !manifest.includes('#EXTINF:')) return false;
  const resources = manifestResources(manifest);
  const durations = [...manifest.matchAll(/^#EXTINF:([0-9]+(?:\.[0-9]+)?),?/gm)].map(match => Number(match[1]));
  const duration = durations.reduce((total, value) => total + value, 0);
  return (
    resources.length > 0 &&
    resources.length === durations.length &&
    durations.every(value => Number.isFinite(value) && value > 0) &&
    Math.abs(duration - expectedDurationSeconds) <= Math.max(2, env.MEDIA_HLS_SEGMENT_SECONDS * 2) &&
    manifest.includes('#EXT-X-ENDLIST') &&
    resourcesArePrivateRelative(resources, artifactNames)
  );
}

function validateMasterManifest(manifest: string, artifactNames: Set<string>) {
  const resources = manifestResources(manifest);
  return (
    manifest.startsWith('#EXTM3U') &&
    manifest.includes('#EXT-X-STREAM-INF:') &&
    resources.length >= 1 &&
    resourcesArePrivateRelative(resources, artifactNames)
  );
}

async function checkedArtifact(path: string, signature: (header: Buffer, body: Buffer) => boolean) {
  const body = await readFile(path);
  if (!body.length || !signature(body.subarray(0, 16), body)) {
    throw new SafeMediaProviderError('media_processing_failed');
  }
  return { sizeBytes: body.length, checksumSha256: crypto.createHash('sha256').update(body).digest('hex') };
}

export async function prepareMediaRenditions(input: {
  sourcePath: string;
  workDirectory: string;
  expectedMimeType: string;
  expectedSizeBytes: bigint;
  expectedChecksumSha256?: string | null;
}) {
  const sourceStat = await stat(input.sourcePath);
  if (!sourceStat.isFile() || BigInt(sourceStat.size) !== input.expectedSizeBytes) {
    throw new SafeMediaProviderError('media_integrity_failed');
  }
  const checksumSha256 = await sha256File(input.sourcePath);
  if (input.expectedChecksumSha256 && checksumSha256 !== input.expectedChecksumSha256) {
    throw new SafeMediaProviderError('media_integrity_failed');
  }
  const probe = await probeVideo(input.sourcePath, input.expectedMimeType);
  const hlsDirectory = join(input.workDirectory, 'hls');
  const posterPath = join(input.workDirectory, 'poster.jpg');
  const speechAudioPath = join(input.workDirectory, 'speech.ogg');
  await mkdir(hlsDirectory, { recursive: true, mode: 0o700 });
  await runTool(
    env.MEDIA_FFMPEG_PATH,
    [
      '-nostdin',
      '-y',
      '-i',
      input.sourcePath,
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
      join(hlsDirectory, 'media.m3u8'),
    ],
    env.MEDIA_TRANSCODE_TIMEOUT_SECONDS * 1_000,
    'media_transcode_timeout',
    'media_transcode_failed',
  );
  await writeFile(
    join(hlsDirectory, 'master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=${probe.width}x${probe.height},CODECS="avc1.64001f,mp4a.40.2"`,
      'media.m3u8',
      '',
    ].join('\n'),
    { encoding: 'utf8', mode: 0o600 },
  );
  await runTool(
    env.MEDIA_FFMPEG_PATH,
    [
      '-nostdin',
      '-y',
      '-i',
      input.sourcePath,
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
      input.sourcePath,
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
  const masterManifest = await readFile(join(hlsDirectory, 'master.m3u8'), 'utf8');
  const mediaManifest = await readFile(join(hlsDirectory, 'media.m3u8'), 'utf8');
  if (
    !validateMasterManifest(masterManifest, artifactNames) ||
    !validateMediaManifest(mediaManifest, artifactNames, probe.durationSeconds)
  ) {
    throw new SafeMediaProviderError('media_processing_failed');
  }
  const segmentNames = [...artifactNames].filter(name => /^segment-\d{6}\.ts$/.test(name)).sort();
  if (!segmentNames.length) throw new SafeMediaProviderError('media_processing_failed');
  const hlsArtifacts = await Promise.all(
    [...artifactNames].sort().map(async relativeName => {
      const role =
        relativeName === 'master.m3u8'
          ? ('hls_master' as const)
          : relativeName === 'media.m3u8'
            ? ('hls_media' as const)
            : ('hls_segment' as const);
      const checked = await checkedArtifact(join(hlsDirectory, relativeName), (header, body) =>
        relativeName.endsWith('.m3u8') ? body.toString('utf8').startsWith('#EXTM3U') : header[0] === 0x47,
      );
      return { role, relativeName, contentType: contentTypeForMediaArtifact(relativeName), ...checked };
    }),
  );
  const poster = await checkedArtifact(
    posterPath,
    (header, body) => header[0] === 0xff && header[1] === 0xd8 && body.at(-2) === 0xff && body.at(-1) === 0xd9,
  );
  const speech = await checkedArtifact(speechAudioPath, header => header.subarray(0, 4).toString('ascii') === 'OggS');
  return {
    ...probe,
    checksumSha256,
    artifactNames: [...artifactNames].sort(),
    hlsDirectory,
    posterPath,
    speechAudioPath,
    speechSizeBytes: BigInt(speech.sizeBytes),
    renditionsMetadata: [
      ...hlsArtifacts,
      { role: 'poster' as const, relativeName: 'poster.jpg', contentType: 'image/jpeg', ...poster },
      { role: 'speech' as const, relativeName: 'speech.ogg', contentType: 'audio/ogg', ...speech },
    ],
  };
}
