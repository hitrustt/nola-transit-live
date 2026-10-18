/**
 * Geometry used by the build pipeline, the API and the browser. Everything is
 * [lat, lng] and metres. Nothing here touches the DOM or a map library.
 */

import type { LatLng } from './polyline.ts';

const EARTH_RADIUS_M = 6_371_008.8;
const RAD = Math.PI / 180;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = (b[0] - a[0]) * RAD;
  const dLng = (b[1] - a[1]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing in degrees, 0 = north, clockwise. */
export function bearingDegrees(from: LatLng, to: LatLng): number {
  const dLng = (to[1] - from[1]) * RAD;
  const latA = from[0] * RAD;
  const latB = to[0] * RAD;
  const y = Math.sin(dLng) * Math.cos(latB);
  const x = Math.cos(latA) * Math.sin(latB) - Math.sin(latA) * Math.cos(latB) * Math.cos(dLng);

  return ((Math.atan2(y, x) / RAD) + 360) % 360;
}

export function cumulativeDistances(points: readonly LatLng[]): Float64Array {
  const distances = new Float64Array(points.length);

  for (let index = 1; index < points.length; index += 1) {
    distances[index] = distances[index - 1]! + haversineMeters(points[index - 1]!, points[index]!);
  }

  return distances;
}

/**
 * A local equirectangular projection to metres. Over a metro area the size of
 * New Orleans the error is far below GPS noise, and it makes nearest-point
 * maths plain 2-D vector algebra.
 */
export function createLocalProjection(originLat: number) {
  const metersPerDegLat = 111_132.954 - 559.822 * Math.cos(2 * originLat * RAD);
  const metersPerDegLng = 111_412.84 * Math.cos(originLat * RAD);

  return {
    toXY: ([lat, lng]: LatLng): [number, number] => [lng * metersPerDegLng, lat * metersPerDegLat],
    toLatLng: ([x, y]: [number, number]): LatLng => [y / metersPerDegLat, x / metersPerDegLng],
  };
}

export interface Projection {
  /** Metres from the start of the line to the closest point. */
  distanceAlong: number;
  /** Metres between the input point and the line. */
  offsetMeters: number;
  /** Index of the segment the closest point lies on. */
  segment: number;
}

/**
 * Project a point onto a polyline.
 *
 * `fromDistance` / `toDistance` restrict the search to part of the line. That
 * matters for loops and out-and-back routes, where the same street is
 * travelled twice and the globally-nearest point can be on the wrong pass.
 */
export function projectOntoLine(
  point: LatLng,
  line: readonly LatLng[],
  distances: ArrayLike<number>,
  fromDistance = -Infinity,
  toDistance = Infinity,
): Projection {
  const lngScale = Math.cos(point[0] * RAD);
  let best: Projection = { distanceAlong: 0, offsetMeters: Infinity, segment: 0 };
  let bestSquared = Infinity;
  let bestT = 0;

  for (let index = 0; index < line.length - 1; index += 1) {
    const segmentStart = distances[index]!;
    const segmentEnd = distances[index + 1]!;

    if (segmentEnd < fromDistance || segmentStart > toDistance) {
      continue;
    }

    // Clamp to the part of this segment that lies inside the window.
    const span = segmentEnd - segmentStart;
    const tMin = span > 0 ? clamp((fromDistance - segmentStart) / span, 0, 1) : 0;
    const tMax = span > 0 ? clamp((toDistance - segmentStart) / span, 0, 1) : 1;

    const start = line[index]!;
    const end = line[index + 1]!;
    const dLat = end[0] - start[0];
    const dLng = (end[1] - start[1]) * lngScale;
    const lengthSquared = dLat * dLat + dLng * dLng;
    const t =
      lengthSquared === 0
        ? tMin
        : clamp(
            ((point[0] - start[0]) * dLat + (point[1] - start[1]) * lngScale * dLng) /
              lengthSquared,
            tMin,
            tMax,
          );

    const errorLat = point[0] - (start[0] + t * (end[0] - start[0]));
    const errorLng = (point[1] - (start[1] + t * (end[1] - start[1]))) * lngScale;
    const squared = errorLat * errorLat + errorLng * errorLng;

    if (squared < bestSquared) {
      bestSquared = squared;
      bestT = t;
      best = {
        distanceAlong: segmentStart + t * (segmentEnd - segmentStart),
        offsetMeters: 0,
        segment: index,
      };
    }
  }

  if (bestSquared === Infinity) {
    return best;
  }

  const start = line[best.segment]!;
  const end = line[best.segment + 1]!;
  best.offsetMeters = haversineMeters(point, [
    start[0] + bestT * (end[0] - start[0]),
    start[1] + bestT * (end[1] - start[1]),
  ]);

  return best;
}

/** Position and heading at a distance along a polyline. */
export function pointAlongLine(
  line: readonly LatLng[],
  distances: ArrayLike<number>,
  target: number,
): { point: LatLng; bearing: number } {
  const total = distances[distances.length - 1] ?? 0;
  const clamped = clamp(target, 0, total);
  let low = 0;
  let high = distances.length - 1;

  while (low < high - 1) {
    const middle = (low + high) >> 1;

    if (distances[middle]! <= clamped) {
      low = middle;
    } else {
      high = middle;
    }
  }

  const start = line[low]!;
  const end = line[high] ?? start;
  const span = distances[high]! - distances[low]! || 1;
  const t = (clamped - distances[low]!) / span;

  return {
    point: [start[0] + t * (end[0] - start[0]), start[1] + t * (end[1] - start[1])],
    bearing: bearingDegrees(start, end),
  };
}

/** The part of a polyline between two distances, inclusive of both ends. */
export function sliceLine(
  line: readonly LatLng[],
  distances: ArrayLike<number>,
  from: number,
  to: number,
): LatLng[] {
  if (to <= from) {
    return [];
  }

  const result: LatLng[] = [pointAlongLine(line, distances, from).point];

  for (let index = 0; index < line.length; index += 1) {
    const distance = distances[index]!;

    if (distance > from && distance < to) {
      result.push(line[index]!);
    }
  }

  result.push(pointAlongLine(line, distances, to).point);
  return result;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
