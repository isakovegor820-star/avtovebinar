import { describe, expect, it } from 'vitest';
import {
  generateRecurrenceDateKeys,
  getSessionLifecycleStatus,
  isValidIanaTimezone,
  localDateKeyAt,
  localDateTimeToUtc,
} from '../src/lib/sessionScheduling.js';

describe('tenant webinar session scheduling', () => {
  it('keeps the requested wall-clock time across a DST boundary', () => {
    expect(localDateTimeToUtc('2026-03-28', '09:00', 'Europe/Amsterdam').toISOString()).toBe(
      '2026-03-28T08:00:00.000Z',
    );
    expect(localDateTimeToUtc('2026-03-29', '09:00', 'Europe/Amsterdam').toISOString()).toBe(
      '2026-03-29T07:00:00.000Z',
    );
  });

  it('rejects nonexistent local time and resolves repeated time deterministically', () => {
    expect(() => localDateTimeToUtc('2026-03-29', '02:30', 'Europe/Amsterdam')).toThrow('Local time does not exist');
    expect(localDateTimeToUtc('2026-10-25', '02:30', 'Europe/Amsterdam').toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('validates timezones and calculates the local calendar date', () => {
    expect(isValidIanaTimezone('Europe/Moscow')).toBe(true);
    expect(isValidIanaTimezone('Europe/Not-A-Timezone')).toBe(false);
    expect(localDateKeyAt(new Date('2026-01-01T22:30:00.000Z'), 'Europe/Moscow')).toBe('2026-01-02');
  });

  it('bounds daily and weekly recurrence by both end date and maximum instances', () => {
    expect(
      generateRecurrenceDateKeys({
        recurrenceType: 'DAILY',
        startsOn: '2026-08-20',
        endsOn: '2026-08-22',
        maxFutureInstances: 30,
      }),
    ).toEqual(['2026-08-20', '2026-08-21', '2026-08-22']);
    expect(
      generateRecurrenceDateKeys({
        recurrenceType: 'WEEKLY',
        startsOn: '2026-08-20',
        maxFutureInstances: 3,
      }),
    ).toEqual(['2026-08-20', '2026-08-27', '2026-09-03']);
  });

  it.each([
    ['2026-08-20T08:59:59.999Z', 'SCHEDULED'],
    ['2026-08-20T09:00:00.000Z', 'ROOM_OPEN'],
    ['2026-08-20T10:00:00.000Z', 'LIVE'],
    ['2026-08-20T11:00:00.000Z', 'LIVE'],
    ['2026-08-20T11:00:00.001Z', 'REPLAY'],
    ['2026-08-21T11:00:00.001Z', 'CLOSED'],
  ])('computes lifecycle at %s as %s', (now, expected) => {
    expect(
      getSessionLifecycleStatus(
        {
          lifecycleStatus: 'SCHEDULED',
          scheduledAt: new Date('2026-08-20T10:00:00.000Z'),
          durationMinutes: 60,
          roomOpenBeforeMinutes: 60,
          replayAvailableHours: 24,
          replayEnabled: true,
        },
        new Date(now),
      ),
    ).toBe(expected);
  });

  it('keeps cancellation authoritative over time-derived lifecycle', () => {
    expect(
      getSessionLifecycleStatus(
        {
          lifecycleStatus: 'CANCELLED',
          scheduledAt: new Date('2026-08-20T10:00:00.000Z'),
          durationMinutes: 60,
          roomOpenBeforeMinutes: 15,
          replayAvailableHours: 168,
          replayEnabled: true,
        },
        new Date('2026-08-20T10:30:00.000Z'),
      ),
    ).toBe('CANCELLED');
  });
});
