/**
 * Scheduled calls at a stop, from the per-pattern timetable files.
 */

import type { ScheduleFile } from '../../shared/types.ts';
import type { Network, StopVisit } from './network.ts';
import { activeServiceDays, isServiceActive } from './time.ts';

export interface ScheduledCall {
  tripId: string;
  patternId: string;
  /** Index of the stop in the pattern. */
  stopIndex: number;
  /** Epoch ms. */
  time: number;
  /** Epoch ms the trip leaves its first stop, used to tell if it should be running. */
  tripStart: number;
  /** Epoch ms the trip reaches its last stop. */
  tripEnd: number;
  serviceDate: string;
}

/**
 * Calls at a stop between `from` and `to` (epoch ms) across every pattern
 * visiting it. `schedules` holds whichever pattern files have loaded; missing
 * ones are skipped and filled in when they arrive.
 */
export function scheduledCalls(
  network: Network,
  visits: StopVisit[],
  schedules: ReadonlyMap<string, ScheduleFile>,
  from: number,
  to: number,
): ScheduledCall[] {
  const days = activeServiceDays(from).filter(({ start }) => start <= to);
  const calls: ScheduledCall[] = [];

  for (const { pattern, index } of visits) {
    const schedule = schedules.get(pattern.id);
    if (!schedule) continue;

    for (const { date, start } of days) {
      for (const [tripId, serviceId, tripStartSeconds, profileIndex] of schedule.trips) {
        const offset = schedule.profiles[profileIndex]?.[index];
        // Never trust a file that doesn't fit the pattern (e.g. mixed data versions).
        if (offset === undefined) continue;
        const profile = schedule.profiles[profileIndex]!;
        const time = start + (tripStartSeconds + offset) * 1000;
        if (time < from || time > to) continue;
        if (!isServiceActive(network.services[serviceId], date)) continue;

        calls.push({
          tripId,
          patternId: pattern.id,
          stopIndex: index,
          time,
          tripStart: start + tripStartSeconds * 1000,
          tripEnd: start + (tripStartSeconds + profile.at(-1)!) * 1000,
          serviceDate: date,
        });
      }
    }
  }

  return calls.sort((a, b) => a.time - b.time);
}

/** Every stop time of one trip, if its pattern's schedule has loaded. */
export function tripTimes(
  schedule: ScheduleFile,
  tripId: string,
  serviceDayStart: number,
): number[] | null {
  const trip = schedule.trips.find((entry) => entry[0] === tripId);
  if (!trip) return null;
  const profile = schedule.profiles[trip[3]]!;
  return profile.map((offset) => serviceDayStart + (trip[2] + offset) * 1000);
}
