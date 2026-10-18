/**
 * Turns NORTA's three GTFS-realtime feeds into one compact JSON snapshot.
 *
 * This runs at the edge (Cloudflare Pages Function) and in the Vite dev
 * server. It is deliberately free of platform APIs beyond `fetch`.
 *
 * Why a server step at all, rather than decoding protobuf in the browser:
 *   - one upstream request per cache window serves every rider, instead of
 *     every open tab polling NORTA;
 *   - trip ids are resolved to route patterns here, so the browser never
 *     downloads the 10k-trip index;
 *   - the payload is a fraction of the size, and a failed feed degrades the
 *     snapshot instead of breaking the page.
 */

import gtfsRealtime, { type transit_realtime } from 'gtfs-realtime-bindings';
import {
  REALTIME_FORMAT_VERSION,
  type RealtimeAlert,
  type RealtimeDetour,
  type RealtimeSnapshot,
  type RealtimeTrip,
  type RealtimeVehicle,
  type TripIndexFile,
  type TripStatus,
} from '../types.ts';

const { transit_realtime: rt } = gtfsRealtime;

export const FEED_URLS = {
  vehicles: 'https://bustime.norta.com/gtfsrt/vehicles',
  trips: 'https://bustime.norta.com/gtfsrt/trips',
  alerts: 'https://bustime.norta.com/gtfsrt/alerts',
} as const;

type FeedName = keyof typeof FEED_URLS;

/** Positions older than this are not a vehicle's current location. */
const MAX_VEHICLE_AGE_MS = 10 * 60 * 1000;
/** Predictions further in the past than this are dropped from the payload. */
const PAST_PREDICTION_GRACE_MS = 2 * 60 * 1000;
const UPSTREAM_TIMEOUT_MS = 8000;

export interface SnapshotDependencies {
  fetch: typeof fetch;
  tripIndex: TripIndexFile;
  now?: () => number;
  /** IANA zone for service dates; NORTA is America/Chicago. */
  timeZone?: string;
}

/** Decoded with `longs: Number`, so 64-bit fields are plain numbers at runtime. */
type FeedMessage = transit_realtime.IFeedMessage;
type Entity = transit_realtime.IFeedEntity;

