import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response } from 'express';
import { AppError, asyncHandler } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { getPrivateMediaStorageAdapter, type MediaObjectResponse } from '../../lib/mediaStorage.js';
import { prisma } from '../../lib/prisma.js';
import { getWebinarVideoConfig } from '../../lib/webinarVideo.js';
import { canAccessRegisteredWebinar } from '../../lib/tenancy/webinarAccess.js';
import { buildAccessPayload, buildDailyRoomAccessPayload, findRegistrationForRequest } from './helpers.js';

export const mediaRouter = Router();

const frontendDir = path.resolve(process.cwd(), 'crisis_premium');
const MEDIA_FETCH_TIMEOUT_MS = 15_000;
const MAX_MANIFEST_BYTES = 1_048_576;

type MediaContext = {
  resourcePath: (encoded: string) => string;
};

function routeParam(value: string | string[] | undefined, name: string) {
  if (typeof value !== 'string' || !value) throw new AppError(400, `Invalid ${name}`);
  return value;
}

function mediaSourceUrl(source: string) {
  return new URL(source, env.PUBLIC_SITE_URL);
}

function resolveLocalMediaPath(source: string) {
  const url = mediaSourceUrl(source);
  const publicOrigin = new URL(env.PUBLIC_SITE_URL).origin;
  if (url.origin !== publicOrigin || !url.pathname.startsWith('/crisis_premium/')) return null;

  const relativePath = decodeURIComponent(url.pathname.slice('/crisis_premium/'.length));
  const resolvedPath = path.resolve(frontendDir, relativePath);
  if (resolvedPath !== frontendDir && !resolvedPath.startsWith(`${frontendDir}${path.sep}`)) {
    throw new AppError(400, 'Invalid media path');
  }
  return resolvedPath;
}

function setPrivateMediaHeaders(res: Response) {
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Vary', 'Cookie, Range');
  res.setHeader('Content-Disposition', 'inline');
}

function setVersionedMediaHeaders(res: Response) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie, Range');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Accept-Ranges', 'bytes');
}

