/**
 * Builds every static data file the app and the edge function use, from
 * NORTA's published GTFS feed.
 *
 *   npm run data              # use .cache/gtfs, downloading it if missing
 *   npm run data -- --fetch   # always download a fresh copy first
 *
 * Outputs
 *   public/data/network.json         routes, patterns, stops, service calendar
 *   public/data/route-lines.json     map lines with parallel-offset slots
 *   public/data/schedules/<id>.json  timetable per pattern, loaded on demand
 *   shared/generated/trips.json      trip -> pattern index for the API
 *
 * The build refuses to publish a feed that has expired or is about to, because
 * a stale timetable silently produces wrong arrival times — which is exactly
 * how the previous version of this app broke.
 */

import fs from 'node:fs';
import path from 'node:path';
import { cumulativeDistances, projectOntoLine } from '../../shared/geo.ts';
import { encodePolyline, type LatLng } from '../../shared/polyline.ts';
import {
  NETWORK_FORMAT_VERSION,
  type DirectionSummary,
  type Mode,
  type NetworkFile,
  type PatternRecord,
  type RouteRecord,
  type ScheduleFile,
  type ServiceRecord,
  type StopRecord,
  type TripIndexFile,
} from '../../shared/types.ts';
import { routeColors } from './colors.ts';
import { buildRouteLines } from './corridors.ts';
import { createGtfsReader, parseGtfsTime } from './csv.ts';
import { CACHE_DIR, fetchGtfs, GTFS_URL } from './fetch.ts';
import { normalizeStopName } from './names.ts';
import { dedupe, simplifyMeters } from './simplify.ts';

const ROOT = process.cwd();
const OUT_PUBLIC = path.join(ROOT, 'public', 'data');
const OUT_SHARED = path.join(ROOT, 'shared', 'generated');

/**
 * GTFS route_type to the three modes the app draws. Covers the basic types
 * and the extended (Google) ones, so a new kind of service in a future feed
 * shows up as the nearest mode instead of silently disappearing.
 */
function modeFor(routeType: string | undefined): Mode | null {
  const type = Number(routeType);
  if (!Number.isFinite(type)) return null;
  if (type === 0 || type === 5 || type === 12 || (type >= 900 && type < 1000)) return 'streetcar';
  if (type === 4 || (type >= 1000 && type < 1300)) return 'ferry';
  // Bus, trolleybus, coach, demand-responsive, and anything else on the road.
  return 'bus';
}
const EXCLUDED_ROUTE = /test/i;
/** Shape simplification for snapping and diagrams: well under GPS error. */
const SHAPE_TOLERANCE_M = 1.5;
/** Fail the build if the feed ends sooner than this. */
const MIN_REMAINING_DAYS = 7;

