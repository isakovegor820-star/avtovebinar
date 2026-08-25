import { Router, type Request } from 'express';
import { prisma } from '../../lib/prisma.js';
import { AppError, asyncHandler } from '../../lib/http.js';
import { getWebinarEndAt } from '../../lib/time.js';
import { canAccessRegisteredWebinar } from '../../lib/tenancy/webinarAccess.js';
import { buildFrontendUrl, findRegistrationForRequest, saveEventSafely } from './helpers.js';

export const recordingsRouter = Router();
const DEFAULT_RECORDING_POSTER = '/crisis_premium/assets/webinar-poster.jpg';

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

function hasRecordingMedia(recording: { videoUrl: string | null; hlsUrl: string | null }) {
  return Boolean(recording.videoUrl || recording.hlsUrl);
}

async function fetchPublishedRecordings(now: Date, lead: { id: string; email: string }) {
  const candidates = await prisma.webinarRecording.findMany({
    where: {
      visible: true,
      publishedAt: { lte: now },
      webinarSession: {
        lifecycleStatus: { not: 'CANCELLED' },
        registrations: {
          some: { leadId: lead.id, status: 'registered', emailVerifiedAt: { not: null } },
        },
      },
    },
    include: {
      webinarSession: true,
    },
    orderBy: [{ orderIndex: 'asc' }, { publishedAt: 'desc' }, { createdAt: 'desc' }],
  });

  const eligible = candidates.filter(recording => isRecordingPublished(recording, now) && hasRecordingMedia(recording));
  const access = await Promise.all(
    eligible.map(recording =>
      canAccessRegisteredWebinar(prisma, { lead, webinarSession: recording.webinarSession }, now),
    ),
  );
  return eligible.filter((_recording, index) => access[index]);
}

async function requireRecordingAccount(req: Request) {
  const registration = await findRegistrationForRequest(req);
  if (!registration) {
    throw new AppError(401, 'Registration required');
  }
  return registration;
}

function serializeRecording(recording: RecordingWithSession) {
  const durationSeconds = recording.durationSeconds ?? recording.webinarSession.videoDurationSeconds;
  const mediaBase = `/api/media/recording/${encodeURIComponent(recording.id)}`;
  const videoSrc = recording.videoUrl ? `${mediaBase}/video` : null;
  const hlsSrc = recording.hlsUrl ? `${mediaBase}/hls` : null;
  const externalMp4Allowed = Boolean(recording.videoUrl);
  const posterUrl = recording.posterUrl ?? DEFAULT_RECORDING_POSTER;

  return {
    id: recording.id,
    webinarSessionId: recording.webinarSessionId,
    title: recording.title,
    description: recording.description,
    posterUrl,
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
      src: videoSrc,
      hlsSrc,
      provider: hlsSrc ? 'hls' : 'local',
      durationSeconds,
      poster: posterUrl,
      fallbackAllowed: false,
      localFallbackAllowed: false,
      externalMp4Allowed,
      expected: Boolean(hlsSrc ?? videoSrc),
    },
  };
}

recordingsRouter.get(
  '/recordings',
  asyncHandler(async (req, res) => {
    const registration = await requireRecordingAccount(req);
    const now = new Date();
    const recordings = await fetchPublishedRecordings(now, { id: registration.leadId, email: registration.lead.email });

    await saveEventSafely(
      {
        eventName: 'recordings_open',
        req,
        registration,
        page: '/crisis_premium/recordings.html',
      },
      'recordings_list',
    );

    res.setHeader('Cache-Control', 'private, max-age=30');
    res.json({
      ok: true,
      serverTime: now.toISOString(),
      locked: false,
      roomUrl: buildFrontendUrl('/crisis_premium/webinar.html'),
      recordings: recordings.map(serializeRecording),
    });
  }),
);

recordingsRouter.get(
  '/recordings/:id',
  asyncHandler(async (req, res) => {
    const registration = await requireRecordingAccount(req);
    const now = new Date();
    const recordings = await fetchPublishedRecordings(now, { id: registration.leadId, email: registration.lead.email });
    const index = recordings.findIndex(recording => recording.id === req.params.id);
    if (index === -1) {
      throw new AppError(404, 'Recording not found');
    }

    const playlist = recordings.map(serializeRecording);

    await saveEventSafely(
      {
        eventName: 'recording_open',
        req,
        registration,
        page: '/crisis_premium/recordings.html',
        metadata: { recordingId: req.params.id },
      },
      'recording_detail',
    );

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
