import { describe, expect, it } from 'vitest';
import {
  activeServiceDays,
  addDays,
  isServiceActive,
  localDate,
  serviceDayStart,
  weekdayIndex,
  zonedTimeToEpoch,
} from '../../src/lib/time.ts';
import type { ServiceRecord } from '../../shared/types.ts';

describe('agency time', () => {
  it('converts New Orleans wall-clock time to epoch in both offsets', () => {
    // CDT (UTC-5) in October, CST (UTC-6) in January.
    expect(new Date(zonedTimeToEpoch(2026, 10, 18, 17, 30)).toISOString()).toBe('2026-10-18T22:30:00.000Z');
    expect(new Date(zonedTimeToEpoch(2027, 1, 18, 17, 30)).toISOString()).toBe('2027-01-18T23:30:00.000Z');
  });

  it('puts GTFS 00:00 at noon minus 12h, which is not midnight on DST days', () => {
    // Clocks fall back at 2am on 2026-11-01. Noon is CST (UTC-6), so the
    // service-day origin is 06:00Z — midnight local was 05:00Z (CDT).
    expect(new Date(serviceDayStart('20261101')).toISOString()).toBe('2026-11-01T06:00:00.000Z');
    // A 08:00:00 trip on that day leaves at 8am local, CST.
    expect(new Date(serviceDayStart('20261101') + 8 * 3600_000).toISOString()).toBe('2026-11-01T14:00:00.000Z');
    // Spring forward 2027-03-14: noon is CDT (UTC-5) -> origin 05:00Z.
    expect(new Date(serviceDayStart('20270314')).toISOString()).toBe('2027-03-14T05:00:00.000Z');
  });

  it('handles times past 24:00 as the next calendar morning', () => {
    const start = serviceDayStart('20261016'); // Friday
    const after = start + (25 * 3600 + 30 * 60) * 1000; // 25:30:00
    expect(localDate(after)).toBe('20261017');
    expect(new Date(after).toISOString()).toBe('2026-10-17T06:30:00.000Z');
  });

  it('includes yesterday so after-midnight trips are found', () => {
    const at1am = zonedTimeToEpoch(2026, 10, 18, 1, 0);
    expect(activeServiceDays(at1am).map((day) => day.date)).toEqual(['20261017', '20261018', '20261019']);
  });

  it('reads the calendar with exceptions', () => {
    const weekday: ServiceRecord = {
      days: [true, true, true, true, false, false, false],
      startDate: '20260920',
      endDate: '20270926',
      added: ['20261226'],
      removed: ['20261126'],
    };
    expect(weekdayIndex('20261019')).toBe(0); // Monday
    expect(isServiceActive(weekday, '20261019')).toBe(true);
    expect(isServiceActive(weekday, '20261018')).toBe(false); // Sunday
    expect(isServiceActive(weekday, '20261126')).toBe(false); // Thanksgiving removed
    expect(isServiceActive(weekday, '20261226')).toBe(true); // a Saturday, added explicitly
    expect(isServiceActive(weekday, '20270927')).toBe(false); // after end
    expect(addDays('20261231', 1)).toBe('20270101');
  });
});