export async function buildSnapshot(deps: SnapshotDependencies): Promise<RealtimeSnapshot> {
  const now = deps.now?.() ?? Date.now();
  const names = Object.keys(FEED_URLS) as FeedName[];
  const results = await Promise.allSettled(names.map((name) => fetchFeed(deps.fetch, FEED_URLS[name])));

  const feeds = {} as Record<FeedName, FeedMessage | null>;
  const degraded: string[] = [];

  results.forEach((result, index) => {
    const name = names[index]!;
    if (result.status === 'fulfilled') {
      feeds[name] = result.value;
    } else {
      feeds[name] = null;
      degraded.push(name);
    }
  });

  if (!feeds.vehicles && !feeds.trips) {
    const reason = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    throw new UpstreamError(`NORTA realtime feeds unavailable: ${describe(reason.reason)}`);
  }

  const index = deps.tripIndex;
  const patternOf = (tripId: string | null | undefined) => {
    if (!tripId) return null;
    const position = index.trips[tripId];
    return position === undefined ? null : index.patterns[position]!;
  };

  // ---------------------------------------------------------------- vehicles
  const vehicles: RealtimeVehicle[] = [];
  const headerTime = Number(feeds.vehicles?.header?.timestamp ?? 0) * 1000 || now;

  for (const entity of feeds.vehicles?.entity ?? []) {
    const vehicle = entity.vehicle;
    const position = vehicle?.position;
    if (!vehicle || !position || !isCoordinate(position.latitude, position.longitude)) continue;

    const timestamp = Number(vehicle.timestamp ?? 0) * 1000 || headerTime;
    if (now - timestamp > MAX_VEHICLE_AGE_MS) continue;

    const tripId = vehicle.trip?.tripId || null;
    const routeId = vehicle.trip?.routeId || null;
    if (!routeId) continue;

    vehicles.push({
      id: String(vehicle.vehicle?.id || vehicle.vehicle?.label || entity.id),
      routeId,
      tripId,
      patternId: patternOf(tripId),
      lat: round(position.latitude, 6),
      lng: round(position.longitude, 6),
      bearing: Number.isFinite(position.bearing) ? Math.round(position.bearing!) % 360 : null,
      speed: Number.isFinite(position.speed) ? round(position.speed!, 1) : null,
      timestamp,
    });
  }

  // ------------------------------------------------------- trip modifications
  const detours = buildDetours(feeds.trips?.entity ?? [], index, patternOf, serviceDate(now, deps.timeZone));
  const detourByTrip = new Map<string, string>();
  for (const detour of detours) {
    for (const tripId of detour.tripIds) detourByTrip.set(tripId, detour.id);
  }

  // ------------------------------------------------------------ trip updates
  const trips: Record<string, RealtimeTrip> = {};
  const timeBase = Math.floor(now / 1000);
  let resolvable = 0;
  let resolved = 0;

  for (const entity of feeds.trips?.entity ?? []) {
    const update = entity.tripUpdate;
    const tripId = update?.trip?.tripId;
    if (!update || !tripId) continue;

    const status = tripStatus(update.trip.scheduleRelationship);
    const patternId = patternOf(tripId);

    if (status !== 'added') {
      resolvable += 1;
      if (patternId) resolved += 1;
    }

    const stops: RealtimeTrip['stops'] = [];
    for (const stopUpdate of update.stopTimeUpdate ?? []) {
      if (!stopUpdate.stopId) continue;
      const skipped = stopUpdate.scheduleRelationship === rt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;
      const seconds = Number(stopUpdate.arrival?.time ?? stopUpdate.departure?.time ?? 0);
      if (seconds > 0 && !skipped && seconds * 1000 < now - PAST_PREDICTION_GRACE_MS) continue;
      stops.push([stopUpdate.stopId, seconds > 0 ? seconds - timeBase : null, skipped ? 1 : 0]);
    }

    trips[tripId] = {
      routeId: update.trip.routeId || '',
      patternId,
      vehicleId: update.vehicle?.id || null,
      status,
      detourId: update.trip.modifiedTrip?.modificationsId || detourByTrip.get(tripId) || null,
      stops,
    };
  }

  // ------------------------------------------------------------------ alerts
  const alerts: RealtimeAlert[] = [];
  for (const entity of feeds.alerts?.entity ?? []) {
    const alert = entity.alert;
    if (!alert) continue;

    const periods = (alert.activePeriod ?? []).map(
      (period) =>
        [
          Number(period.start ?? 0) ? Number(period.start) * 1000 : null,
          Number(period.end ?? 0) ? Number(period.end) * 1000 : null,
        ] as [number | null, number | null],
    );
    const active = !periods.length || periods.some(([start, end]) => (start ?? -Infinity) <= now && now <= (end ?? Infinity));
    if (!active) continue;

    alerts.push({
      id: entity.id,
      header: translate(alert.headerText),
      description: translate(alert.descriptionText),
      url: translate(alert.url) || null,
      cause: enumName(rt.Alert.Cause, alert.cause),
      effect: enumName(rt.Alert.Effect, alert.effect),
      periods,
      routes: unique((alert.informedEntity ?? []).map((selector) => selector.routeId).filter(isString)),
      stops: unique((alert.informedEntity ?? []).map((selector) => selector.stopId).filter(isString)),
    });
  }

  return {
    format: REALTIME_FORMAT_VERSION,
    feedTime: Number(feeds.trips?.header?.timestamp ?? feeds.vehicles?.header?.timestamp ?? 0) * 1000 || now,
    fetchedAt: now,
    timeBase,
    staticVersion: index.feedVersion,
    vehicles,
    trips,
    alerts,
    detours,
    tripMatchRate: resolvable ? round(resolved / resolvable, 3) : 1,
    degraded,
  };
}

// ---------------------------------------------------------------------------

