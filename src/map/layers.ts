/**
 * MapLibre sources and layers for the transit network. Everything is added
 * through `installLayers`, which is idempotent and is called again after a
 * basemap style switch (light/dark), since setStyle drops custom layers.
 */

import type { FeatureCollection } from 'geojson';
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibre } from 'maplibre-gl';
import { decodePolyline } from '../../shared/polyline.ts';
import type { RealtimeDetour } from '../../shared/types.ts';
import { colorForDarkMap } from '../lib/color.ts';
import type { Network } from '../lib/network.ts';

export const SOURCES = {
  routes: 'nt-routes',
  stops: 'nt-stops',
  detours: 'nt-detours',
  focusStops: 'nt-focus-stops',
} as const;

export const LAYERS = {
  routeCasing: 'nt-route-casing',
  routes: 'nt-routes',
  focusCasing: 'nt-focus-casing',
  focus: 'nt-focus',
  detour: 'nt-detour',
  stops: 'nt-stops',
  focusStops: 'nt-focus-stops',
  selectedStop: 'nt-selected-stop',
} as const;

export interface Palette {
  dark: boolean;
  surface: string;
  ink: string;
  casing: string;
  accent: string;
}

/** Pixels between parallel lines, by zoom. Slots are in units of one line. */
const offset: ExpressionSpecification = [
  'interpolate',
  ['exponential', 1.5],
  ['zoom'],
  10,
  ['*', ['get', 'slot'], 1.2],
  13,
  ['*', ['get', 'slot'], 2.6],
  15,
  ['*', ['get', 'slot'], 4.2],
  18,
  ['*', ['get', 'slot'], 7.5],
];

/** Line width by zoom, plus `extra` pixels (zoom expressions must be top-level). */
function lineWidth(extra = 0): ExpressionSpecification {
  return ['interpolate', ['exponential', 1.5], ['zoom'], 10, 1.1 + extra, 13, 2.2 + extra, 15, 3.6 + extra, 18, 6.5 + extra];
}

export function lineColor(color: string, palette: Palette): string {
  return palette.dark ? colorForDarkMap(color) : color;
}

function colorByRoute(network: Network, palette: Palette): ExpressionSpecification {
  const pairs = network.routes.flatMap((route) => [route.id, lineColor(route.color, palette)]);
  return ['match', ['get', 'route'], ...pairs, '#777777'] as unknown as ExpressionSpecification;
}

