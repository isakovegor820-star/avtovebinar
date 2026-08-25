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

function serializeRecording(
  recording: RecordingWithSession,
  personalization?: { positionMs: number; durationMs: number | null; completedAt: Date | null; updatedAt: Date } | null,
  saved = false,
) {
  const durationSeconds = recording.durationSeconds ?? recording.webinarSession.videoDurationSeconds;
  const progressDurationMs = personalization?.durationMs ?? durationSeconds * 1000;
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
    saved,
    progress: personalization
      ? {
          positionSeconds: Math.round(personalization.positionMs / 1000),
          durationSeconds: Math.round(progressDurationMs / 1000),
          percent: progressDurationMs
            ? Math.min(100, Math.round((personalization.positionMs / progressDurationMs) * 100))
            : 0,
          completed: Boolean(personalization.completedAt),
          updatedAt: personalization.updatedAt.toISOString(),
        }
      : { positionSeconds: 0, durationSeconds, percent: 0, completed: false, updatedAt: null },
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

async function serializeRecordingPlaylist(
  recordings: RecordingWithSession[],
  registration: Awaited<ReturnType<typeof requireRecordingAccount>>,
) {
  const userId = registration.userId;
  const organizationId = registration.organizationId;
  if (!userId || !organizationId) return recordings.map(recording => serializeRecording(recording));
  const sessionIds = recordings.map(recording => recording.webinarSessionId);
  const webinarIds = [...new Set(recordings.map(recording => recording.webinarSession.webinarId))];
  const [progressRows, favoriteRows] = await Promise.all([
    prisma.viewerWebinarProgress.findMany({
      where: {
        userId,
        organizationId,
        webinarSessionId: { in: sessionIds },
      },
    }),
    prisma.viewerWebinarFavorite.findMany({
      where: {
        userId,
        organizationId,
        webinarId: { in: webinarIds },
      },
      select: { webinarId: true },
    }),
  ]);
  const progressBySession = new Map(progressRows.map(row => [row.webinarSessionId, row]));
  const favoriteWebinars = new Set(favoriteRows.map(row => row.webinarId));
  return recordings.map(recording =>
    serializeRecording(
      recording,
      progressBySession.get(recording.webinarSessionId),
      favoriteWebinars.has(recording.webinarSession.webinarId),
    ),
  );
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

    const playlist = await serializeRecordingPlaylist(recordings, registration);
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.json({
      ok: true,
      serverTime: now.toISOString(),
      locked: false,
      roomUrl: buildFrontendUrl('/crisis_premium/webinar.html'),
      recordings: playlist,
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

    const playlist = await serializeRecordingPlaylist(recordings, registration);

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