function buildDetours(
  entities: Entity[],
  index: TripIndexFile,
  patternOf: (tripId: string) => string | null,
  today: string,
): RealtimeDetour[] {
  const shapes = new Map<string, string>();
  for (const entity of entities) {
    if (entity.shape?.shapeId && entity.shape.encodedPolyline) {
      shapes.set(entity.shape.shapeId, entity.shape.encodedPolyline);
    }
  }

  const patternStops = new Map(index.patterns.map((id, position) => [id, index.patternStops[position]!]));
  const detours: RealtimeDetour[] = [];

  for (const entity of entities) {
    const modification = entity.tripModifications;
    if (!modification) continue;

    const dates = modification.serviceDates ?? [];
    if (dates.length && !dates.includes(today)) continue;

    const tripIds = unique((modification.selectedTrips ?? []).flatMap((selection) => selection.tripIds ?? []));
    const shapeId = modification.selectedTrips?.find((selection) => selection.shapeId)?.shapeId;
    const patternIds = unique(tripIds.map(patternOf).filter(isString));
    const skippedStops: Record<string, string[]> = {};

    for (const patternId of patternIds) {
      const stops = patternStops.get(patternId) ?? [];
      const skipped = new Set<string>();

      for (const change of modification.modifications ?? []) {
        const start = selectStop(stops, change.startStopSelector);
        const end = selectStop(stops, change.endStopSelector);
        if (start === -1 || end === -1 || end < start) continue;
        for (let position = start; position <= end; position += 1) skipped.add(stops[position]!);
        // Replacement stops are served; never mark them skipped.
        for (const replacement of change.replacementStops ?? []) {
          if (replacement.stopId) skipped.delete(replacement.stopId);
        }
      }

      if (skipped.size) skippedStops[patternId] = [...skipped];
    }

    const delays = (modification.modifications ?? [])
      .map((change) => Number(change.propagatedModificationDelay ?? 0))
      .filter((delay) => delay !== 0);

    detours.push({
      id: entity.id,
      routeIds: unique(patternIds.map((patternId) => routeOfPattern(patternId, index)).filter(isString)),
      patternIds,
      tripIds,
      shape: (shapeId && shapes.get(shapeId)) || null,
      skippedStops,
      delayMinutes: delays.length ? Math.round(delays.reduce((sum, delay) => sum + delay, 0) / 60) : null,
    });
  }

  return detours;
}

function routeOfPattern(patternId: string, index: TripIndexFile): string | null {
  return index.patternRoutes[index.patterns.indexOf(patternId)] ?? null;
}

function selectStop(
  stops: string[],
  selector: { stopId?: string | null; stopSequence?: number | null } | null | undefined,
): number {
  if (!selector) return -1;
  if (selector.stopId) return stops.indexOf(selector.stopId);
  // GTFS stop_sequence is 1-based and contiguous in NORTA's feed.
  if (selector.stopSequence) return selector.stopSequence - 1;
  return -1;
}

async function fetchFeed(fetchImpl: typeof fetch, url: string): Promise<FeedMessage> {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/x-protobuf, application/octet-stream' },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new UpstreamError(`${url} returned HTTP ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const message = rt.FeedMessage.decode(bytes);
  return rt.FeedMessage.toObject(message, { longs: Number, enums: Number, defaults: false }) as FeedMessage;
}

function tripStatus(value: number | null | undefined): TripStatus {
  const relationship = rt.TripDescriptor.ScheduleRelationship;
  if (value === relationship.CANCELED || value === relationship.DELETED) return 'canceled';
  if (value === relationship.ADDED || value === relationship.NEW || value === relationship.DUPLICATED) return 'added';
  return 'scheduled';
}

/** Service date (YYYYMMDD) in the agency zone, using GTFS's noon-minus-12h rule loosely. */
export function serviceDate(epochMs: number, timeZone = 'America/Chicago'): string {
  // Trips after midnight belong to the previous service day until ~4am.
  const shifted = epochMs - 4 * 3600 * 1000;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(shifted)
    .replace(/-/g, '');
}

function translate(text: { translation?: { text?: string | null; language?: string | null }[] | null } | null | undefined): string {
  const translations = text?.translation ?? [];
  const english = translations.find((entry) => !entry.language || entry.language.startsWith('en'));
  return (english ?? translations[0])?.text?.trim() ?? '';
}

function enumName(enumeration: Record<string, number | string>, value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const name = Object.keys(enumeration).find((key) => enumeration[key] === value);
  return name && !/^UNKNOWN/.test(name) ? name.toLowerCase() : null;
}

function isCoordinate(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' && typeof lng === 'number' && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0)
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class UpstreamError extends Error {
  override name = 'UpstreamError';
}
