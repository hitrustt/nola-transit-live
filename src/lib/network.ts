/**
 * In-memory index over network.json. Built once at startup; everything the
 * UI looks up per frame or per render is a Map hit from here.
 */

import { cumulativeDistances } from '../../shared/geo.ts';
import { decodePolyline, type LatLng } from '../../shared/polyline.ts';
import type {
  NetworkFile,
  PatternRecord,
  RouteRecord,
  ServiceRecord,
  StopRecord,
} from '../../shared/types.ts';

export interface Pattern extends Omit<PatternRecord, 'shape'> {
  shape: LatLng[];
  distances: Float64Array;
  route: Route;
}

export interface Route extends RouteRecord {
  /** Position in the canonical route order, for stable sorting. */
  order: number;
}

export type Stop = StopRecord;

export interface StopVisit {
  pattern: Pattern;
  /** Index of the stop in `pattern.stops`. */
  index: number;
}

export interface Network {
  feed: NetworkFile['feed'];
  agency: NetworkFile['agency'];
  bounds: NetworkFile['bounds'];
  routes: Route[];
  stops: Stop[];
  services: Record<string, ServiceRecord>;
  routesById: Map<string, Route>;
  stopsById: Map<string, Stop>;
  patternsById: Map<string, Pattern>;
  /** Every place a pattern calls at a stop, excluding where a trip only ends. */
  visitsByStop: Map<string, StopVisit[]>;
}

export function indexNetwork(file: NetworkFile): Network {
  const routes: Route[] = file.routes.map((route, order) => ({ ...route, order }));
  const routesById = new Map(routes.map((route) => [route.id, route]));
  const stopsById = new Map(file.stops.map((stop) => [stop.id, stop]));
  const patternsById = new Map<string, Pattern>();
  const visitsByStop = new Map<string, StopVisit[]>();

  for (const record of file.patterns) {
    const route = routesById.get(record.routeId);
    if (!route) continue;

    const shape = decodePolyline(record.shape);
    const pattern: Pattern = { ...record, shape, distances: cumulativeDistances(shape), route };
    patternsById.set(pattern.id, pattern);

    pattern.stops.forEach((stopId, index) => {
      // A trip's final stop is drop-off only; riders cannot board there, so
      // it is not a departure. Loops that end where they start keep index 0.
      if (index === pattern.stops.length - 1) return;
      let visits = visitsByStop.get(stopId);
      if (!visits) {
        visits = [];
        visitsByStop.set(stopId, visits);
      }
      visits.push({ pattern, index });
    });
  }

  return {
    feed: file.feed,
    agency: file.agency,
    bounds: file.bounds,
    routes,
    stops: file.stops,
    services: file.services,
    routesById,
    stopsById,
    patternsById,
    visitsByStop,
  };
}

/** Routes in display groups: streetcars and ferries are what visitors look for first. */
export function groupRoutesByMode(routes: Route[]): { mode: Route['mode']; label: string; routes: Route[] }[] {
  const groups = [
    { mode: 'streetcar' as const, label: 'Streetcars' },
    { mode: 'bus' as const, label: 'Buses' },
    { mode: 'ferry' as const, label: 'Ferries' },
  ];
  return groups
    .map((group) => ({ ...group, routes: routes.filter((route) => route.mode === group.mode) }))
    .filter((group) => group.routes.length);
}

/** The pattern to draw a route's stop diagram from, for a direction. */
export function mainPattern(network: Network, route: Route, directionId: number): Pattern | null {
  const direction = route.directions.find((entry) => entry.id === directionId) ?? route.directions[0];
  return direction ? (network.patternsById.get(direction.mainPattern) ?? null) : null;
}
