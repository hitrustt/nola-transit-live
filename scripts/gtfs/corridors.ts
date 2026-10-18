/**
 * Route lines for the map, with parallel offsets where routes share a street.
 *
 * Canal Street carries six routes; drawn naively they stack into one line and
 * only the top colour is visible. Instead each route gets a slot in the stack
 * on every street it shares, and the map renders that slot with MapLibre's
 * GPU `line-offset`. The expensive part — working out who shares what — is
 * done here, once, at build time:
 *
 *   1. Every pattern is resampled every ~15 m.
 *   2. A sample "shares" a street with another route if that route has a
 *      sample within 12 m running parallel (either direction).
 *   3. The sharing set is smoothed along the line so a stray GPS-ish shape
 *      wobble does not split the stack for one sample.
 *   4. Consecutive samples with the same slot become one line feature.
 *
 * Line offsets are relative to the direction a line is drawn in, so two routes
 * drawn in opposite directions would land on opposite sides. Each run is
 * therefore given a sign from a canonical orientation, with hysteresis so the
 * sign does not flicker on streets that sit near the boundary angle.
 */

import { createLocalProjection } from '../../shared/geo.ts';
import type { LatLng } from '../../shared/polyline.ts';
import { simplifyMeters } from './simplify.ts';

const SAMPLE_SPACING_M = 15;
const SHARE_DISTANCE_M = 12;
const PARALLEL_TOLERANCE_DEG = 25;
const SMOOTHING_RADIUS = 3;
/** Runs shorter than this many samples (~75 m) merge into a neighbour. */
const MIN_RUN_SAMPLES = 5;
const CELL_SIZE_M = 30;
/** The canonical side flips only after the heading moves this far past 90°. */
const SIGN_HYSTERESIS_DEG = 25;

export interface CorridorInput {
  routeId: string;
  /** Lower draws first in a shared stack. */
  routeOrder: number;
  /** Patterns of the route, busiest first. */
  shapes: LatLng[][];
}

export interface RouteLineFeature {
  type: 'Feature';
  properties: { route: string; slot: number };
  geometry: { type: 'LineString'; coordinates: [number, number][] };
}

interface Sample {
  x: number;
  y: number;
  /** Direction of travel, degrees counter-clockwise from east, 0-360. */
  heading: number;
  route: number;
}

