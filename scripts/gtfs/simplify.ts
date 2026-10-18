/**
 * Ramer–Douglas–Peucker simplification with the tolerance in metres.
 * Iterative, because NORTA patterns run to several thousand points.
 */

import { createLocalProjection } from '../../shared/geo.ts';
import type { LatLng } from '../../shared/polyline.ts';

export function simplifyMeters(points: LatLng[], toleranceMeters: number): LatLng[] {
  if (points.length < 3) {
    return points;
  }

  const projection = createLocalProjection(points[0]![0]);
  const xy = points.map(projection.toXY);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];

  while (stack.length) {
    const [first, last] = stack.pop()!;
    let maxDistance = 0;
    let maxIndex = -1;

    for (let index = first + 1; index < last; index += 1) {
      const distance = distanceToSegment(xy[index]!, xy[first]!, xy[last]!);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = index;
      }
    }

    if (maxIndex !== -1 && maxDistance > toleranceMeters) {
      keep[maxIndex] = 1;
      stack.push([first, maxIndex], [maxIndex, last]);
    }
  }

  return points.filter((_, index) => keep[index]);
}

function distanceToSegment(
  [px, py]: [number, number],
  [sx, sy]: [number, number],
  [ex, ey]: [number, number],
): number {
  const dx = ex - sx;
  const dy = ey - sy;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - sx) * dx + (py - sy) * dy) / lengthSquared));
  return Math.hypot(px - (sx + t * dx), py - (sy + t * dy));
}

/** Drop consecutive duplicate points, which GTFS shapes contain plenty of. */
export function dedupe(points: LatLng[]): LatLng[] {
  return points.filter(
    (point, index) =>
      index === 0 || point[0] !== points[index - 1]![0] || point[1] !== points[index - 1]![1],
  );
}
