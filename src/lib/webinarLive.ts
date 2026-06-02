export type WebinarRuntimeSession = {
  scheduledAt: Date;
  videoDurationSeconds: number;
};

export type WebinarLiveStatus = 'scheduled' | 'live' | 'finished' | 'test';
export type WebinarChatStatus = 'locked' | 'live' | 'ended' | 'test';

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function getEffectiveVideoDurationSeconds(session: { videoDurationSeconds?: number | null }) {
  const duration = Number(session.videoDurationSeconds);
  return Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 1;
}

export function getEffectiveVideoDurationMinutes(session: { videoDurationSeconds?: number | null }) {
  return Math.max(1, Math.ceil(getEffectiveVideoDurationSeconds(session) / 60));
}

export function getWebinarLiveState(now: Date, session: WebinarRuntimeSession, options: { testMode?: boolean } = {}) {
  const durationSeconds = getEffectiveVideoDurationSeconds(session);
  const elapsedSeconds = Math.floor((now.getTime() - session.scheduledAt.getTime()) / 1000);
  const liveOffsetSeconds = clamp(elapsedSeconds, 0, durationSeconds);
  const isStarted = elapsedSeconds >= 0;
  const isEnded = elapsedSeconds >= durationSeconds;
  const status: WebinarLiveStatus = options.testMode
    ? 'test'
    : !isStarted
      ? 'scheduled'
      : isEnded
        ? 'finished'
        : 'live';
  const chatStatus: WebinarChatStatus = options.testMode ? 'test' : !isStarted ? 'locked' : isEnded ? 'ended' : 'live';

  return {
    scheduledAt: session.scheduledAt,
    durationSeconds,
    elapsedSeconds,
    liveOffsetSeconds,
    isStarted,
    isEnded,
    status,
    chatStatus,
  };
}
