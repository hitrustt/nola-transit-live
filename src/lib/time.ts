/**
 * Agency-time arithmetic.
 *
 * GTFS times are seconds from "noon minus 12 hours" on the service date, in
 * the agency's zone — not from midnight. The difference matters twice a year:
 * on DST days the clock midnight is 23 or 25 hours from the next one, and a
 * naive `midnight + seconds` puts every trip an hour off. Times also run past
 * 24:00 (a 1:30am trip on Friday's service is 25:30:00), so "what is running
 * now" has to look at yesterday's service too.
 *
 * All of this is done with Intl rather than the device's own zone, so a rider
 * whose phone is set to another timezone still sees correct New Orleans times.
 */

import type { ServiceRecord } from '../../shared/types.ts';

export const AGENCY_TIME_ZONE = 'America/Chicago';

const partsFormatter = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatter.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatter.set(timeZone, formatter);
  }
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(epochMs: number, timeZone = AGENCY_TIME_ZONE): ZonedParts {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(epochMs)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts as unknown as ZonedParts;
}

/** Offset of `timeZone` from UTC at `epochMs`, in ms (Chicago: -5h or -6h). */
export function zoneOffsetMs(epochMs: number, timeZone = AGENCY_TIME_ZONE): number {
  const p = zonedParts(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Epoch ms of a wall-clock time in `timeZone`. */
export function zonedTimeToEpoch(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
  second = 0,
  timeZone = AGENCY_TIME_ZONE,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // Two passes converge across DST boundaries.
  let epoch = guess - zoneOffsetMs(guess, timeZone);
  epoch = guess - zoneOffsetMs(epoch, timeZone);
  return epoch;
}

/** "YYYYMMDD" for the agency-local calendar date of `epochMs`. */
export function localDate(epochMs: number, timeZone = AGENCY_TIME_ZONE): string {
  const p = zonedParts(epochMs, timeZone);
  return `${p.year}${pad(p.month)}${pad(p.day)}`;
}

export function addDays(date: string, days: number): string {
  const utc = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8) + days);
  const d = new Date(utc);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** Monday = 0 … Sunday = 6, matching GTFS calendar column order. */
export function weekdayIndex(date: string): number {
  const day = new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8))).getUTCDay();
  return (day + 6) % 7;
}

/** Epoch ms that GTFS time 00:00:00 refers to on `date` (noon minus 12h). */
export function serviceDayStart(date: string, timeZone = AGENCY_TIME_ZONE): number {
  const noon = zonedTimeToEpoch(+date.slice(0, 4), +date.slice(4, 6), +date.slice(6, 8), 12, 0, 0, timeZone);
  return noon - 12 * 3600 * 1000;
}

export function isServiceActive(service: ServiceRecord | undefined, date: string): boolean {
  if (!service) return false;
  if (service.removed.includes(date)) return false;
  if (service.added.includes(date)) return true;
  return date >= service.startDate && date <= service.endDate && service.days[weekdayIndex(date)] === true;
}

/**
 * Service dates whose trips can be running at `epochMs`: today and
 * yesterday (for after-midnight trips). Returned with each day's base epoch.
 */
export function activeServiceDays(epochMs: number, timeZone = AGENCY_TIME_ZONE): { date: string; start: number }[] {
  const today = localDate(epochMs, timeZone);
  return [addDays(today, -1), today, addDays(today, 1)].map((date) => ({
    date,
    start: serviceDayStart(date, timeZone),
  }));
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
