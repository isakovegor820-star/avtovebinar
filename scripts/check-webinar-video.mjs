#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseDotenv } from 'dotenv';

const DEFAULT_VIDEO_URL = 'https://aspb-partners.ru/crisis_premium/assets/media/vasiliy-artin-2026-06-10/video.mp4';
const DEFAULT_DURATION_SECONDS = 3860;
const DEFAULT_TOLERANCE_SECONDS = 5;
const MAX_HLS_MANIFEST_BYTES = 1024 * 1024;
const MAX_HTTP_REDIRECTS = 5;
const HLS_SEGMENT_PROBE_BYTES = 64 * 1024;
const MP4_METADATA_PROBE_BYTES = 2 * 1024 * 1024;

function optionalValue(value) {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

function positiveNumber(value, name, fallback) {
  const resolved = optionalValue(value) ?? String(fallback);
  const number = Number(resolved);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return number;
}

export function resolveVideoCheckConfig({ environment = process.env, cwd = process.cwd() } = {}) {
  const envFile =
    optionalValue(environment.VIDEO_ENV_FILE) ?? optionalValue(environment.COMPOSE_ENV_FILE) ?? path.join(cwd, '.env');
  const fileEnvironment = existsSync(envFile) ? parseDotenv(readFileSync(envFile)) : {};
  const values = { ...fileEnvironment, ...environment };
  const hlsUrl = optionalValue(values.WEBINAR_VIDEO_HLS_URL);
  const mp4Url = optionalValue(values.WEBINAR_VIDEO_URL);
  const source = hlsUrl ?? mp4Url ?? DEFAULT_VIDEO_URL;
  const sourceKind = hlsUrl ? 'HLS' : 'MP4';
  const expectedDurationSeconds = positiveNumber(
    values.WEBINAR_VIDEO_DURATION_SECONDS,
    'WEBINAR_VIDEO_DURATION_SECONDS',
    DEFAULT_DURATION_SECONDS,
  );
  const toleranceSeconds = positiveNumber(
    values.WEBINAR_VIDEO_DURATION_TOLERANCE_SECONDS,
    'WEBINAR_VIDEO_DURATION_TOLERANCE_SECONDS',
    DEFAULT_TOLERANCE_SECONDS,
  );
  const originToken = optionalValue(values.WEBINAR_MEDIA_ORIGIN_TOKEN);

  let probeSource = source;
  try {
    const publicSiteUrl = new URL(optionalValue(values.PUBLIC_SITE_URL) ?? 'http://127.0.0.1:5174');
    const sourceUrl = new URL(source, publicSiteUrl);
    if (sourceUrl.origin === publicSiteUrl.origin && sourceUrl.pathname.startsWith('/crisis_premium/')) {
      const relativePath = decodeURIComponent(sourceUrl.pathname.slice('/crisis_premium/'.length));
      const frontendRoot = path.resolve(cwd, 'crisis_premium');
      const localPath = path.resolve(frontendRoot, relativePath);
      if (localPath !== frontendRoot && !localPath.startsWith(`${frontendRoot}${path.sep}`)) {
        throw new Error('Configured local webinar source escapes crisis_premium');
      }
      probeSource = localPath;
    }
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Configured webinar source must be a valid URL');
    throw error;
  }
  if (/^https?:\/\//i.test(probeSource)) {
    const remoteSource = new URL(probeSource);
    if (remoteSource.username || remoteSource.password) {
      throw new Error('Configured webinar source must not contain URL credentials');
    }
    if (originToken && remoteSource.protocol !== 'https:') {
      throw new Error('Private webinar media with an origin token must use HTTPS');
    }
  }

  return {
    sourceKind,
    probeSource,
    expectedDurationSeconds,
    toleranceSeconds,
    originToken,
  };
}

export function assertExpectedDuration(actualDurationSeconds, expectedDurationSeconds, toleranceSeconds) {
  if (!Number.isFinite(actualDurationSeconds) || actualDurationSeconds <= 0) {
    throw new Error('Media probe did not return a valid duration');
  }
  if (Math.abs(actualDurationSeconds - expectedDurationSeconds) > toleranceSeconds) {
    throw new Error(
      `Configured media duration is ${actualDurationSeconds.toFixed(1)}s; expected ${expectedDurationSeconds}s (±${toleranceSeconds}s)`,
    );
  }
}

function authOriginsForSource(source) {
  const origins = new Set();
  if (/^https?:\/\//i.test(source)) {
    const sourceUrl = new URL(source);
    if (sourceUrl.username || sourceUrl.password) {
      throw new Error('Configured webinar media URL must not contain credentials');
    }
    if (sourceUrl.protocol === 'https:') origins.add(sourceUrl.origin);
  }
  return origins;
}

function requestHeaders(source, originToken, authAllowedOrigins, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (originToken && /^https:\/\//i.test(source) && authAllowedOrigins.has(new URL(source).origin)) {
    headers.authorization = `Bearer ${originToken}`;
  }
  return headers;
}

async function fetchWithAuthPolicy(source, { originToken, authAllowedOrigins, fetchImpl, range, timeoutMs }) {
  let currentSource = source;
  for (let redirectCount = 0; redirectCount <= MAX_HTTP_REDIRECTS; redirectCount += 1) {
    const currentUrl = new URL(currentSource);
    if (currentUrl.username || currentUrl.password) {
      throw new Error('Configured webinar media URL must not contain credentials');
    }
    if (originToken && currentUrl.protocol !== 'https:') {
      throw new Error('Private webinar media with an origin token must use HTTPS');
    }
    const response = await fetchImpl(currentSource, {
      headers: requestHeaders(currentSource, originToken, authAllowedOrigins, range ? { range } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, finalSource: currentSource };
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('Configured webinar media redirect has no location');
    await response.body?.cancel().catch(() => undefined);
    const redirected = new URL(location, currentSource);
    if (!['http:', 'https:'].includes(redirected.protocol) || redirected.username || redirected.password) {
      throw new Error('Configured webinar media redirect must use HTTP(S) without URL credentials');
    }
    if (originToken && redirected.protocol !== 'https:') {
      throw new Error('Private webinar media redirect must not downgrade from HTTPS');
    }
    currentSource = redirected.toString();
  }
  throw new Error('Configured webinar media contains too many redirects');
}

async function readHlsManifest(source, originToken, fetchImpl, authAllowedOrigins) {
  if (!/^https?:\/\//i.test(source)) {
    const file = await open(source, 'r');
    try {
      const { size } = await file.stat();
      if (size > MAX_HLS_MANIFEST_BYTES) throw new Error('Configured HLS manifest exceeds 1 MiB');
      const buffer = Buffer.alloc(MAX_HLS_MANIFEST_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_HLS_MANIFEST_BYTES) throw new Error('Configured HLS manifest exceeds 1 MiB');
      return { manifest: buffer.subarray(0, bytesRead).toString('utf8'), finalSource: source };
    } finally {
      await file.close();
    }
  }
  const { response, finalSource } = await fetchWithAuthPolicy(source, {
    originToken,
    authAllowedOrigins,
    fetchImpl,
    timeoutMs: 60_000,
  });
  if (!response.ok) throw new Error('Configured HLS webinar source is unavailable or unreadable');
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_HLS_MANIFEST_BYTES) {
    throw new Error('Configured HLS manifest exceeds 1 MiB');
  }
  const bytes = await readBoundedResponse(response, MAX_HLS_MANIFEST_BYTES + 1);
  if (bytes.length > MAX_HLS_MANIFEST_BYTES) throw new Error('Configured HLS manifest exceeds 1 MiB');
  return { manifest: bytes.toString('utf8'), finalSource };
}

function resolveManifestChild(parent, child) {
  if (/^https?:\/\//i.test(parent)) {
    const resolved = new URL(child, parent);
    if (!['http:', 'https:'].includes(resolved.protocol) || resolved.username || resolved.password) {
      throw new Error('Configured HLS manifest contains an unsafe child URL');
    }
    return resolved.toString();
  }
  if (/^https?:\/\//i.test(child)) {
    const resolved = new URL(child);
    if (resolved.username || resolved.password) throw new Error('Configured HLS manifest contains an unsafe child URL');
    return resolved.toString();
  }
  return path.resolve(path.dirname(parent), child);
}

async function probeHlsDuration(source, originToken) {
  return probeHlsSource(source, originToken);
}

async function readBoundedResponse(response, maxBytes) {
  if (!response.body) throw new Error('Configured webinar media response has no body');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - length;
      const chunk = Buffer.from(value).subarray(0, remaining);
      chunks.push(chunk);
      length += chunk.length;
      if (chunk.length < value.length) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, length);
}

function tsPacketPayload(packet) {
  if (packet.length !== 188 || packet[0] !== 0x47 || (packet[1] & 0x80) !== 0) return null;
  const adaptationFieldControl = (packet[3] >> 4) & 0x03;
  if (adaptationFieldControl === 0 || adaptationFieldControl === 2) return null;
  let payloadOffset = 4;
  if (adaptationFieldControl === 3) {
    payloadOffset += 1 + packet[4];
    if (payloadOffset > packet.length) return null;
  }
  return packet.subarray(payloadOffset);
}

function parseTransportPackets(bytes) {
  let syncOffset = -1;
  for (let candidate = 0; candidate < 188; candidate += 1) {
    let consecutive = 0;
    for (let offset = candidate; offset < bytes.length && consecutive < 5; offset += 188) {
      if (bytes[offset] !== 0x47) break;
      consecutive += 1;
    }
    if (consecutive >= 3) {
      syncOffset = candidate;
      break;
    }
  }
  if (syncOffset < 0) throw new Error('MPEG-TS packet synchronization is missing');

  const packets = [];
  for (let offset = syncOffset; offset + 188 <= bytes.length; offset += 188) {
    const packet = bytes.subarray(offset, offset + 188);
    if (packet[0] !== 0x47 || (packet[1] & 0x80) !== 0) break;
    packets.push({
      pid: ((packet[1] & 0x1f) << 8) | packet[2],
      payloadUnitStart: (packet[1] & 0x40) !== 0,
      payload: tsPacketPayload(packet),
    });
  }
  if (packets.length < 3) throw new Error('MPEG-TS probe contains too few complete packets');
  return packets;
}

function collectPsiSections(packets, pid) {
  const sections = [];
  let pending = Buffer.alloc(0);

  const drain = () => {
    while (pending.length >= 3 && pending[0] !== 0xff) {
      const sectionLength = ((pending[1] & 0x0f) << 8) | pending[2];
      if (sectionLength < 4 || sectionLength > 1021) throw new Error('MPEG-TS PSI section length is invalid');
      const totalLength = 3 + sectionLength;
      if (pending.length < totalLength) return;
      sections.push(pending.subarray(0, totalLength));
      pending = pending.subarray(totalLength);
    }
  };

  for (const packet of packets) {
    if (packet.pid !== pid || !packet.payload?.length) continue;
    let payload = packet.payload;
    if (packet.payloadUnitStart) {
      const pointer = payload[0];
      if (pointer + 1 > payload.length) throw new Error('MPEG-TS PSI pointer is invalid');
      if (pending.length && pointer > 0) {
        pending = Buffer.concat([pending, payload.subarray(1, 1 + pointer)]);
        drain();
      }
      pending = payload.subarray(1 + pointer);
    } else if (pending.length) {
      pending = Buffer.concat([pending, payload]);
    } else {
      continue;
    }
    drain();
  }
  return sections;
}

function mpeg2Crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

function assertPsiSection(section, tableId, minimumLength, label) {
  if (section.length < minimumLength || section[0] !== tableId || (section[1] & 0x80) === 0) {
    throw new Error(`MPEG-TS ${label} is malformed`);
  }
  if ((section[5] & 0x01) === 0) throw new Error(`MPEG-TS ${label} is not current`);
  if (mpeg2Crc32(section) !== 0) throw new Error(`MPEG-TS ${label} CRC is invalid`);
}

function assertMpegTsProgramStructure(bytes) {
  const packets = parseTransportPackets(bytes);
  const pat = collectPsiSections(packets, 0).find(section => section[0] === 0x00);
  if (!pat) throw new Error('MPEG-TS PAT is missing');
  assertPsiSection(pat, 0x00, 16, 'PAT');
  const patProgramEnd = pat.length - 4;
  const pmtPids = [];
  for (let offset = 8; offset + 4 <= patProgramEnd; offset += 4) {
    const programNumber = pat.readUInt16BE(offset);
    if (programNumber !== 0) pmtPids.push(((pat[offset + 2] & 0x1f) << 8) | pat[offset + 3]);
  }
  if (!pmtPids.length) throw new Error('MPEG-TS PAT contains no program');

  const videoStreamTypes = new Set([0x01, 0x02, 0x10, 0x1b, 0x1f, 0x20, 0x21, 0x24, 0x42]);
  for (const pmtPid of pmtPids) {
    const pmt = collectPsiSections(packets, pmtPid).find(section => section[0] === 0x02);
    if (!pmt) continue;
    assertPsiSection(pmt, 0x02, 21, 'PMT');
    const programInfoLength = ((pmt[10] & 0x0f) << 8) | pmt[11];
    const streamEnd = pmt.length - 4;
    let offset = 12 + programInfoLength;
    while (offset + 5 <= streamEnd) {
      const streamType = pmt[offset];
      const elementaryPid = ((pmt[offset + 1] & 0x1f) << 8) | pmt[offset + 2];
      const elementaryInfoLength = ((pmt[offset + 3] & 0x0f) << 8) | pmt[offset + 4];
      if (videoStreamTypes.has(streamType)) {
        const videoPes = packets.find(packet => {
          if (packet.pid !== elementaryPid || !packet.payloadUnitStart || !packet.payload || packet.payload.length < 4) {
            return false;
          }
          const pesHeaderLength = packet.payload[8];
          const elementaryPayloadOffset = 9 + pesHeaderLength;
          return (
            packet.payload.length >= 13 &&
            packet.payload[0] === 0x00 &&
            packet.payload[1] === 0x00 &&
            packet.payload[2] === 0x01 &&
            packet.payload[3] >= 0xe0 &&
            packet.payload[3] <= 0xef &&
            (packet.payload[6] & 0xc0) === 0x80 &&
            elementaryPayloadOffset + 3 < packet.payload.length &&
            packet.payload
              .subarray(elementaryPayloadOffset)
              .some(byte => byte !== 0xff)
          );
        });
        if (videoPes) return;
      }
      offset += 5 + elementaryInfoLength;
    }
  }
  throw new Error('MPEG-TS PMT with a video stream is missing');
}

function readIsoBox(buffer, offset, parentEnd = buffer.length) {
  if (offset + 8 > parentEnd) throw new Error('ISO-BMFF box header is truncated');
  const size32 = buffer.readUInt32BE(offset);
  const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
  if (!/^[\x20-\x7e]{4}$/.test(type)) throw new Error('ISO-BMFF box type is invalid');
  let headerSize = 8;
  let size = size32;
  if (size32 === 1) {
    if (offset + 16 > parentEnd) throw new Error('ISO-BMFF extended box header is truncated');
    const extendedSize = buffer.readBigUInt64BE(offset + 8);
    if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('ISO-BMFF box is too large');
    size = Number(extendedSize);
    headerSize = 16;
  } else if (size32 === 0) {
    size = parentEnd - offset;
  }
  if (size < headerSize) throw new Error('ISO-BMFF box size is invalid');
  return { type, size, headerSize, start: offset, payloadStart: offset + headerSize, end: offset + size };
}

function parseIsoChildren(buffer, parent) {
  const children = [];
  let offset = parent.payloadStart;
  while (offset < parent.end) {
    const child = readIsoBox(buffer, offset, parent.end);
    if (child.end > parent.end) throw new Error(`ISO-BMFF ${child.type} child exceeds its parent`);
    children.push(child);
    offset = child.end;
  }
  if (offset !== parent.end) throw new Error('ISO-BMFF child layout is invalid');
  return children;
}

function assertFullBox(buffer, box, minimumPayloadLength, allowedVersions, label) {
  const payloadLength = box.end - box.payloadStart;
  if (payloadLength < minimumPayloadLength) throw new Error(`ISO-BMFF ${label} box is truncated`);
  const version = buffer[box.payloadStart];
  if (!allowedVersions.includes(version)) throw new Error(`ISO-BMFF ${label} version is unsupported`);
  return version;
}

function assertFragmentedMp4Structure(bytes) {
  const topLevel = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const box = readIsoBox(bytes, offset);
    topLevel.push(box);
    if (box.end > bytes.length) {
      if (box.type !== 'mdat') throw new Error(`ISO-BMFF ${box.type} box is truncated`);
      break;
    }
    offset = box.end;
  }
  const moof = topLevel.find(box => box.type === 'moof' && box.end <= bytes.length);
  const mdat = topLevel.find(box => box.type === 'mdat');
  if (!moof || !mdat) throw new Error('fMP4 segment must contain structured moof and mdat boxes');
  const moofChildren = parseIsoChildren(bytes, moof);
  const mfhd = moofChildren.find(box => box.type === 'mfhd');
  if (!mfhd) throw new Error('fMP4 moof has no mfhd box');
  assertFullBox(bytes, mfhd, 8, [0], 'mfhd');
  if (bytes.readUInt32BE(mfhd.payloadStart + 4) === 0) throw new Error('fMP4 mfhd sequence number is invalid');
  const trafBoxes = moofChildren.filter(box => box.type === 'traf');
  if (!trafBoxes.length) throw new Error('fMP4 moof has no traf box');
  const hasTrackRun = trafBoxes.some(traf => {
    const children = parseIsoChildren(bytes, traf);
    const tfhd = children.find(box => box.type === 'tfhd');
    const trun = children.find(box => box.type === 'trun');
    if (!tfhd || !trun) return false;
    assertFullBox(bytes, tfhd, 8, [0], 'tfhd');
    assertFullBox(bytes, trun, 8, [0, 1], 'trun');
    return bytes.readUInt32BE(tfhd.payloadStart + 4) > 0 && bytes.readUInt32BE(trun.payloadStart + 4) > 0;
  });
  if (!hasTrackRun) throw new Error('fMP4 traf must contain tfhd and trun boxes');
}

