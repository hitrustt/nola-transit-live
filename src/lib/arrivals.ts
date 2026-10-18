/**
 * Departures at a stop: the timetable, corrected by NORTA's realtime
 * predictions.
 *
 * Every scheduled call in the window is a candidate. For each one:
 *
 *   - the trip is cancelled           -> kept, marked cancelled, so a rider
 *                                        waiting for it knows not to;
 *   - the stop is skipped (detour)    -> kept, marked skipped;
 *   - there is a prediction for this
 *     stop                            -> live time, with delay vs schedule;
 *   - the trip has a prediction for an
 *     earlier stop but not this one   -> that stop's delay carried forward;
 *   - the trip's predictions start
 *     after this stop                 -> the vehicle has passed: dropped;
 *   - no realtime at all              -> scheduled time, labelled as such.
 *
 * Trips NORTA adds that are not in the timetable are appended from their
 * predictions alone.
 */

import type { RealtimeSnapshot, RealtimeTrip, ScheduleFile } from '../../shared/types.ts';
import type { Network, Pattern, Route } from './network.ts';
import { scheduledCalls } from './schedule.ts';

export type DepartureStatus = 'live' | 'scheduled' | 'canceled' | 'skipped';

export interface Departure {
  key: string;
  tripId: string;
  route: Route;
  pattern: Pattern | null;
  headsign: string;
  /** Timetable time, epoch ms (null for added trips). */
  scheduled: number | null;
  /** Realtime prediction, epoch ms. */
  predicted: number | null;
  /** The time to show: predicted if there is one, else scheduled. */
  time: number;
  status: DepartureStatus;
  /** predicted - scheduled, seconds, when both exist. */
  delaySeconds: number | null;
  vehicleId: string | null;
  /** True if the trip runs on a published detour. */
  detoured: boolean;
}

export interface DepartureOptions {
  /** How far ahead to look, ms. */
  horizonMs?: number;
  /** How long a departure stays listed after its time ("Due"), ms. */
  graceMs?: number;
}

const DEFAULT_HORIZON_MS = 3 * 3600 * 1000;
const DEFAULT_GRACE_MS = 60 * 1000;