export function installLayers(map: MapLibre, network: Network, palette: Palette, routeLinesUrl: string) {
  // Draw lines under the basemap's labels so street names stay readable.
  const firstLabel = map.getStyle().layers?.find((layer) => layer.type === 'symbol')?.id;

  if (!map.getSource(SOURCES.routes)) {
    map.addSource(SOURCES.routes, { type: 'geojson', data: routeLinesUrl, tolerance: 0.5 });
  }
  if (!map.getSource(SOURCES.stops)) {
    map.addSource(SOURCES.stops, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: network.stops.map((stop) => ({
          type: 'Feature',
          properties: { id: stop.id, name: stop.name, routes: stop.routes.length },
          geometry: { type: 'Point', coordinates: [stop.lng, stop.lat] },
        })),
      },
    });
  }
  if (!map.getSource(SOURCES.detours)) {
    map.addSource(SOURCES.detours, { type: 'geojson', data: emptyCollection() });
  }
  if (!map.getSource(SOURCES.focusStops)) {
    map.addSource(SOURCES.focusStops, { type: 'geojson', data: emptyCollection() });
  }

  const color = colorByRoute(network, palette);

  addLayer(map, {
    id: LAYERS.routeCasing,
    type: 'line',
    source: SOURCES.routes,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': palette.casing,
      'line-width': lineWidth(1.5),
      'line-offset': offset,
      'line-opacity': 0.9,
    },
  }, firstLabel);

  addLayer(map, {
    id: LAYERS.routes,
    type: 'line',
    source: SOURCES.routes,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': color, 'line-width': lineWidth(), 'line-offset': offset },
  }, firstLabel);

  // The selected route, drawn on top without offset so its stops sit on it.
  addLayer(map, {
    id: LAYERS.focusCasing,
    type: 'line',
    source: SOURCES.routes,
    filter: ['==', ['get', 'route'], ''],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': palette.surface, 'line-width': lineWidth(5) },
  });
  addLayer(map, {
    id: LAYERS.focus,
    type: 'line',
    source: SOURCES.routes,
    filter: ['==', ['get', 'route'], ''],
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': color, 'line-width': lineWidth(2) },
  });

  addLayer(map, {
    id: LAYERS.detour,
    type: 'line',
    source: SOURCES.detours,
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': lineWidth(1),
      'line-dasharray': [1.2, 1.2],
    },
  });

  addLayer(map, {
    id: LAYERS.stops,
    type: 'circle',
    source: SOURCES.stops,
    minzoom: 14.5,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14.5, 2.5, 17, 5.5],
      'circle-color': palette.surface,
      'circle-stroke-color': palette.ink,
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 14.5, 1, 17, 1.75],
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15, 1],
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15, 1],
    },
  });

  addLayer(map, {
    id: LAYERS.focusStops,
    type: 'circle',
    source: SOURCES.focusStops,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.2, 14, 4, 17, 6.5],
      'circle-color': palette.surface,
      'circle-stroke-color': ['get', 'color'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 15, 2.5],
    },
  });

  addLayer(map, {
    id: LAYERS.selectedStop,
    type: 'circle',
    source: SOURCES.stops,
    filter: ['==', ['get', 'id'], ''],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 6, 16, 10],
      'circle-color': palette.surface,
      'circle-stroke-color': palette.accent,
      'circle-stroke-width': 4,
    },
  });
}

function addLayer(map: MapLibre, layer: Parameters<MapLibre['addLayer']>[0], before?: string) {
  if (!map.getLayer(layer.id)) map.addLayer(layer, before && map.getLayer(before) ? before : undefined);
}

export function emptyCollection(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

export interface Focus {
  routeId: string | null;
  /** Stop ids to draw on the focused route. */
  routeStops: string[];
  stopId: string | null;
}

export function applyFocus(map: MapLibre, network: Network, focus: Focus, detours: RealtimeDetour[], palette: Palette) {
  if (!map.getLayer(LAYERS.routes)) return;

  const route = focus.routeId ? network.routesById.get(focus.routeId) : null;
  const routeFilter: ExpressionSpecification = ['==', ['get', 'route'], route?.id ?? ''];
  map.setFilter(LAYERS.focus, routeFilter);
  map.setFilter(LAYERS.focusCasing, routeFilter);
  map.setPaintProperty(LAYERS.routes, 'line-opacity', route ? 0.16 : 0.92);
  map.setPaintProperty(LAYERS.routeCasing, 'line-opacity', route ? 0.3 : 0.9);
  map.setFilter(LAYERS.selectedStop, ['==', ['get', 'id'], focus.stopId ?? '']);

  const stops = focus.routeStops
    .map((id) => network.stopsById.get(id))
    .filter((stop): stop is NonNullable<typeof stop> => Boolean(stop));
  (map.getSource(SOURCES.focusStops) as GeoJSONSource | undefined)?.setData({
    type: 'FeatureCollection',
    features: stops.map((stop) => ({
      type: 'Feature',
      properties: { id: stop.id, name: stop.name, color: route ? lineColor(route.color, palette) : '#555' },
      geometry: { type: 'Point', coordinates: [stop.lng, stop.lat] },
    })),
  });

  const shown = route ? detours.filter((detour) => detour.routeIds.includes(route.id) && detour.shape) : [];
  (map.getSource(SOURCES.detours) as GeoJSONSource | undefined)?.setData({
    type: 'FeatureCollection',
    features: shown.map((detour) => ({
      type: 'Feature',
      properties: { id: detour.id, color: lineColor(route!.color, palette) },
      geometry: { type: 'LineString', coordinates: decodePolyline(detour.shape!).map(([lat, lng]) => [lng, lat]) },
    })),
  });
}