function assertPlayableSegmentSignature(bytes) {
  const prefix = bytes.subarray(0, 128).toString('utf8').trimStart().toLowerCase();
  if (prefix.startsWith('<') || prefix.startsWith('{') || prefix.startsWith('[')) {
    throw new Error('Configured HLS media segment returned text instead of media');
  }
  try {
    assertMpegTsProgramStructure(bytes);
    return;
  } catch {
    // A segment may instead be fragmented MP4; validate real box structure.
  }
  try {
    assertFragmentedMp4Structure(bytes);
    return;
  } catch {
    throw new Error('Configured HLS segment has no valid MPEG-TS PAT/PMT or structured fragmented-MP4 payload');
  }
}

async function probeBoundedResource(
  source,
  originToken,
  fetchImpl,
  authAllowedOrigins,
  maxBytes = HLS_SEGMENT_PROBE_BYTES,
) {
  if (!/^https?:\/\//i.test(source)) {
    const file = await open(source, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await file.read(buffer, 0, maxBytes, 0);
      if (bytesRead <= 0) throw new Error('Configured webinar media segment is empty');
      const bytes = buffer.subarray(0, bytesRead);
      assertPlayableSegmentSignature(bytes);
      return bytes;
    } finally {
      await file.close();
    }
  }

  const { response } = await fetchWithAuthPolicy(source, {
    originToken,
    authAllowedOrigins,
    fetchImpl,
    range: `bytes=0-${maxBytes - 1}`,
    timeoutMs: 30_000,
  });
  if (!response.ok) throw new Error('Configured webinar media segment is unavailable');
  const bytes = await readBoundedResponse(response, maxBytes);
  if (bytes.length <= 0) throw new Error('Configured webinar media segment is empty');
  assertPlayableSegmentSignature(bytes);
  return bytes;
}