export function buildRouteLines(inputs: CorridorInput[]): RouteLineFeature[] {
  const allPoints = inputs.flatMap((input) => input.shapes.flat());
  const originLat = allPoints.reduce((sum, point) => sum + point[0], 0) / allPoints.length;
  const projection = createLocalProjection(originLat);

  // -- 1. Resample, dropping parts a route already covers in another pattern.
  const routeSamples: Sample[][][] = inputs.map((input, routeIndex) => {
    const covered = new SpatialIndex();
    const kept: Sample[][] = [];

    for (const shape of input.shapes) {
      const samples = resample(shape.map(projection.toXY), routeIndex);
      // Short flips either way are slivers where two patterns of the same
      // route diverge by a few metres; absorb them into their neighbours.
      const isCovered = absorbShortRuns(
        samples.map((sample) => (covered.hasParallel(sample, SHARE_DISTANCE_M, true) ? 1 : 0)),
        MIN_RUN_SAMPLES,
      );
      let run: Sample[] = [];

      samples.forEach((sample, position) => {
        if (isCovered[position]) {
          if (run.length > 1) kept.push(run);
          run = [];
        } else {
          run.push(sample);
        }
      });

      if (run.length > 1) kept.push(run);
      samples.forEach((sample) => covered.add(sample));
    }

    return kept;
  });

  // -- 2. Index everything for cross-route lookups.
  const index = new SpatialIndex();
  routeSamples.flat(2).forEach((sample) => index.add(sample));

  const features: RouteLineFeature[] = [];

  routeSamples.forEach((runs, routeIndex) => {
    for (const run of runs) {
      // Sharing set per sample, as a stable string key.
      const raw = run.map((sample) => {
        const routes = index.parallelRoutes(sample, SHARE_DISTANCE_M);
        routes.add(routeIndex);
        return [...routes].sort((a, b) => inputs[a]!.routeOrder - inputs[b]!.routeOrder);
      });

      // -- 3. Mode filter so single-sample blips do not split the stack.
      const keys = raw.map((set) => set.join(','));
      const smoothed = keys.map((_, position) => {
        const counts = new Map<string, number>();
        for (
          let k = Math.max(0, position - SMOOTHING_RADIUS);
          k <= Math.min(keys.length - 1, position + SMOOTHING_RADIUS);
          k += 1
        ) {
          counts.set(keys[k]!, (counts.get(keys[k]!) ?? 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      });

      // -- 4. Canonical side with hysteresis, folded into a signed slot.
      let sign = canonicalSign(run[0]!.heading);
      const slots = run.map((sample, position) => {
        sign = nextSign(sign, sample.heading);
        const members = smoothed[position]!.split(',').map(Number);
        const centred = members.indexOf(routeIndex) - (members.length - 1) / 2;
        // Encode as an integer number of half-slots so equality is exact.
        return Math.round(centred * sign * 2);
      });
      const merged = absorbShortRuns(slots, MIN_RUN_SAMPLES);

      // -- 5. Group into runs of constant slot.
      let start = 0;
      for (let position = 1; position <= run.length; position += 1) {
        if (position < run.length && merged[position] === merged[start]) continue;

        // Include the next sample so adjacent runs meet without a gap.
        const segment = run.slice(start, Math.min(position + 1, run.length));

        if (segment.length > 1) {
          const line = simplifyMeters(
            segment.map((sample) => projection.toLatLng([sample.x, sample.y])),
            1,
          );

          features.push({
            type: 'Feature',
            properties: {
              route: inputs[routeIndex]!.routeId,
              slot: merged[start]! / 2,
            },
            geometry: {
              type: 'LineString',
              coordinates: line.map(([lat, lng]) => [round(lng, 5), round(lat, 5)]),
            },
          });
        }

        start = position;
      }
    }
  });

  return features;
}

// ---------------------------------------------------------------------------

/**
 * Replace runs shorter than `minLength` with the value of their longer
 * neighbour, repeating until stable. Keeps a line from stuttering between
 * slots at junctions and bends.
 */
export function absorbShortRuns(values: number[], minLength: number): number[] {
  const result = [...values];

  for (let pass = 0; pass < 8; pass += 1) {
    const runs: { start: number; end: number; value: number }[] = [];
    for (let index = 0; index < result.length; index += 1) {
      const last = runs.at(-1);
      if (last && last.value === result[index]) last.end = index;
      else runs.push({ start: index, end: index, value: result[index]! });
    }

    let changed = false;
    runs.forEach((run, position) => {
      const length = run.end - run.start + 1;
      if (length >= minLength || runs.length === 1) return;

      const before = runs[position - 1];
      const after = runs[position + 1];
      const lengthOf = (other?: typeof run) => (other ? other.end - other.start + 1 : -1);
      const replacement = lengthOf(before) >= lengthOf(after) ? before : after;
      if (!replacement) return;

      for (let index = run.start; index <= run.end; index += 1) result[index] = replacement.value;
      run.value = replacement.value;
      changed = true;
    });

    if (!changed) break;
  }

  return result;
}

function resample(points: [number, number][], route: number): Sample[] {
  const samples: Sample[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const [x0, y0] = points[index]!;
    const [x1, y1] = points[index + 1]!;
    const length = Math.hypot(x1 - x0, y1 - y0);

    if (length === 0) continue;

    const heading = ((Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI + 360) % 360;
    const steps = Math.max(1, Math.ceil(length / SAMPLE_SPACING_M));

    for (let step = 0; step < steps; step += 1) {
      const t = step / steps;
      samples.push({ x: x0 + t * (x1 - x0), y: y0 + t * (y1 - y0), heading, route });
    }
  }

  const last = points.at(-1);
  if (last && samples.length) {
    samples.push({ x: last[0], y: last[1], heading: samples.at(-1)!.heading, route });
  }

  return samples;
}

/** +1 when heading roughly east/north-east, -1 when roughly west. */
function canonicalSign(heading: number): number {
  const fromEast = angularDistance(heading, 0);
  return fromEast <= 90 ? 1 : -1;
}

function nextSign(current: number, heading: number): number {
  const fromEast = angularDistance(heading, 0);

  if (current === 1 && fromEast > 90 + SIGN_HYSTERESIS_DEG) return -1;
  if (current === -1 && fromEast < 90 - SIGN_HYSTERESIS_DEG) return 1;
  return current;
}

function angularDistance(a: number, b: number): number {
  const difference = Math.abs(a - b) % 360;
  return difference > 180 ? 360 - difference : difference;
}

function isParallel(a: number, b: number): boolean {
  const difference = angularDistance(a, b);
  return difference <= PARALLEL_TOLERANCE_DEG || difference >= 180 - PARALLEL_TOLERANCE_DEG;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

class SpatialIndex {
  private cells = new Map<string, Sample[]>();

  private key(x: number, y: number): string {
    return `${Math.floor(x / CELL_SIZE_M)}:${Math.floor(y / CELL_SIZE_M)}`;
  }

  add(sample: Sample) {
    const key = this.key(sample.x, sample.y);
    const cell = this.cells.get(key);
    if (cell) cell.push(sample);
    else this.cells.set(key, [sample]);
  }

  private *near(sample: Sample, radius: number) {
    const cx = Math.floor(sample.x / CELL_SIZE_M);
    const cy = Math.floor(sample.y / CELL_SIZE_M);
    const reach = Math.ceil(radius / CELL_SIZE_M);

    for (let dx = -reach; dx <= reach; dx += 1) {
      for (let dy = -reach; dy <= reach; dy += 1) {
        for (const other of this.cells.get(`${cx + dx}:${cy + dy}`) ?? []) {
          if (Math.hypot(other.x - sample.x, other.y - sample.y) <= radius) {
            yield other;
          }
        }
      }
    }
  }

  hasParallel(sample: Sample, radius: number, sameRouteOnly: boolean): boolean {
    for (const other of this.near(sample, radius)) {
      if ((!sameRouteOnly || other.route === sample.route) && isParallel(other.heading, sample.heading)) {
        return true;
      }
    }
    return false;
  }

  parallelRoutes(sample: Sample, radius: number): Set<number> {
    const routes = new Set<number>();
    for (const other of this.near(sample, radius)) {
      if (other.route !== sample.route && isParallel(other.heading, sample.heading)) {
        routes.add(other.route);
      }
    }
    return routes;
  }
}