async function sendLocalMedia(res: Response, filePath: string) {
  setPrivateMediaHeaders(res);
  await new Promise<void>((resolve, reject) => {
    res.sendFile(filePath, { acceptRanges: true }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function copyUpstreamHeader(upstream: globalThis.Response, res: Response, name: string) {
  const value = upstream.headers.get(name);
  if (value) res.setHeader(name, value);
}

async function fetchMedia(source: string, req: Request) {
  const headers = new Headers();
  const range = req.get('range');
  const ifRange = req.get('if-range');
  if (range) headers.set('range', range);
  if (ifRange) headers.set('if-range', ifRange);
  if (env.WEBINAR_MEDIA_ORIGIN_TOKEN) {
    headers.set('authorization', `Bearer ${env.WEBINAR_MEDIA_ORIGIN_TOKEN}`);
  }

  return fetch(mediaSourceUrl(source), {
    headers,
    redirect: 'follow',
    signal: AbortSignal.timeout(MEDIA_FETCH_TIMEOUT_MS),
  });
}

async function proxyRemoteMedia(req: Request, res: Response, source: string) {
  const upstream = await fetchMedia(source, req);
  if (!upstream.ok && upstream.status !== 206 && upstream.status !== 304) {
    throw new AppError(upstream.status === 404 ? 404 : 502, 'Media source is unavailable');
  }

  res.status(upstream.status);
  setPrivateMediaHeaders(res);
  ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].forEach(name =>
    copyUpstreamHeader(upstream, res, name),
  );

  if (!upstream.body || upstream.status === 304) {
    res.end();
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstream.body as any), res);
  } catch (error) {
    if (!res.destroyed) throw error;
  }
}

async function sendMedia(req: Request, res: Response, source: string | null) {
  if (!source) throw new AppError(404, 'Media source not found');
  const localPath = resolveLocalMediaPath(source);
  if (localPath) {
    await sendLocalMedia(res, localPath);
    return;
  }
  await proxyRemoteMedia(req, res, source);
}

function encodeMediaUrl(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeMediaUrl(value: string) {
  try {
    return Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    throw new AppError(400, 'Invalid media resource');
  }
}

function versionedMediaUnavailable(): never {
  throw new AppError(404, 'Media not found', undefined, 'media_not_found');
}

async function requireCurrentVersionedMedia(req: Request) {
  const sessionId = routeParam(req.params.sessionId, 'session id');
  const registration = await findRegistrationForRequest(req);
  if (!registration || registration.webinarSessionId !== sessionId) versionedMediaUnavailable();
  const access = buildAccessPayload(registration, new Date());
  if (!access.canEnterRoom || access.webinarSession.id !== sessionId) versionedMediaUnavailable();
  const session = await prisma.webinarSession.findFirst({
    where: {
      id: sessionId,
      organizationId: registration.webinarSession.organizationId,
      webinarId: registration.webinarSession.webinarId,
      lifecycleStatus: { not: 'CANCELLED' },
    },
    select: {
      webinar: {
        select: {
          currentMediaAsset: {
            select: {
              id: true,
              organizationId: true,
              webinarId: true,
              status: true,
              manifestStorageKey: true,
              posterStorageKey: true,
            },
          },
        },
      },
    },
  });
  const asset = session?.webinar.currentMediaAsset;
  if (
    !asset ||
    asset.status !== 'READY' ||
    asset.organizationId !== registration.webinarSession.organizationId ||
    asset.webinarId !== registration.webinarSession.webinarId ||
    !asset.manifestStorageKey ||
    !asset.posterStorageKey
  ) {
    versionedMediaUnavailable();
  }
  const storage = getPrivateMediaStorageAdapter();
  if (!storage.readObject) versionedMediaUnavailable();
  return { asset, storage };
}

function validRangeHeader(req: Request) {
  const range = req.get('range');
  if (!range) return undefined;
  if (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
    throw new AppError(416, 'Invalid media range', undefined, 'media_range_invalid');
  }
  return range;
}

async function readVersionedObject(
  storage: NonNullable<ReturnType<typeof getPrivateMediaStorageAdapter>>,
  storageKey: string,
  range?: string,
) {
  if (!storage.readObject) versionedMediaUnavailable();
  try {
    return await storage.readObject({ storageKey, range });
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 416) throw error;
    return versionedMediaUnavailable();
  }
}

async function mediaObjectText(object: MediaObjectResponse) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of object.body) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > MAX_MANIFEST_BYTES) versionedMediaUnavailable();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safeHlsRelativePath(value: string) {
  if (!value || value.includes('://') || value.startsWith('/') || value.includes('\\')) versionedMediaUnavailable();
  const normalized = path.posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../')) versionedMediaUnavailable();
  return normalized;
}

function versionedSegmentPath(sessionId: string, relativePath: string) {
  return `/api/media/webinar/${encodeURIComponent(sessionId)}/segment/${encodeMediaUrl(relativePath)}`;
}

function rewriteVersionedManifest(manifest: string, sessionId: string, basePath = '') {
  if (!manifest.startsWith('#EXTM3U')) versionedMediaUnavailable();
  const rewrite = (value: string) =>
    versionedSegmentPath(sessionId, safeHlsRelativePath(path.posix.join(basePath, value)));
  return manifest
    .split(/\r?\n/)
    .map(line => {
      if (!line.trim()) return line;
      if (!line.startsWith('#')) return rewrite(line.trim());
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${rewrite(uri)}"`);
    })
    .join('\n');
}

async function sendVersionedObject(res: Response, object: MediaObjectResponse) {
  setVersionedMediaHeaders(res);
  res.status(object.contentRange ? 206 : 200);
  res.setHeader('Content-Type', object.contentType);
  if (object.contentLength !== undefined) res.setHeader('Content-Length', String(object.contentLength));
  if (object.contentRange) res.setHeader('Content-Range', object.contentRange);
  if (object.etag) res.setHeader('ETag', object.etag);
  if (object.lastModified) res.setHeader('Last-Modified', object.lastModified.toUTCString());
  try {
    await pipeline(object.body, res);
  } catch (error) {
    if (!res.destroyed) throw error;
  }
}