function nextManifestUri(lines, startIndex) {
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#')) return lines[index];
  }
  return null;
}

async function probeHlsSourceInternal(source, originToken, fetchImpl, depth, authAllowedOrigins) {
  if (depth > 4) throw new Error('Configured HLS webinar source contains too many nested manifests');
  const { manifest, finalSource } = await readHlsManifest(source, originToken, fetchImpl, authAllowedOrigins);
  const lines = manifest
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Configured HLS webinar source is not a valid manifest');

  const segmentDurations = [];
  const segmentUris = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith('#EXTINF:')) continue;
    segmentDurations.push(Number(line.slice('#EXTINF:'.length).split(',', 1)[0]));
    const segmentUri = nextManifestUri(lines, index);
    if (!segmentUri) throw new Error('Configured HLS webinar source has a duration without a media segment');
    segmentUris.push(segmentUri);
  }
  if (segmentDurations.length > 0) {
    if (segmentDurations.some(duration => !Number.isFinite(duration) || duration <= 0)) {
      throw new Error('Configured HLS webinar source contains an invalid segment duration');
    }
    const firstSegment = resolveManifestChild(finalSource, segmentUris[0]);
    const lastSegment = resolveManifestChild(finalSource, segmentUris[segmentUris.length - 1]);
    await probeBoundedResource(firstSegment, originToken, fetchImpl, authAllowedOrigins);
    if (lastSegment !== firstSegment) {
      await probeBoundedResource(lastSegment, originToken, fetchImpl, authAllowedOrigins);
    }
    return segmentDurations.reduce((total, duration) => total + duration, 0);
  }

  const variantUris = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
    const variantUri = nextManifestUri(lines, index);
    if (variantUri && !variantUris.includes(variantUri)) variantUris.push(variantUri);
  }
  if (!variantUris.length) throw new Error('Configured HLS webinar source contains no playable variant');

  let lastError;
  for (const variantUri of variantUris.slice(0, 3)) {
    try {
      return await probeHlsSourceInternal(
        resolveManifestChild(finalSource, variantUri),
        originToken,
        fetchImpl,
        depth + 1,
        authAllowedOrigins,
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('Configured HLS webinar source contains no playable variant');
}

export async function probeHlsSource(source, originToken, fetchImpl = fetch, depth = 0) {
  const authAllowedOrigins = authOriginsForSource(source);
  return probeHlsSourceInternal(source, originToken, fetchImpl, depth, authAllowedOrigins);
}

function movieHeaderDuration(buffer, mvhd) {
  const payloadLength = mvhd.end - mvhd.payloadStart;
  const version = buffer[mvhd.payloadStart];
  const flags = buffer.readUIntBE(mvhd.payloadStart + 1, 3);
  if (flags !== 0) throw new Error('ISO-BMFF mvhd flags are invalid');
  if (version === 0) {
    if (payloadLength < 100) throw new Error('ISO-BMFF version-0 mvhd box is truncated');
    const timescale = buffer.readUInt32BE(mvhd.payloadStart + 12);
    const duration = buffer.readUInt32BE(mvhd.payloadStart + 16);
    if (timescale > 0 && duration > 0) return duration / timescale;
  } else if (version === 1) {
    if (payloadLength < 112) throw new Error('ISO-BMFF version-1 mvhd box is truncated');
    const timescale = buffer.readUInt32BE(mvhd.payloadStart + 20);
    const duration = buffer.readBigUInt64BE(mvhd.payloadStart + 24);
    if (timescale > 0 && duration > 0n && duration <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(duration) / timescale;
    }
  } else {
    throw new Error('ISO-BMFF mvhd version is unsupported');
  }
  throw new Error('ISO-BMFF mvhd duration is invalid');
}

function findRequiredChild(buffer, parent, type, label) {
  const child = parseIsoChildren(buffer, parent).find(candidate => candidate.type === type);
  if (!child) throw new Error(`ISO-BMFF ${label} has no ${type} child`);
  return child;
}

function assertVideoTrackStructure(buffer, moov) {
  const tracks = parseIsoChildren(buffer, moov).filter(box => box.type === 'trak');
  if (!tracks.length) throw new Error('ISO-BMFF moov has no track');
  const videoSampleEntryTypes = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09', 'mp4v']);

  for (const track of tracks) {
    try {
      const tkhd = findRequiredChild(buffer, track, 'tkhd', 'trak');
      const tkhdVersion = assertFullBox(buffer, tkhd, 24, [0, 1], 'tkhd');
      const trackIdOffset = tkhd.payloadStart + (tkhdVersion === 1 ? 20 : 12);
      if (buffer.readUInt32BE(trackIdOffset) === 0) throw new Error('ISO-BMFF tkhd track ID is invalid');

      const mdia = findRequiredChild(buffer, track, 'mdia', 'trak');
      const mdhd = findRequiredChild(buffer, mdia, 'mdhd', 'mdia');
      const mdhdVersion = assertFullBox(buffer, mdhd, 24, [0, 1], 'mdhd');
      const timescaleOffset = mdhd.payloadStart + (mdhdVersion === 1 ? 20 : 12);
      if (buffer.readUInt32BE(timescaleOffset) === 0) throw new Error('ISO-BMFF mdhd timescale is invalid');

      const hdlr = findRequiredChild(buffer, mdia, 'hdlr', 'mdia');
      assertFullBox(buffer, hdlr, 24, [0], 'hdlr');
      if (buffer.subarray(hdlr.payloadStart + 8, hdlr.payloadStart + 12).toString('ascii') !== 'vide') continue;

      const minf = findRequiredChild(buffer, mdia, 'minf', 'mdia');
      const stbl = findRequiredChild(buffer, minf, 'stbl', 'minf');
      const stsd = findRequiredChild(buffer, stbl, 'stsd', 'stbl');
      assertFullBox(buffer, stsd, 16, [0], 'stsd');
      const entryCount = buffer.readUInt32BE(stsd.payloadStart + 4);
      if (entryCount < 1 || entryCount > 256) throw new Error('ISO-BMFF stsd entry count is invalid');
      const firstEntry = readIsoBox(buffer, stsd.payloadStart + 8, stsd.end);
      if (firstEntry.end > stsd.end || firstEntry.size < 16 || !videoSampleEntryTypes.has(firstEntry.type)) {
        throw new Error('ISO-BMFF stsd has no supported structural video sample entry');
      }
      return;
    } catch (error) {
      if (error instanceof RangeError) throw new Error('ISO-BMFF video track metadata is truncated');
      if (error instanceof Error && /handler|vide/.test(error.message)) continue;
      throw error;
    }
  }
  throw new Error('ISO-BMFF moov has no structural video track');
}

function durationFromMoov(buffer, moov) {
  if (moov.end > buffer.length) return null;
  const mvhd = parseIsoChildren(buffer, moov).find(box => box.type === 'mvhd');
  if (!mvhd) throw new Error('ISO-BMFF moov has no mvhd child');
  assertVideoTrackStructure(buffer, moov);
  return movieHeaderDuration(buffer, mvhd);
}

function validateFtyp(buffer) {
  const ftyp = readIsoBox(buffer, 0);
  if (ftyp.type !== 'ftyp' || ftyp.end > buffer.length || ftyp.size < 16) {
    throw new Error('Configured MP4 source has no valid leading ftyp box');
  }
  const majorBrand = buffer.subarray(ftyp.payloadStart, ftyp.payloadStart + 4).toString('ascii');
  if (!/^[\x20-\x7e]{4}$/.test(majorBrand)) throw new Error('Configured MP4 ftyp major brand is invalid');
  return ftyp;
}

function inspectMp4Prefix(buffer) {
  validateFtyp(buffer);
  let offset = 0;
  let hasMdat = false;
  let duration = null;
  let nextTopLevelOffset = null;
  while (offset + 8 <= buffer.length) {
    const box = readIsoBox(buffer, offset);
    if (box.type === 'mdat') hasMdat = true;
    if (box.type === 'moov' && box.end <= buffer.length) duration = durationFromMoov(buffer, box);
    if (box.end > buffer.length) {
      nextTopLevelOffset = box.end;
      break;
    }
    offset = box.end;
  }
  if (offset === buffer.length) nextTopLevelOffset = offset;
  return { hasMdat, duration, nextTopLevelOffset };
}

function findSuffixMoovDuration(buffer, absoluteStart, totalSize, nextTopLevelOffset) {
  if (
    !Number.isSafeInteger(nextTopLevelOffset) ||
    nextTopLevelOffset < absoluteStart ||
    nextTopLevelOffset >= totalSize
  ) {
    return null;
  }
  let offset = nextTopLevelOffset - absoluteStart;
  while (offset + 8 <= buffer.length) {
    const box = readIsoBox(buffer, offset);
    if (box.end > buffer.length) return null;
    const absoluteEnd = absoluteStart + box.end;
    if (box.type === 'moov') {
      if (absoluteEnd !== totalSize) return null;
      return durationFromMoov(buffer, box);
    }
    offset = box.end;
  }
  return null;
}

function parseContentRange(value) {
  const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(value ?? '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const totalSize = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(totalSize)) return null;
  if (start < 0 || end < start || totalSize <= end) return null;
  return { start, end, totalSize };
}

async function fetchMp4MetadataRange(source, originToken, range, fetchImpl, authAllowedOrigins) {
  const { response } = await fetchWithAuthPolicy(source, {
    originToken,
    authAllowedOrigins,
    fetchImpl,
    range,
    timeoutMs: 30_000,
  });
  if (!response.ok) throw new Error('Configured MP4 webinar source is unavailable or unreadable');
  const contentRange = parseContentRange(response.headers.get('content-range'));
  const contentLength = Number(response.headers.get('content-length'));
  const bytes = await readBoundedResponse(response, MP4_METADATA_PROBE_BYTES);
  if (contentRange) {
    if (bytes.length !== contentRange.end - contentRange.start + 1) {
      throw new Error('Configured MP4 origin returned a truncated Content-Range body');
    }
    return { bytes, ...contentRange };
  }
  if (response.status === 200 && range.startsWith('bytes=0-') && Number.isSafeInteger(contentLength) && contentLength > 0) {
    return { bytes, start: 0, end: Math.min(contentLength, bytes.length) - 1, totalSize: contentLength };
  }
  throw new Error('Configured MP4 origin did not return a verifiable bounded Content-Range');
}

export async function probeRemoteMp4Duration(source, originToken, fetchImpl = fetch) {
  const authAllowedOrigins = authOriginsForSource(source);
  const first = await fetchMp4MetadataRange(
    source,
    originToken,
    `bytes=0-${MP4_METADATA_PROBE_BYTES - 1}`,
    fetchImpl,
    authAllowedOrigins,
  );
  if (first.start !== 0) throw new Error('Configured MP4 origin did not return the requested prefix range');
  const prefix = inspectMp4Prefix(first.bytes);
  if (prefix.duration && prefix.hasMdat) return prefix.duration;

  const last = await fetchMp4MetadataRange(
    source,
    originToken,
    `bytes=-${MP4_METADATA_PROBE_BYTES}`,
    fetchImpl,
    authAllowedOrigins,
  );
  const expectedSuffixStart = Math.max(0, last.totalSize - MP4_METADATA_PROBE_BYTES);
  if (
    last.totalSize !== first.totalSize ||
    last.start !== expectedSuffixStart ||
    last.end !== last.totalSize - 1 ||
    last.start <= 0
  ) {
    throw new Error('Configured MP4 origin returned inconsistent suffix-range metadata');
  }
  const suffixDuration = findSuffixMoovDuration(
    last.bytes,
    last.start,
    last.totalSize,
    prefix.nextTopLevelOffset,
  );
  if (prefix.hasMdat && suffixDuration) return suffixDuration;
  throw new Error('Configured MP4 has no bounded structural ftyp/mdat/moov/mvhd layout');
}

export async function probeLocalMp4Duration(source) {
  const file = await open(source, 'r');
  try {
    const { size } = await file.stat();
    if (size <= 0) throw new Error('Configured local MP4 source is empty');

    const firstLength = Math.min(size, MP4_METADATA_PROBE_BYTES);
    const first = Buffer.alloc(firstLength);
    const { bytesRead: firstBytesRead } = await file.read(first, 0, firstLength, 0);
    const firstBytes = first.subarray(0, firstBytesRead);
    const prefix = inspectMp4Prefix(firstBytes);
    if (prefix.duration && prefix.hasMdat) return prefix.duration;

    const lastLength = Math.min(size, MP4_METADATA_PROBE_BYTES);
    const last = Buffer.alloc(lastLength);
    const { bytesRead: lastBytesRead } = await file.read(last, 0, lastLength, Math.max(0, size - lastLength));
    const lastStart = Math.max(0, size - lastLength);
    const suffixDuration = findSuffixMoovDuration(
      last.subarray(0, lastBytesRead),
      lastStart,
      size,
      prefix.nextTopLevelOffset,
    );
    if (prefix.hasMdat && suffixDuration) return suffixDuration;
    throw new Error('Configured local MP4 has no bounded structural ftyp/mdat/moov/mvhd layout');
  } finally {
    await file.close();
  }
}

async function probeMp4Duration(config) {
  if (!/^https?:\/\//i.test(config.probeSource)) return probeLocalMp4Duration(config.probeSource);
  // Remote private media is probed with bounded authenticated Range requests.
  // Neither its URL nor WEBINAR_MEDIA_ORIGIN_TOKEN appears in child argv/ps.
  return probeRemoteMp4Duration(config.probeSource, config.originToken);
}

async function main() {
  const config = resolveVideoCheckConfig();
  const actualDurationSeconds =
    config.sourceKind === 'HLS'
      ? await probeHlsDuration(config.probeSource, config.originToken)
      : await probeMp4Duration(config);
  assertExpectedDuration(actualDurationSeconds, config.expectedDurationSeconds, config.toleranceSeconds);
  console.log(
    `Configured ${config.sourceKind} webinar source is valid: ${actualDurationSeconds.toFixed(1)}s (expected ${config.expectedDurationSeconds}s).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
