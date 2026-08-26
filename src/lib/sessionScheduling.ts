import type { WebinarSessionLifecycleStatus } from '@prisma/client';

type LocalDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function timezoneFormatter(timezone: string) {
  const cached = formatterCache.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  formatterCache.set(timezone, formatter);
  return formatter;
}

function partsAt(instant: Date, timezone: string): LocalDateParts {
  const map = Object.fromEntries(
    timezoneFormatter(timezone)
      .formatToParts(instant)
      .map(part => [part.type, part.value]),
  );
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
  };
}

function sameParts(left: LocalDateParts, right: LocalDateParts) {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

export function isValidIanaTimezone(timezone: string) {
  try {
    timezoneFormatter(timezone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function localDateTimeToUtc(dateKey: string, timeKey: string, timezone: string) {
  if (!isValidIanaTimezone(timezone)) throw new RangeError('Invalid IANA timezone');
  const [year, month, day] = dateKey.split('-').map(Number);
  const [hour, minute] = timeKey.split(':').map(Number);
  const target: LocalDateParts = { year, month, day, hour, minute };
  const targetWallTime = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsets = new Set<number>();

  // Sampling both sides of the target covers ordinary offsets and both sides
  // of DST transitions without relying on the host machine timezone.
  for (const sampleHours of [-36, -24, -12, 0, 12, 24, 36]) {
    const sample = new Date(targetWallTime + sampleHours * 60 * 60 * 1000);
    const local = partsAt(sample, timezone);
    const localWallTime = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0, 0);
    offsets.add(localWallTime - sample.getTime());
  }

  const candidates = [...offsets]
    .map(offset => new Date(targetWallTime - offset))
    .filter(candidate => sameParts(partsAt(candidate, timezone), target))
    .sort((left, right) => left.getTime() - right.getTime());

  if (candidates.length === 0) {
    throw new RangeError('Local time does not exist in the selected timezone');
  }
  // A fall-back hour can map to two UTC instants. Pick the earlier occurrence
  // deterministically and expose the explicit timezone in every API response.
  return candidates[0];
}

function dateKeyFromUtcNoon(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number);
  return dateKeyFromUtcNoon(new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0)));
}

export function generateRecurrenceDateKeys(input: {
  recurrenceType: 'ONCE' | 'DAILY' | 'WEEKLY';
  startsOn: string;
  endsOn?: string | null;
  maxFutureInstances: number;
}) {
  const incrementDays = input.recurrenceType === 'WEEKLY' ? 7 : 1;
  const dates: string[] = [];
  let current = input.startsOn;
  for (let guard = 0; guard < 1_000 && dates.length < input.maxFutureInstances; guard += 1) {
    if (input.endsOn && current > input.endsOn) break;
    dates.push(current);
    if (input.recurrenceType === 'ONCE') break;
    current = addDays(current, incrementDays);
  }
  return dates;
}

export function getSessionLifecycleStatus(
  session: {
    lifecycleStatus: WebinarSessionLifecycleStatus;
    scheduledAt: Date;
    durationMinutes: number;
    roomOpenBeforeMinutes: number;
    replayAvailableHours: number;
    replayEnabled: boolean;
  },
  now = new Date(),
): WebinarSessionLifecycleStatus {
  if (session.lifecycleStatus === 'CANCELLED') return 'CANCELLED';
  const start = session.scheduledAt.getTime();
  const roomOpen = start - session.roomOpenBeforeMinutes * 60 * 1000;
  const end = start + session.durationMinutes * 60 * 1000;
  const replayEnd = end + session.replayAvailableHours * 60 * 60 * 1000;
  const current = now.getTime();
  if (current < roomOpen) return 'SCHEDULED';
  if (current < start) return 'ROOM_OPEN';
  if (current <= end) return 'LIVE';
  if (session.replayEnabled && current <= replayEnd) return 'REPLAY';
  return 'CLOSED';
}

export function localDateKeyAt(instant: Date, timezone: string) {
  const parts = partsAt(instant, timezone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}
