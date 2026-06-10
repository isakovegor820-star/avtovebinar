export const WEBINAR_TITLE = 'Экономика кризиса: как юристу зарабатывать на защите финансовых прав бизнеса';
export const WEBINAR_DURATION_MINUTES = 120;
export const WEBINAR_REPLAY_HOURS = 24 * 7;
export const WEBINAR_ROOM_OPEN_BEFORE_MINUTES = 15;
export const WEBINAR_START_HOUR_MSK = 19;
export type WebinarAccessStatus = 'waiting' | 'pre_live' | 'live' | 'replay' | 'closed';
export type WebinarRoomState = WebinarAccessStatus | 'test';

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
    day: '2-digit',
  });

  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
  };
}

export function getNextWebinarDate(firstSeenAt: Date): Date {
  const parts = getMoscowParts(firstSeenAt);
  const todayStart = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, WEBINAR_START_HOUR_MSK - 3, 0, 0));
  if (firstSeenAt.getTime() <= todayStart.getTime()) {
    return todayStart;
  }

  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, WEBINAR_START_HOUR_MSK - 3, 0, 0));
}

export function getCurrentOrNextWebinarDate(now: Date, durationMinutes = WEBINAR_DURATION_MINUTES): Date {
  const parts = getMoscowParts(now);
  const todayStart = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, WEBINAR_START_HOUR_MSK - 3, 0, 0));
  const todayEnd = new Date(todayStart.getTime() + durationMinutes * 60 * 1000);

  if (now.getTime() <= todayEnd.getTime()) {
    return todayStart;
  }

  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, WEBINAR_START_HOUR_MSK - 3, 0, 0));
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

export function getReplayExpiresAt(
  scheduledAt: Date,
  durationMinutes = WEBINAR_DURATION_MINUTES,
  replayAvailableHours = WEBINAR_REPLAY_HOURS,
) {
  return new Date(getWebinarEndAt(scheduledAt, durationMinutes).getTime() + replayAvailableHours * 60 * 60 * 1000);
}

export function getWebinarAccess(
  now: Date,
  scheduledAt: Date,
  durationMinutes = WEBINAR_DURATION_MINUTES,
  replayAvailableHours = WEBINAR_REPLAY_HOURS,
  roomOpenBeforeMinutes = WEBINAR_ROOM_OPEN_BEFORE_MINUTES,
  replayEnabled = true,
) {
  const webinarStatus = getSessionStatus(now, scheduledAt, durationMinutes);
  const replayExpiresAt = getReplayExpiresAt(scheduledAt, durationMinutes, replayAvailableHours);
  const roomOpensAt = new Date(scheduledAt.getTime() - roomOpenBeforeMinutes * 60 * 1000);
  let accessStatus: WebinarAccessStatus;

  if (now.getTime() < roomOpensAt.getTime()) {
    accessStatus = 'waiting';
  } else if (webinarStatus === 'live') {
    accessStatus = 'live';
  } else if (webinarStatus === 'scheduled') {
    accessStatus = 'pre_live';
  } else if (replayEnabled && now.getTime() <= replayExpiresAt.getTime()) {
    accessStatus = 'replay';
  } else {
    accessStatus = 'closed';
  }

  return {
    accessStatus,
    webinarStatus,
    roomOpensAt,
    replayExpiresAt,
    canEnterRoom: accessStatus === 'live' || accessStatus === 'replay',
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

export function getWebinarRoomState(input: {
  accessStatus: WebinarAccessStatus;
  testMode?: boolean;
}): WebinarRoomState {
  if (input.testMode) {
    return 'test';
  }
  return input.accessStatus;
}

export function parseFirstSeenCookie(value: unknown) {
  if (typeof value !== 'string') {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