function isAllowedHlsResource(resource: string, rootSource: string) {
  const root = mediaSourceUrl(rootSource);
  const target = mediaSourceUrl(resource);
  const rootDirectory = new URL('.', root).pathname;
  return target.origin === root.origin && target.pathname.startsWith(rootDirectory);
}

function rewriteHlsManifest(manifest: string, source: string, context: MediaContext) {
  const rewrite = (value: string) => {
    const resolved = new URL(value, mediaSourceUrl(source)).toString();
    return context.resourcePath(encodeMediaUrl(resolved));
  };

  return manifest
    .split(/\r?\n/)
    .map(line => {
      if (!line.trim()) return line;
      if (!line.startsWith('#')) return rewrite(line.trim());
      return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => `URI="${rewrite(uri)}"`);
    })
    .join('\n');
}

async function readManifest(req: Request, source: string) {
  const localPath = resolveLocalMediaPath(source);
  if (localPath) return readFile(localPath, 'utf8');

  const upstream = await fetchMedia(source, req);
  if (!upstream.ok) throw new AppError(upstream.status === 404 ? 404 : 502, 'HLS manifest is unavailable');
  return upstream.text();
}

async function sendHlsManifest(req: Request, res: Response, source: string | null, context: MediaContext) {
  if (!source) throw new AppError(404, 'HLS source not found');
  const manifest = await readManifest(req, source);
  setPrivateMediaHeaders(res);
  res.type('application/vnd.apple.mpegurl').send(rewriteHlsManifest(manifest, source, context));
}

async function sendHlsResource(
  req: Request,
  res: Response,
  rootSource: string | null,
  encodedResource: string,
  context: MediaContext,
) {
  if (!rootSource) throw new AppError(404, 'HLS source not found');
  const resource = decodeMediaUrl(encodedResource);
  if (!isAllowedHlsResource(resource, rootSource)) throw new AppError(403, 'Media resource is outside the playlist');

  if (mediaSourceUrl(resource).pathname.endsWith('.m3u8')) {
    await sendHlsManifest(req, res, resource, context);
    return;
  }
  await sendMedia(req, res, resource);
}

async function requireCurrentWebinarMedia(req: Request) {
  const registration = await findRegistrationForRequest(req);
  if (!registration) throw new AppError(401, 'Participant session required');

  const access = await buildDailyRoomAccessPayload(registration, new Date());
  if (!access.canEnterRoom || access.webinarSession.id !== routeParam(req.params.sessionId, 'session id')) {
    throw new AppError(403, 'Webinar media is not available');
  }
  return getWebinarVideoConfig(access.webinarSession);
}

async function requirePublishedRecording(req: Request) {
  const registration = await findRegistrationForRequest(req);
  if (!registration) throw new AppError(401, 'Participant session required');

  const recording = await prisma.webinarRecording.findFirst({
    where: {
      id: routeParam(req.params.recordingId, 'recording id'),
      visible: true,
      publishedAt: { lte: new Date() },
      webinarSession: {
        lifecycleStatus: { not: 'CANCELLED' },
        registrations: {
          some: {
            leadId: registration.leadId,
            status: 'registered',
            emailVerifiedAt: { not: null },
          },
        },
      },
    },
    include: { webinarSession: true },
  });
  if (!recording || (!recording.videoUrl && !recording.hlsUrl)) throw new AppError(404, 'Recording not found');
  if (
    !(await canAccessRegisteredWebinar(prisma, {
      lead: registration.lead,
      webinarSession: recording.webinarSession,
    }))
  ) {
    throw new AppError(404, 'Recording not found');
  }
  return recording;
}

function webinarHlsContext(sessionId: string): MediaContext {
  return { resourcePath: encoded => `/api/media/webinar/${encodeURIComponent(sessionId)}/hls-resource/${encoded}` };
}

function recordingHlsContext(recordingId: string): MediaContext {
  return { resourcePath: encoded => `/api/media/recording/${encodeURIComponent(recordingId)}/hls-resource/${encoded}` };
}

