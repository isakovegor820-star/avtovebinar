import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type Response } from 'express';
import { AppError, asyncHandler } from '../../lib/http.js';
import { env } from '../../lib/env.js';
import { prisma } from '../../lib/prisma.js';
import { getWebinarVideoConfig } from '../../lib/webinarVideo.js';
import { buildDailyRoomAccessPayload, findRegistrationForRequest } from './helpers.js';

export const mediaRouter = Router();

const frontendDir = path.resolve(process.cwd(), 'crisis_premium');
const MEDIA_FETCH_TIMEOUT_MS = 15_000;

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
    },
  });
  if (!recording || (!recording.videoUrl && !recording.hlsUrl)) throw new AppError(404, 'Recording not found');
  return recording;
}

function webinarHlsContext(sessionId: string): MediaContext {
  return { resourcePath: encoded => `/api/media/webinar/${encodeURIComponent(sessionId)}/hls-resource/${encoded}` };
}

function recordingHlsContext(recordingId: string): MediaContext {
  return { resourcePath: encoded => `/api/media/recording/${encodeURIComponent(recordingId)}/hls-resource/${encoded}` };
}

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
