export const WEBINAR_TITLE = 'Экономика кризиса: как юристу зарабатывать на защите финансовых прав бизнеса';
export const WEBINAR_DURATION_MINUTES = 120;
export const WEBINAR_REPLAY_DAYS = 7;
export type WebinarAccessStatus = 'waiting' | 'live' | 'replay' | 'expired';

type MoscowParts = {
  year: number;
  month: number;
  day: number;
};

function getMoscowParts(date: Date): MoscowParts {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day)
  };
}

export function getNextWebinarDate(firstSeenAt: Date): Date {
  const parts = getMoscowParts(firstSeenAt);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 8, 0, 0));
}

export function getSessionStatus(now: Date, scheduledAt: Date, durationMinutes = WEBINAR_DURATION_MINUTES) {
  const starts = scheduledAt.getTime();
  const ends = starts + durationMinutes * 60 * 1000;
  const current = now.getTime();

  if (current < starts) {
    return 'scheduled';
  }

  if (current <= ends) {
    return 'live';
  }

  return 'finished';
}

export function getWebinarEndAt(scheduledAt: Date, durationMinutes = WEBINAR_DURATION_MINUTES) {
  return new Date(scheduledAt.getTime() + durationMinutes * 60 * 1000);
}

export function getReplayExpiresAt(scheduledAt: Date, durationMinutes = WEBINAR_DURATION_MINUTES, replayDays = WEBINAR_REPLAY_DAYS) {
  return new Date(getWebinarEndAt(scheduledAt, durationMinutes).getTime() + replayDays * 24 * 60 * 60 * 1000);
}

export function getWebinarAccess(now: Date, scheduledAt: Date, durationMinutes = WEBINAR_DURATION_MINUTES, replayDays = WEBINAR_REPLAY_DAYS) {
  const webinarStatus = getSessionStatus(now, scheduledAt, durationMinutes);
  const replayExpiresAt = getReplayExpiresAt(scheduledAt, durationMinutes, replayDays);
  let accessStatus: WebinarAccessStatus;

  if (webinarStatus === 'scheduled') {
    accessStatus = 'waiting';
  } else if (webinarStatus === 'live') {
    accessStatus = 'live';
  } else if (now.getTime() <= replayExpiresAt.getTime()) {
    accessStatus = 'replay';
  } else {
    accessStatus = 'expired';
  }

  return {
    accessStatus,
    webinarStatus,
    replayExpiresAt,
    canEnterRoom: accessStatus === 'live' || accessStatus === 'replay'
  };
}

export function getCountdown(now: Date, scheduledAt: Date) {
  const diff = Math.max(0, scheduledAt.getTime() - now.getTime());
  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return { days, hours, minutes, seconds, totalSeconds };
}

export function parseFirstSeenCookie(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
