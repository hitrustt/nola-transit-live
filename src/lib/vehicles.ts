/**
 * Vehicles from the realtime snapshot, placed on their route.
 *
 * NORTA reports the trip each vehicle is running, so the pattern (and its
 * exact shape) is known — no guessing direction from GPS. Positions are
 * snapped onto that shape so markers sit on the street and can glide along
 * it between updates instead of cutting corners.
 */

import { haversineMeters, pointAlongLine, projectOntoLine } from '../../shared/geo.ts';
import type { LatLng } from '../../shared/polyline.ts';
import type { RealtimeSnapshot, RealtimeVehicle } from '../../shared/types.ts';
import type { Network, Pattern, Route } from './network.ts';

/** Further than this from the shape and the vehicle is off-route (detour, deadhead). */
const MAX_SNAP_METERS = 60;
/** A position this old is shown faded: the vehicle may have moved a lot since. */
export const STALE_POSITION_MS = 3 * 60 * 1000;

export interface TrackedVehicle {
  id: string;
  route: Route;
  tripId: string | null;
  pattern: Pattern | null;
  /** Metres along `pattern.shape`, or null when off-route or unknown. */
  distanceAlong: number | null;
  position: LatLng;
  /** Degrees, 0 = north. */
  heading: number;
  speed: number | null;
  timestamp: number;
  headsign: string;
}

export function trackVehicles(
  network: Network,
  snapshot: RealtimeSnapshot,
  previous: ReadonlyMap<string, TrackedVehicle>,
): Map<string, TrackedVehicle> {
  const result = new Map<string, TrackedVehicle>();

  for (const raw of snapshot.vehicles) {
    const route = network.routesById.get(raw.routeId);
    if (!route) continue;

    const pattern = raw.patternId ? (network.patternsById.get(raw.patternId) ?? null) : null;
    const before = previous.get(raw.id);
    result.set(raw.id, place(raw, route, pattern, before?.tripId === raw.tripId ? before : undefined));
  }

  return result;
}

function place(raw: RealtimeVehicle, route: Route, pattern: Pattern | null, before?: TrackedVehicle): TrackedVehicle {
  const reported: LatLng = [raw.lat, raw.lng];
  const base = {
    id: raw.id,
    route,
    tripId: raw.tripId,
    pattern,
    speed: raw.speed,
    timestamp: raw.timestamp,
    headsign: pattern?.headsign ?? route.longName,
  };

  if (pattern) {
    // Search near where the vehicle was, so a loop's second pass is not
    // mistaken for its first. Fall back to the whole shape.
    const window = before?.distanceAlong != null ? [before.distanceAlong - 300, before.distanceAlong + 3000] : null;
    let projection = window
      ? projectOntoLine(reported, pattern.shape, pattern.distances, window[0], window[1])
      : projectOntoLine(reported, pattern.shape, pattern.distances);
    if (window && projection.offsetMeters > MAX_SNAP_METERS) {
      projection = projectOntoLine(reported, pattern.shape, pattern.distances);
    }

    if (projection.offsetMeters <= MAX_SNAP_METERS) {
      const along = pointAlongLine(pattern.shape, pattern.distances, projection.distanceAlong);
      return {
        ...base,
        distanceAlong: projection.distanceAlong,
        position: along.point,
        heading: raw.bearing ?? along.bearing,
      };
    }
  }

  return {
    ...base,
    distanceAlong: null,
    position: reported,
    heading: raw.bearing ?? before?.heading ?? 0,
  };
}

/**
 * Position between two fixes for animation, `t` in 0..1. Moves along the
 * shape when both fixes are on the same pattern and the vehicle went
 * forward a plausible distance; otherwise a straight line, or a jump when
 * the move is too big to animate honestly.
 */
export function interpolate(from: TrackedVehicle, to: TrackedVehicle, t: number): { position: LatLng; heading: number } {
  if (t >= 1) return { position: to.position, heading: to.heading };

  if (
    to.pattern &&
    from.pattern === to.pattern &&
    from.distanceAlong !== null &&
    to.distanceAlong !== null &&
    to.distanceAlong >= from.distanceAlong &&
    to.distanceAlong - from.distanceAlong < 2500
  ) {
    const distance = from.distanceAlong + (to.distanceAlong - from.distanceAlong) * t;
    const along = pointAlongLine(to.pattern.shape, to.pattern.distances, distance);
    return { position: along.point, heading: to.distanceAlong - from.distanceAlong > 5 ? along.bearing : to.heading };
  }

  if (haversineMeters(from.position, to.position) > 800) {
    return { position: to.position, heading: to.heading };
  }

  return {
    position: [
      from.position[0] + (to.position[0] - from.position[0]) * t,
      from.position[1] + (to.position[1] - from.position[1]) * t,
    ],
    heading: to.heading,
  };
}

/** The next stops a vehicle will reach, from its position along the pattern. */
export function upcomingStopIndex(vehicle: TrackedVehicle): number | null {
  if (!vehicle.pattern || vehicle.distanceAlong === null) return null;
  const index = vehicle.pattern.stopDistances.findIndex((distance) => distance >= vehicle.distanceAlong! - 15);
  return index === -1 ? null : index;
}