mediaRouter.get(
  '/media/webinar/:sessionId/manifest',
  asyncHandler(async (req, res) => {
    const { asset, storage } = await requireCurrentVersionedMedia(req);
    const manifestKey = asset.manifestStorageKey ?? versionedMediaUnavailable();
    const object = await readVersionedObject(storage, manifestKey);
    const manifest = await mediaObjectText(object);
    setVersionedMediaHeaders(res);
    res
      .type('application/vnd.apple.mpegurl')
      .send(rewriteVersionedManifest(manifest, routeParam(req.params.sessionId, 'session id')));
  }),
);

mediaRouter.get(
  '/media/webinar/:sessionId/segment/:resource',
  asyncHandler(async (req, res) => {
    const { asset, storage } = await requireCurrentVersionedMedia(req);
    const manifestKey = asset.manifestStorageKey ?? versionedMediaUnavailable();
    const manifestDirectory = path.posix.dirname(manifestKey);
    const relativePath = safeHlsRelativePath(decodeMediaUrl(routeParam(req.params.resource, 'media resource')));
    const storageKey = path.posix.join(manifestDirectory, relativePath);
    if (storageKey !== manifestDirectory && !storageKey.startsWith(`${manifestDirectory}/`)) {
      versionedMediaUnavailable();
    }
    const object = await readVersionedObject(storage, storageKey, validRangeHeader(req));
    if (relativePath.endsWith('.m3u8')) {
      const manifest = await mediaObjectText(object);
      setVersionedMediaHeaders(res);
      res
        .type('application/vnd.apple.mpegurl')
        .send(
          rewriteVersionedManifest(
            manifest,
            routeParam(req.params.sessionId, 'session id'),
            path.posix.dirname(relativePath) === '.' ? '' : path.posix.dirname(relativePath),
          ),
        );
      return;
    }
    await sendVersionedObject(res, object);
  }),
);

mediaRouter.get(
  '/media/webinar/:sessionId/poster',
  asyncHandler(async (req, res) => {
    const { asset, storage } = await requireCurrentVersionedMedia(req);
    const posterKey = asset.posterStorageKey ?? versionedMediaUnavailable();
    await sendVersionedObject(res, await readVersionedObject(storage, posterKey, validRangeHeader(req)));
  }),
);

mediaRouter.get(
  '/media/webinar/:sessionId/video',
  asyncHandler(async (req, res) => sendMedia(req, res, (await requireCurrentWebinarMedia(req)).src)),
);

mediaRouter.get(
  '/media/webinar/:sessionId/hls',
  asyncHandler(async (req, res) => {
    const video = await requireCurrentWebinarMedia(req);
    const sessionId = routeParam(req.params.sessionId, 'session id');
    await sendHlsManifest(req, res, video.hlsSrc, webinarHlsContext(sessionId));
  }),
);

mediaRouter.get(
  '/media/webinar/:sessionId/hls-resource/:resource',
  asyncHandler(async (req, res) => {
    const video = await requireCurrentWebinarMedia(req);
    const sessionId = routeParam(req.params.sessionId, 'session id');
    await sendHlsResource(
      req,
      res,
      video.hlsSrc,
      routeParam(req.params.resource, 'media resource'),
      webinarHlsContext(sessionId),
    );
  }),
);

mediaRouter.get(
  '/media/recording/:recordingId/video',
  asyncHandler(async (req, res) => sendMedia(req, res, (await requirePublishedRecording(req)).videoUrl)),
);

mediaRouter.get(
  '/media/recording/:recordingId/hls',
  asyncHandler(async (req, res) => {
    const recording = await requirePublishedRecording(req);
    const recordingId = routeParam(req.params.recordingId, 'recording id');
    await sendHlsManifest(req, res, recording.hlsUrl, recordingHlsContext(recordingId));
  }),
);

mediaRouter.get(
  '/media/recording/:recordingId/hls-resource/:resource',
  asyncHandler(async (req, res) => {
    const recording = await requirePublishedRecording(req);
    const recordingId = routeParam(req.params.recordingId, 'recording id');
    await sendHlsResource(
      req,
      res,
      recording.hlsUrl,
      routeParam(req.params.resource, 'media resource'),
      recordingHlsContext(recordingId),
    );
  }),
);