export function departuresForStop(
  network: Network,
  stopId: string,
  schedules: ReadonlyMap<string, ScheduleFile>,
  snapshot: RealtimeSnapshot | null,
  now: number,
  options: DepartureOptions = {},
): Departure[] {
  const horizon = options.horizonMs ?? DEFAULT_HORIZON_MS;
  const grace = options.graceMs ?? DEFAULT_GRACE_MS;
  const visits = network.visitsByStop.get(stopId) ?? [];
  // Look back far enough that a late vehicle's scheduled call is still a candidate.
  const calls = scheduledCalls(network, visits, schedules, now - 45 * 60 * 1000, now + horizon);
  const base = (snapshot?.timeBase ?? 0) * 1000;
  const skippedByDetour = detourSkips(snapshot);
  const seen = new Set<string>();
  const departures: Departure[] = [];

  for (const call of calls) {
    const pattern = network.patternsById.get(call.patternId)!;
    const key = `${call.tripId}:${call.stopIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const rt = snapshot?.trips[call.tripId];
    let status: DepartureStatus = 'scheduled';
    let predicted: number | null = null;

    if (rt) {
      const schedule = schedules.get(call.patternId);
      const times = schedule ? tripScheduleTimes(schedule, call.tripId, call.tripStart) : null;
      const resolved = resolvePrediction(rt, pattern, call.stopIndex, times, base);
      if (resolved === 'passed') continue;
      if (rt.status === 'canceled') status = 'canceled';
      else if (resolved === 'skipped') status = 'skipped';
      else if (resolved !== null) {
        status = 'live';
        predicted = resolved;
      }
    } else if (skippedByDetour.get(call.tripId)?.has(stopId)) {
      status = 'skipped';
    }

    const time = predicted ?? call.time;
    if (time < now - grace || time > now + horizon) continue;

    departures.push({
      key,
      tripId: call.tripId,
      route: pattern.route,
      pattern,
      headsign: pattern.headsign,
      scheduled: call.time,
      predicted,
      time,
      status,
      delaySeconds: predicted !== null ? Math.round((predicted - call.time) / 1000) : null,
      vehicleId: rt?.vehicleId ?? null,
      detoured: Boolean(rt?.detourId) || skippedByDetour.has(call.tripId),
    });
  }

  // Trips added in realtime that the timetable does not know about.
  for (const [tripId, rt] of Object.entries(snapshot?.trips ?? {})) {
    if (rt.status !== 'added') continue;
    const entry = rt.stops.find(([id]) => id === stopId);
    if (!entry || entry[1] === null || entry[2]) continue;

    const time = base + entry[1] * 1000;
    if (time < now - grace || time > now + horizon) continue;

    const route = network.routesById.get(rt.routeId);
    if (!route) continue;
    const pattern = rt.patternId ? (network.patternsById.get(rt.patternId) ?? null) : null;

    departures.push({
      key: `${tripId}:added`,
      tripId,
      route,
      pattern,
      headsign: pattern?.headsign ?? route.longName,
      scheduled: null,
      predicted: time,
      time,
      status: 'live',
      delaySeconds: null,
      vehicleId: rt.vehicleId,
      detoured: Boolean(rt.detourId),
    });
  }

  return departures.sort((a, b) => a.time - b.time || a.route.order - b.route.order);
}

/**
 * What realtime says about one call. Returns an epoch-ms prediction,
 * 'skipped', 'passed', or null when realtime has nothing to add.
 *
 * `scheduleTimes` are the trip's timetable times per stop index, used to
 * carry a delay forward from the nearest earlier predicted stop.
 */
export function resolvePrediction(
  rt: RealtimeTrip,
  pattern: Pattern,
  stopIndex: number,
  scheduleTimes: readonly number[] | null,
  base: number,
): number | 'skipped' | 'passed' | null {
  if (rt.status === 'canceled' || !rt.stops.length) return null;

  const positions = alignToPattern(rt.stops.map(([id]) => id), pattern.stops);
  const own = positions.indexOf(stopIndex);

  if (own !== -1) {
    const [, seconds, skipped] = rt.stops[own]!;
    if (skipped) return 'skipped';
    if (seconds !== null) return base + seconds * 1000;
  }

  // Predictions cover upcoming stops only. If the first of them is beyond
  // this stop, the vehicle has already been and gone.
  const first = positions.find((position) => position !== -1);
  if (first !== undefined && first > stopIndex) return 'passed';

  if (!scheduleTimes) return null;

  // Nearest earlier stop with a prediction: carry its delay forward. A bus
  // running early is assumed to hold at timepoints, so early delays are
  // not propagated — telling a rider a bus is early and being wrong means
  // they miss it.
  for (let order = positions.length - 1; order >= 0; order -= 1) {
    const position = positions[order]!;
    const [, seconds, skipped] = rt.stops[order]!;
    if (position === -1 || position >= stopIndex || skipped || seconds === null) continue;
    const delay = base + seconds * 1000 - scheduleTimes[position]!;
    return scheduleTimes[stopIndex]! + Math.max(0, delay);
  }

  return null;
}

/**
 * Map each realtime stop id to its index in the pattern, walking both in
 * travel order so a loop that visits a stop twice matches the right visit.
 * Unmatched stops get -1.
 *
 * Trip updates list the remaining stops through the end of the trip, so when
 * the last realtime stop is the pattern's last stop the lists are aligned
 * from the end. That matters on loops that end where they start: a lone
 * "terminal" prediction is the arrival at the end, not the departure from
 * the start — matching from the front made an already-departed bus look
 * like it was about to leave.
 */
export function alignToPattern(realtimeStops: readonly string[], patternStops: readonly string[]): number[] {
  if (realtimeStops.length && realtimeStops.at(-1) === patternStops.at(-1)) {
    const result: number[] = new Array(realtimeStops.length).fill(-1);
    let cursor = patternStops.length - 1;
    for (let order = realtimeStops.length - 1; order >= 0; order -= 1) {
      for (let index = cursor; index >= 0; index -= 1) {
        if (patternStops[index] === realtimeStops[order]) {
          result[order] = index;
          cursor = index - 1;
          break;
        }
      }
    }
    return result;
  }

  const result: number[] = [];
  let cursor = 0;

  for (const stopId of realtimeStops) {
    let found = -1;
    for (let index = cursor; index < patternStops.length; index += 1) {
      if (patternStops[index] === stopId) {
        found = index;
        break;
      }
    }
    result.push(found);
    if (found !== -1) cursor = found + 1;
  }

  return result;
}

const tripRowCache = new WeakMap<ScheduleFile, Map<string, ScheduleFile['trips'][number]>>();

/** Timetable times for every stop of a trip, epoch ms. */
export function tripScheduleTimes(schedule: ScheduleFile, tripId: string, tripStart: number): number[] | null {
  let rows = tripRowCache.get(schedule);
  if (!rows) {
    rows = new Map(schedule.trips.map((row) => [row[0], row]));
    tripRowCache.set(schedule, rows);
  }
  const row = rows.get(tripId);
  if (!row) return null;
  return schedule.profiles[row[3]]!.map((offset) => tripStart + offset * 1000);
}

/** tripId -> stops a published detour removes from that trip. */
function detourSkips(snapshot: RealtimeSnapshot | null): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const detour of snapshot?.detours ?? []) {
    const stops = new Set(Object.values(detour.skippedStops).flat());
    for (const tripId of detour.tripIds) result.set(tripId, stops);
  }
  return result;
}
