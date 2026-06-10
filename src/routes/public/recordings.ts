import { Router, type Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler } from '../../lib/http.js';
import { getWebinarEndAt } from '../../lib/time.js';
import { getWebinarVideoConfig } from '../../lib/webinarVideo.js';
import { findRegistrationForRequest, saveEvent } from './helpers.js';

export const recordingsRouter = Router();

type RecordingWithSession = Awaited<ReturnType<typeof fetchPublishedRecordings>>[number];

function isRecordingPublished(
  recording: {
    publishedAt: Date | null;
    visible: boolean;
  },
  now: Date,
) {
  if (!recording.visible) return false;
  if (!recording.publishedAt) return false;
  return recording.publishedAt <= now;
}

async function fetchPublishedRecordings(now: Date) {
  const candidates = await prisma.webinarRecording.findMany({
    where: {
      visible: true,
      publishedAt: { lte: now },
    },
    include: {
      webinarSession: true,
    },
    orderBy: [{ orderIndex: 'asc' }, { publishedAt: 'desc' }, { createdAt: 'desc' }],
  });

  return candidates.filter(recording => isRecordingPublished(recording, now));
}

async function requireRecordingAccount(req: Request) {
  const registration = await findRegistrationForRequest(req);
  if (!registration) {
    throw new AppError(401, 'Registration required');
  }
  return registration;
}

function serializeRecording(recording: RecordingWithSession) {
  const fallbackVideo = getWebinarVideoConfig(recording.webinarSession);
  const durationSeconds = recording.durationSeconds ?? recording.webinarSession.videoDurationSeconds;

  return {
    id: recording.id,
    webinarSessionId: recording.webinarSessionId,
    title: recording.title,
    description: recording.description,
    posterUrl: recording.posterUrl ?? fallbackVideo.poster,
    videoUrl: recording.videoUrl ?? fallbackVideo.src,
    hlsUrl: recording.hlsUrl ?? fallbackVideo.hlsSrc,
    durationSeconds,
    publishedAt: recording.publishedAt?.toISOString() ?? null,
    visible: recording.visible,
    orderIndex: recording.orderIndex,
    category: recording.category,
    status: 'available',
    webinar: {
      id: recording.webinarSession.id,
      title: recording.webinarSession.title,
      scheduledAt: recording.webinarSession.scheduledAt.toISOString(),
      endedAt: getWebinarEndAt(
        recording.webinarSession.scheduledAt,
        recording.webinarSession.durationMinutes,
      ).toISOString(),
      durationMinutes: recording.webinarSession.durationMinutes,
    },
    video: {
      src: recording.videoUrl ?? fallbackVideo.src,
      hlsSrc: recording.hlsUrl ?? fallbackVideo.hlsSrc,
      provider: fallbackVideo.provider,
      durationSeconds,
      poster: recording.posterUrl ?? fallbackVideo.poster,
      fallbackAllowed: fallbackVideo.fallbackAllowed,
      expected: Boolean(recording.hlsUrl ?? recording.videoUrl ?? fallbackVideo.hlsSrc ?? fallbackVideo.src),
    },
  };
}

recordingsRouter.get(
  '/recordings',
  asyncHandler(async (req, res) => {
    const registration = await requireRecordingAccount(req);
    const now = new Date();
    const recordings = await fetchPublishedRecordings(now);

    await saveEvent({
      eventName: 'recordings_open',
      req,
      registration,
      page: '/crisis_premium/recordings.html',
    });

    res.setHeader('Cache-Control', 'private, max-age=30');
    res.json({
      ok: true,
      serverTime: now.toISOString(),
      recordings: recordings.map(serializeRecording),
    });
  }),
);

recordingsRouter.get(
  '/recordings/:id',
  asyncHandler(async (req, res) => {
    const registration = await requireRecordingAccount(req);
    const now = new Date();
    const recordings = await fetchPublishedRecordings(now);
    const index = recordings.findIndex(recording => recording.id === req.params.id);
    if (index === -1) {
      throw new AppError(404, 'Recording not found');
    }

    const playlist = recordings.map(serializeRecording);

    await saveEvent({
      eventName: 'recording_open',
      req,
      registration,
      page: '/crisis_premium/recordings.html',
      metadata: { recordingId: req.params.id },
    });

    res.setHeader('Cache-Control', 'private, max-age=30');
    res.json({
      ok: true,
      serverTime: now.toISOString(),
      recording: playlist[index],
      playlist,
      currentIndex: index,
    });
  }),
);