async function main() {
  const args = new Set(process.argv.slice(2));

  if (args.has('--fetch') || !fs.existsSync(path.join(CACHE_DIR, 'stop_times.txt'))) {
    await fetchGtfs(GTFS_URL);
  }

  const gtfs = createGtfsReader(CACHE_DIR);

  // ------------------------------------------------------------------ feed
  const feedInfo = gtfs.read('feed_info.txt', false)[0];
  const calendarRows = gtfs.read('calendar.txt', false);
  const calendarDateRows = gtfs.read('calendar_dates.txt', false);
  const feedStart =
    feedInfo?.feed_start_date || minOf(calendarRows.map((row) => row.start_date!));
  const feedEnd = feedInfo?.feed_end_date || maxOf(calendarRows.map((row) => row.end_date!));
  const feedVersion = feedInfo?.feed_version || `${feedStart}-${feedEnd}`;

  const today = chicagoDate(new Date());
  const remaining = daysBetween(today, feedEnd);

  if (remaining < MIN_REMAINING_DAYS && !args.has('--allow-expiring')) {
    throw new Error(
      `GTFS feed ${feedVersion} ends ${feedEnd} (${remaining} days away). ` +
        'Fetch a newer feed with --fetch, or pass --allow-expiring to build anyway.',
    );
  }

  // ---------------------------------------------------------------- agency
  const agencyRow = gtfs.read('agency.txt')[0]!;
  const fareRow = gtfs.read('fare_attributes.txt', false)[0];

  // ---------------------------------------------------------------- routes
  const routeRows = gtfs
    .read('routes.txt')
    .filter((route) => modeFor(route.route_type) && !EXCLUDED_ROUTE.test(route.route_long_name ?? ''))
    .sort((a, b) => compareRouteNames(a.route_short_name!, b.route_short_name!));
  const routeRowById = new Map(routeRows.map((row) => [row.route_id!, row]));

  // ----------------------------------------------------------------- trips
  // Deadhead/positioning runs are published with a "Not in Service" headsign;
  // riders cannot board them, so they never appear as arrivals.
  const tripRows = gtfs
    .read('trips.txt')
    .filter((trip) => routeRowById.has(trip.route_id!) && !/not in service/i.test(trip.trip_headsign ?? ''));
  const tripById = new Map(tripRows.map((trip) => [trip.trip_id!, trip]));

  // ------------------------------------------------------------ stop_times
  interface TripStops {
    stops: string[];
    times: number[];
    sequences: number[];
  }

  const stopTimesByTrip = new Map<string, TripStops>();

  gtfs.each('stop_times.txt', (values, column) => {
    const tripId = values[column.trip_id!]!;
    if (!tripById.has(tripId)) return;

    const time =
      parseGtfsTime(values[column.departure_time!]) ?? parseGtfsTime(values[column.arrival_time!]);
    let entry = stopTimesByTrip.get(tripId);

    if (!entry) {
      entry = { stops: [], times: [], sequences: [] };
      stopTimesByTrip.set(tripId, entry);
    }

    entry.stops.push(values[column.stop_id!]!);
    entry.times.push(time ?? Number.NaN);
    entry.sequences.push(Number(values[column.stop_sequence!]));
  });

  for (const entry of stopTimesByTrip.values()) {
    const order = entry.sequences.map((_, index) => index).sort((a, b) => entry.sequences[a]! - entry.sequences[b]!);
    entry.stops = order.map((index) => entry.stops[index]!);
    entry.times = interpolateMissingTimes(order.map((index) => entry.times[index]!));
  }

  // ---------------------------------------------------------------- shapes
  const rawShapes = new Map<string, { seq: number; point: LatLng }[]>();

  // shapes.txt is optional in GTFS; trips without one get a shape from their stops below.
  gtfs.each('shapes.txt', (values, column) => {
    const shapeId = values[column.shape_id!]!;
    let points = rawShapes.get(shapeId);
    if (!points) {
      points = [];
      rawShapes.set(shapeId, points);
    }
    points.push({
      seq: Number(values[column.shape_pt_sequence!]),
      point: [Number(values[column.shape_pt_lat!]), Number(values[column.shape_pt_lon!])],
    });
  }, false);

  const shapeById = new Map<string, LatLng[]>();
  for (const [shapeId, points] of rawShapes) {
    points.sort((a, b) => a.seq - b.seq);
    shapeById.set(shapeId, dedupe(points.map((entry) => entry.point)));
  }

  // ----------------------------------------------------------------- stops
  const stopRows = gtfs.read('stops.txt').filter((stop) => (stop.location_type || '0') === '0');
  const stopRowById = new Map(stopRows.map((stop) => [stop.stop_id!, stop]));

  // -------------------------------------------------------------- patterns
  // A pattern is a distinct (route, direction, shape, stop sequence).
  interface PatternBuild {
    key: string;
    routeId: string;
    directionId: number;
    shapeId: string;
    stops: string[];
    trips: string[];
    headsigns: Map<string, number>;
  }

  const patternByKey = new Map<string, PatternBuild>();
  const patternKeyByTrip = new Map<string, string>();

  for (const trip of tripRows) {
    const stopTimes = stopTimesByTrip.get(trip.trip_id!);
    if (!stopTimes || stopTimes.stops.length < 2) continue;

    // No published shape: draw the trip stop to stop rather than dropping it.
    if (!trip.shape_id || !shapeById.has(trip.shape_id)) {
      const synthetic = `stops-${trip.route_id}-${hash(stopTimes.stops.join('>'))}`;
      if (!shapeById.has(synthetic)) {
        shapeById.set(
          synthetic,
          stopTimes.stops.map((stopId) => {
            const stop = stopRowById.get(stopId);
            return [Number(stop?.stop_lat), Number(stop?.stop_lon)] as LatLng;
          }),
        );
        console.warn(`Trip ${trip.trip_id} (route ${trip.route_id}) has no shape; drawing it stop to stop.`);
      }
      trip.shape_id = synthetic;
    }

    const directionId = Number(trip.direction_id || 0);
    const key = [trip.route_id, directionId, trip.shape_id, stopTimes.stops.join('>')].join('|');
    let pattern = patternByKey.get(key);

    if (!pattern) {
      pattern = {
        key,
        routeId: trip.route_id!,
        directionId,
        shapeId: trip.shape_id!,
        stops: stopTimes.stops,
        trips: [],
        headsigns: new Map(),
      };
      patternByKey.set(key, pattern);
    }

    pattern.trips.push(trip.trip_id!);
    const headsign = cleanHeadsign(trip.trip_headsign || '');
    pattern.headsigns.set(headsign, (pattern.headsigns.get(headsign) ?? 0) + 1);
    patternKeyByTrip.set(trip.trip_id!, key);
  }

  // Stable, file-safe ids: the shape id, suffixed if a shape has several patterns.
  const patternIdByKey = new Map<string, string>();
  const usedIds = new Map<string, number>();
  for (const pattern of [...patternByKey.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const base = pattern.shapeId.replace(/[^A-Za-z0-9_-]/g, '_');
    const count = usedIds.get(base) ?? 0;
    usedIds.set(base, count + 1);
    patternIdByKey.set(pattern.key, count ? `${base}~${count}` : base);
  }

  const patternRecords: PatternRecord[] = [];
  const patternShapeById = new Map<string, LatLng[]>();

  for (const pattern of patternByKey.values()) {
    const id = patternIdByKey.get(pattern.key)!;
    const shape = simplifyMeters(shapeById.get(pattern.shapeId)!, SHAPE_TOLERANCE_M);
    const distances = cumulativeDistances(shape);
    const stopDistances = projectStopsInOrder(
      pattern.stops.map((stopId) => {
        const stop = stopRowById.get(stopId)!;
        return [Number(stop.stop_lat), Number(stop.stop_lon)] as LatLng;
      }),
      shape,
      distances,
    );

    patternShapeById.set(id, shape);
    patternRecords.push({
      id,
      routeId: pattern.routeId,
      directionId: pattern.directionId,
      headsign: topKey(pattern.headsigns),
      shape: encodePolyline(shape),
      lengthMeters: Math.round(distances.at(-1)!),
      stops: pattern.stops,
      stopDistances: stopDistances.map(Math.round),
      tripCount: pattern.trips.length,
    });
  }

  patternRecords.sort(
    (a, b) =>
      compareRouteNames(routeRowById.get(a.routeId)!.route_short_name!, routeRowById.get(b.routeId)!.route_short_name!) ||
      a.directionId - b.directionId ||
      b.tripCount - a.tripCount,
  );

  // -------------------------------------------------------------- services
  const services: Record<string, ServiceRecord> = {};
  for (const row of calendarRows) {
    services[row.service_id!] = {
      days: [row.monday, row.tuesday, row.wednesday, row.thursday, row.friday, row.saturday, row.sunday].map(
        (value) => value === '1',
      ) as ServiceRecord['days'],
      startDate: row.start_date!,
      endDate: row.end_date!,
      added: [],
      removed: [],
    };
  }
  for (const row of calendarDateRows) {
    const service = (services[row.service_id!] ??= {
      days: [false, false, false, false, false, false, false],
      startDate: row.date!,
      endDate: row.date!,
      added: [],
      removed: [],
    });
    (row.exception_type === '1' ? service.added : service.removed).push(row.date!);
  }

  // ------------------------------------------------------------- schedules
  fs.rmSync(path.join(OUT_PUBLIC, 'schedules'), { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT_PUBLIC, 'schedules'), { recursive: true });

  let scheduleBytes = 0;
  for (const pattern of patternByKey.values()) {
    const id = patternIdByKey.get(pattern.key)!;
    const profileIndex = new Map<string, number>();
    const profiles: number[][] = [];
    const trips: ScheduleFile['trips'] = [];

    for (const tripId of pattern.trips) {
      const { times } = stopTimesByTrip.get(tripId)!;
      const start = times[0]!;
      const profile = times.map((time) => time - start);
      const profileKey = profile.join(',');
      let index = profileIndex.get(profileKey);

      if (index === undefined) {
        index = profiles.length;
        profiles.push(profile);
        profileIndex.set(profileKey, index);
      }

      trips.push([tripId, tripById.get(tripId)!.service_id!, start, index]);
    }

    trips.sort((a, b) => a[2] - b[2]);
    const file: ScheduleFile = { pattern: id, feedVersion, profiles, trips };
    const json = JSON.stringify(file);
    scheduleBytes += json.length;
    fs.writeFileSync(path.join(OUT_PUBLIC, 'schedules', `${id}.json`), json);
  }

  // ---------------------------------------------------------------- routes
  const dayTypeServices = {
    weekday: serviceIdsForWeekday(services, 2),
    saturday: serviceIdsForWeekday(services, 5),
    sunday: serviceIdsForWeekday(services, 6),
  };

  const routeRecords: RouteRecord[] = [];
  routeRows.forEach((row, index) => {
    const patterns = patternRecords.filter((pattern) => pattern.routeId === row.route_id);
    if (!patterns.length) return;

    const builds = patterns.map((record) =>
      [...patternByKey.values()].find((build) => patternIdByKey.get(build.key) === record.id)!,
    );

    const directionIds = [...new Set(patterns.map((pattern) => pattern.directionId))].sort();
    const directions: DirectionSummary[] = directionIds.map((directionId) => {
      const headsigns = new Map<string, number>();
      builds
        .filter((build) => build.directionId === directionId)
        .forEach((build) => build.headsigns.forEach((count, name) => headsigns.set(name, (headsigns.get(name) ?? 0) + count)));
      const ordered = [...headsigns.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
      // The busiest pattern, and on a tie the longer one: a short shuttle
      // (St. Charles runs a bus bridge with as many trips as the streetcar)
      // is not what a rider means by "the route".
      const main = patterns
        .filter((pattern) => pattern.directionId === directionId)
        .sort((a, b) => b.tripCount - a.tripCount || b.stops.length - a.stops.length)[0]!;

      return {
        id: directionId,
        headsign: main.headsign || ordered[0] || '',
        headsigns: [main.headsign, ...ordered.filter((name) => name !== main.headsign)].filter(Boolean),
        mainPattern: main.id,
      };
    });

    const allTrips = builds.flatMap((build) => build.trips);
    const startTimes = (tripIds: string[], serviceIds: Set<string>) =>
      tripIds
        .filter((tripId) => serviceIds.has(tripById.get(tripId)!.service_id!))
        .map((tripId) => stopTimesByTrip.get(tripId)!.times[0]!);

    // Headway as a rider at a mid-route stop sees it: every trip in the main
    // direction that serves that stop, whichever pattern it runs. Counting
    // trip starts instead mixes terminals and short-turns and overstates
    // frequency.
    const mainDirection = directions[0]!;
    const mainStops = patterns.find((pattern) => pattern.id === mainDirection.mainPattern)!.stops;
    const probeStop = mainStops[Math.floor(mainStops.length / 2)]!;
    const timesAtProbe = (serviceIds: Set<string>) =>
      builds
        .filter((build) => build.directionId === mainDirection.id)
        .flatMap((build) => {
          const index = build.stops.indexOf(probeStop);
          if (index === -1) return [];
          return build.trips
            .filter((tripId) => serviceIds.has(tripById.get(tripId)!.service_id!))
            .map((tripId) => stopTimesByTrip.get(tripId)!.times[index]!);
        });

    const spanSource = startTimes(allTrips, dayTypeServices.weekday);
    const fallbackSpan = spanSource.length ? spanSource : startTimes(allTrips, new Set(Object.keys(services)));

    routeRecords.push({
      id: row.route_id!,
      shortName: row.route_short_name!,
      longName: row.route_long_name!.trim(),
      mode: modeFor(row.route_type)!,
      ...routeColors(row.route_color ?? '', index),
      patterns: [...patterns].sort((a, b) => b.tripCount - a.tripCount || b.stops.length - a.stops.length).map((pattern) => pattern.id),
      directions,
      headways: {
        weekday: typicalHeadway(timesAtProbe(dayTypeServices.weekday)),
        saturday: typicalHeadway(timesAtProbe(dayTypeServices.saturday)),
        sunday: typicalHeadway(timesAtProbe(dayTypeServices.sunday)),
      },
      span: fallbackSpan.length
        ? { first: clock(Math.min(...fallbackSpan)), last: clock(Math.max(...fallbackSpan)) }
        : null,
    });
  });

  // ----------------------------------------------------------------- stops
  const routeOrder = new Map(routeRecords.map((route, index) => [route.id, index]));
  const routesByStop = new Map<string, Set<string>>();
  for (const pattern of patternRecords) {
    for (const stopId of pattern.stops) {
      if (!routesByStop.has(stopId)) routesByStop.set(stopId, new Set());
      routesByStop.get(stopId)!.add(pattern.routeId);
    }
  }

  const stopRecords: StopRecord[] = [...routesByStop.keys()]
    .map((stopId) => {
      const row = stopRowById.get(stopId)!;
      return {
        id: stopId,
        code: row.stop_code || stopId,
        name: normalizeStopName(row.stop_name!),
        lat: round(Number(row.stop_lat), 6),
        lng: round(Number(row.stop_lon), 6),
        routes: [...routesByStop.get(stopId)!].sort((a, b) => routeOrder.get(a)! - routeOrder.get(b)!),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code));

  // ----------------------------------------------------------- route lines
  const routeLines = buildRouteLines(
    routeRecords.map((route, order) => ({
      routeId: route.id,
      routeOrder: order,
      shapes: route.patterns.map((id) => patternShapeById.get(id)!),
    })),
  );

  // ---------------------------------------------------------------- bounds
  const lats = stopRecords.map((stop) => stop.lat);
  const lngs = stopRecords.map((stop) => stop.lng);

  const network: NetworkFile = {
    format: NETWORK_FORMAT_VERSION,
    feed: {
      version: feedVersion,
      startDate: feedStart,
      endDate: feedEnd,
      generatedAt: new Date().toISOString(),
      sourceUrl: GTFS_URL,
    },
    agency: {
      name: 'New Orleans RTA',
      url: agencyRow.agency_url || 'https://www.norta.com/',
      phone: agencyRow.agency_phone || '',
      timezone: normalizeTimezone(agencyRow.agency_timezone || 'America/Chicago'),
      fareUrl: agencyRow.agency_fare_url || '',
      fare: fareRow
        ? {
            price: Number(fareRow.price),
            currency: fareRow.currency_type || 'USD',
            transferMinutes: Math.round(Number(fareRow.transfer_duration || 0) / 60),
          }
        : null,
    },
    bounds: [round(Math.min(...lngs), 5), round(Math.min(...lats), 5), round(Math.max(...lngs), 5), round(Math.max(...lats), 5)],
    routes: routeRecords,
    patterns: patternRecords,
    stops: stopRecords,
    services,
  };

  const tripIndex: TripIndexFile = {
    feedVersion,
    feedEndDate: feedEnd,
    patterns: patternRecords.map((pattern) => pattern.id),
    patternRoutes: patternRecords.map((pattern) => pattern.routeId),
    patternStops: patternRecords.map((pattern) => pattern.stops),
    trips: {},
  };
  const patternPosition = new Map(patternRecords.map((pattern, position) => [pattern.id, position]));
  for (const [tripId, key] of patternKeyByTrip) {
    tripIndex.trips[tripId] = patternPosition.get(patternIdByKey.get(key)!)!;
  }

  fs.mkdirSync(OUT_PUBLIC, { recursive: true });
  fs.mkdirSync(OUT_SHARED, { recursive: true });
  // Keep the previous build time when nothing else changed, so rebuilding an
  // unchanged feed produces no diff (the weekly refresh commits only real changes).
  const networkPath = path.join(OUT_PUBLIC, 'network.json');
  if (fs.existsSync(networkPath)) {
    const previous = JSON.parse(fs.readFileSync(networkPath, 'utf8')) as NetworkFile;
    const comparable = (file: NetworkFile) => JSON.stringify({ ...file, feed: { ...file.feed, generatedAt: '' } });
    if (comparable(previous) === comparable(network)) network.feed.generatedAt = previous.feed.generatedAt;
  }
  writeJson(networkPath, network);
  writeJson(path.join(OUT_PUBLIC, 'route-lines.json'), { type: 'FeatureCollection', features: routeLines });
  writeJson(path.join(OUT_SHARED, 'trips.json'), tripIndex);

  const size = (file: string) => `${(fs.statSync(file).size / 1024).toFixed(0)} KB`;
  console.log(
    [
      `Feed ${feedVersion}: ${feedStart} – ${feedEnd} (${remaining} days remaining)`,
      `${routeRecords.length} routes, ${patternRecords.length} patterns, ${stopRecords.length} stops, ${Object.keys(tripIndex.trips).length} trips`,
      `network.json ${size(path.join(OUT_PUBLIC, 'network.json'))}, route-lines.json ${size(path.join(OUT_PUBLIC, 'route-lines.json'))} (${routeLines.length} segments), schedules ${(scheduleBytes / 1024).toFixed(0)} KB, trips.json ${size(path.join(OUT_SHARED, 'trips.json'))}`,
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Distance along the shape for each stop, forced to advance. Each stop is
 * searched for only ahead of the previous one, so the second pass of a loop
 * or an out-and-back street does not snap to the first.
 */
function projectStopsInOrder(points: LatLng[], shape: LatLng[], distances: Float64Array): number[] {
  const total = distances.at(-1)!;
  const result: number[] = [];
  let previous = 0;

  for (const point of points) {
    // Look ahead far enough to reach the next stop, but not around the loop.
    let projection = projectOntoLine(point, shape, distances, previous, previous + 4000);
    if (projection.offsetMeters > 80) {
      projection = projectOntoLine(point, shape, distances, previous, total);
    }
    const distance = Math.max(previous, projection.distanceAlong);
    result.push(distance);
    previous = distance;
  }

  return result;
}

/** Fill missing intermediate times (non-timepoints) by linear interpolation. */
function interpolateMissingTimes(times: number[]): number[] {
  const result = [...times];
  let lastKnown = -1;

  for (let index = 0; index < result.length; index += 1) {
    if (Number.isNaN(result[index])) continue;

    if (lastKnown >= 0 && index - lastKnown > 1) {
      const from = result[lastKnown]!;
      const to = result[index]!;
      for (let fill = lastKnown + 1; fill < index; fill += 1) {
        result[fill] = Math.round(from + ((to - from) * (fill - lastKnown)) / (index - lastKnown));
      }
    }
    lastKnown = index;
  }

  return result.map((time, index) => (Number.isNaN(time) ? (result[index - 1] ?? 0) : time));
}

function serviceIdsForWeekday(services: Record<string, ServiceRecord>, mondayFirstDay: number): Set<string> {
  return new Set(
    Object.entries(services)
      .filter(([, service]) => service.days[mondayFirstDay])
      .map(([id]) => id),
  );
}

/** Median gap between departures 9am–3pm, or across the day if too few. */
function typicalHeadway(startTimes: number[]): number | null {
  const sorted = [...new Set(startTimes)].sort((a, b) => a - b);
  const midday = sorted.filter((time) => time >= 9 * 3600 && time <= 15 * 3600);
  const sample = midday.length >= 4 ? midday : sorted;
  const gaps: number[] = [];

  for (let index = 1; index < sample.length; index += 1) {
    const gap = sample[index]! - sample[index - 1]!;
    if (gap > 0 && gap <= 3 * 3600) gaps.push(gap);
  }

  if (gaps.length < 2) return null;
  gaps.sort((a, b) => a - b);
  return Math.max(1, Math.round(gaps[Math.floor(gaps.length / 2)]! / 60));
}

function cleanHeadsign(value: string): string {
  return normalizeStopName(value.replace(/^to\s+/i, ''));
}

function topKey(counts: Map<string, number>): string {
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

export function compareRouteNames(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

function clock(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** "US/Central" is a legacy alias; browsers accept it but America/Chicago is canonical. */
function normalizeTimezone(zone: string): string {
  return zone === 'US/Central' ? 'America/Chicago' : zone;
}

function chicagoDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return parts.replace(/-/g, '');
}

function daysBetween(from: string, to: string): number {
  const parse = (value: string) => Date.UTC(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8));
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

function minOf(values: string[]): string {
  return [...values].sort()[0] ?? '';
}

function maxOf(values: string[]): string {
  return [...values].sort().at(-1) ?? '';
}

/** Short stable hash for synthetic ids (FNV-1a). */
function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(36);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function writeJson(file: string, value: unknown) {
  fs.writeFileSync(file, JSON.stringify(value));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
