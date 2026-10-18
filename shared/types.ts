/**
 * Shapes of the generated data files and the realtime API payload. These are
 * the contracts between the build pipeline, the edge function and the app;
 * bump the `version` fields when one changes incompatibly.
 */

export type Mode = 'bus' | 'streetcar' | 'ferry';

// ---------------------------------------------------------------------------
// network.json — everything static the app needs at startup
// ---------------------------------------------------------------------------

export const NETWORK_FORMAT_VERSION = 2;

export interface NetworkFile {
  format: typeof NETWORK_FORMAT_VERSION;
  feed: FeedInfo;
  agency: AgencyInfo;
  /** [west, south, east, north] */
  bounds: [number, number, number, number];
  routes: RouteRecord[];
  patterns: PatternRecord[];
  stops: StopRecord[];
  services: Record<string, ServiceRecord>;
}

export interface FeedInfo {
  /** NORTA's feed_version, e.g. "S1000255". */
  version: string;
  /** YYYYMMDD, inclusive. */
  startDate: string;
  endDate: string;
  generatedAt: string;
  sourceUrl: string;
}

export interface AgencyInfo {
  name: string;
  url: string;
  phone: string;
  timezone: string;
  fareUrl: string;
  fare: { price: number; currency: string; transferMinutes: number } | null;
}

export interface RouteRecord {
  id: string;
  shortName: string;
  longName: string;
  mode: Mode;
  /** Colour for lines and markers, contrast-corrected against the basemap. */
  color: string;
  /** Text colour that reads on `color`. */
  textColor: string;
  /** Pattern ids, busiest first. */
  patterns: string[];
  directions: DirectionSummary[];
  /** Typical minutes between trips, by day type, busiest direction. */
  headways: { weekday: number | null; saturday: number | null; sunday: number | null };
  /** Earliest and latest scheduled trip, "HH:MM", for the busiest day type. */
  span: { first: string; last: string } | null;
}

export interface DirectionSummary {
  id: number;
  /** Most common headsign for the direction. */
  headsign: string;
  /** All headsigns used, busiest first. */
  headsigns: string[];
  /** The pattern to use for the route diagram. */
  mainPattern: string;
}

export interface PatternRecord {
  id: string;
  routeId: string;
  directionId: number;
  headsign: string;
  /** Encoded polyline, precision 5. */
  shape: string;
  lengthMeters: number;
  /** Stop ids in travel order. */
  stops: string[];
  /** Distance along `shape` of each stop, metres, rounded. */
  stopDistances: number[];
  tripCount: number;
}

export interface StopRecord {
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  /** Route ids that serve the stop, in route order. */
  routes: string[];
}

export interface ServiceRecord {
  /** Monday-first, like GTFS: [mon, tue, wed, thu, fri, sat, sun]. */
  days: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  startDate: string;
  endDate: string;
  added: string[];
  removed: string[];
}

// ---------------------------------------------------------------------------
// schedules/{patternId}.json — loaded on demand
// ---------------------------------------------------------------------------

export interface ScheduleFile {
  pattern: string;
  /**
   * Distinct running-time profiles: seconds from the trip's first stop to each
   * stop. Most trips on a pattern share a handful of these.
   */
  profiles: number[][];
  /** [tripId, serviceId, startSeconds, profileIndex], sorted by start time. */
  trips: [string, string, number, number][];
}

// ---------------------------------------------------------------------------
// trips.json — bundled into the edge function to resolve realtime trip ids
// ---------------------------------------------------------------------------

export interface TripIndexFile {
  feedVersion: string;
  /** Feed end date, YYYYMMDD, so the API can flag an expired schedule. */
  feedEndDate: string;
  patterns: string[];
  /** Route id per pattern, parallel to `patterns`. */
  patternRoutes: string[];
  /** Stop ids per pattern, parallel to `patterns`. */
  patternStops: string[][];
  /** tripId -> index into `patterns` */
  trips: Record<string, number>;
}

// ---------------------------------------------------------------------------
// /api/realtime
// ---------------------------------------------------------------------------

export const REALTIME_FORMAT_VERSION = 2;

export interface RealtimeSnapshot {
  format: typeof REALTIME_FORMAT_VERSION;
  /** Feed header timestamp, epoch ms. */
  feedTime: number;
  /** When the edge fetched the feeds, epoch ms. */
  fetchedAt: number;
  /** Epoch seconds that trip stop times are relative to. */
  timeBase: number;
  /** feed_version of the static data this server resolved trips against. */
  staticVersion: string;
  vehicles: RealtimeVehicle[];
  trips: Record<string, RealtimeTrip>;
  alerts: RealtimeAlert[];
  /** Planned detours (GTFS-RT TripModifications) in effect today. */
  detours: RealtimeDetour[];
  /** Fraction of realtime trips found in the static schedule (0-1). */
  tripMatchRate: number;
  /** Feeds that failed this cycle; the snapshot is partial if non-empty. */
  degraded: string[];
}

export interface RealtimeVehicle {
  id: string;
  routeId: string;
  tripId: string | null;
  patternId: string | null;
  lat: number;
  lng: number;
  /** Degrees, 0 = north, or null when not reported. */
  bearing: number | null;
  /** Metres per second, or null when not reported. */
  speed: number | null;
  /** When the vehicle reported this position, epoch ms. */
  timestamp: number;
}

export type TripStatus = 'scheduled' | 'added' | 'canceled';

export interface RealtimeTrip {
  routeId: string;
  patternId: string | null;
  vehicleId: string | null;
  status: TripStatus;
  /** Id of the detour in `RealtimeSnapshot.detours` this trip runs on, if any. */
  detourId: string | null;
  /**
   * Upcoming stops: [stopId, predicted seconds after `timeBase`, skipped].
   * Stops the vehicle has passed are not included. Times are relative to keep
   * the payload small; this is polled continuously on phones.
   */
  stops: [stopId: string, seconds: number | null, skipped: 0 | 1][];
}

export interface RealtimeDetour {
  id: string;
  routeIds: string[];
  patternIds: string[];
  /** Scheduled trips that run the detour. */
  tripIds: string[];
  /** Detour path as an encoded polyline, if published. */
  shape: string | null;
  /**
   * Stops the detour removes, per affected pattern. Computed from the
   * modification's start/end stop selectors against the static pattern.
   */
  skippedStops: Record<string, string[]>;
  /** Extra minutes the detour adds (positive = later), when published. */
  delayMinutes: number | null;
}

export interface RealtimeAlert {
  id: string;
  header: string;
  description: string;
  url: string | null;
  cause: string | null;
  effect: string | null;
  /** [start, end] epoch ms; either may be null for open-ended. */
  periods: [number | null, number | null][];
  routes: string[];
  stops: string[];
}
