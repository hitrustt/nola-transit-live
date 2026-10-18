/**
 * Rider-facing wording for times and distances. Kept in one place so the
 * whole app says "Due", "4 min", "2 min late" the same way.
 */

import { AGENCY_TIME_ZONE } from './time.ts';

const clockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: AGENCY_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});

/** "6:42 PM" in New Orleans time, whatever zone the device is in. */
export function clockTime(epochMs: number): string {
  return clockFormatter.format(epochMs);
}

/** "18:30" GTFS-style (may exceed 24) -> "6:30 PM". */
export function gtfsClock(value: string): string {
  const [hours = 0, minutes = 0] = value.split(':').map(Number);
  const hour = hours % 24;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 || 12}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

export interface Countdown {
  /** Large text: "Due", "4", "6:42". */
  value: string;
  /** Unit after the value: "min", "PM", or "". */
  unit: string;
  /** Full phrase for screen readers. */
  spoken: string;
}

/** Departures within an hour count down; later ones show the clock. */
export function countdown(epochMs: number, now: number): Countdown {
  const minutes = Math.floor((epochMs - now) / 60_000);

  if (minutes < 1) {
    return { value: 'Due', unit: '', spoken: 'due now' };
  }

  if (minutes < 60) {
    return { value: String(minutes), unit: 'min', spoken: `in ${minutes} minute${minutes === 1 ? '' : 's'}` };
  }

  const [time = '', period = ''] = clockTime(epochMs).split(' ');
  return { value: time, unit: period, spoken: `at ${clockTime(epochMs)}` };
}

/** "on time", "3 min late", "1 min early". Under a minute either way is on time. */
export function delayLabel(delaySeconds: number | null): { text: string; tone: 'on-time' | 'late' | 'early' } | null {
  if (delaySeconds === null) return null;
  const minutes = Math.round(delaySeconds / 60);
  if (minutes === 0) return { text: 'On time', tone: 'on-time' };
  if (minutes > 0) return { text: `${minutes} min late`, tone: 'late' };
  return { text: `${-minutes} min early`, tone: 'early' };
}

/** "just now", "40 sec ago", "3 min ago" for data freshness. */
export function ago(epochMs: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 15) return 'just now';
  if (seconds < 60) return `${seconds} sec ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `at ${clockTime(epochMs)}`;
}

/** Feet under a tenth of a mile, otherwise miles — US riders think in both. */
export function distance(meters: number): string {
  const miles = meters / 1609.344;
  if (miles < 0.1) return `${Math.max(50, Math.round((meters * 3.28084) / 50) * 50)} ft`;
  return `${miles < 10 ? miles.toFixed(1) : Math.round(miles)} mi`;
}

/** Walking minutes at a typical 1.3 m/s, rounded up. */
export function walkMinutes(meters: number): number {
  return Math.max(1, Math.ceil(meters / 1.3 / 60));
}

export function modeNoun(mode: 'bus' | 'streetcar' | 'ferry', count = 1): string {
  const noun = mode === 'bus' ? (count === 1 ? 'bus' : 'buses') : mode === 'ferry' ? (count === 1 ? 'ferry' : 'ferries') : count === 1 ? 'streetcar' : 'streetcars';
  return noun;
}

export function vehicleCountLabel(counts: Record<'bus' | 'streetcar' | 'ferry', number>): string {
  const parts = (['streetcar', 'bus', 'ferry'] as const)
    .filter((mode) => counts[mode] > 0)
    .map((mode) => `${counts[mode]} ${modeNoun(mode, counts[mode])}`);
  return parts.length ? parts.join(', ') : 'No vehicles reporting';
}
