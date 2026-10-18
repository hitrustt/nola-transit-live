import * as maplibregl from 'maplibre-gl';
import type { LngLatBoundsLike, Map as MapLibre, MapGeoJSONFeature, MapMouseEvent, PaddingOptions } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre resolves its worker relative to its own file at runtime, which a
// bundler cannot see. Hand it the bundled worker's URL explicitly.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { useRealtime, vehicleStore } from '../app/hooks.ts';
import { useLocation } from '../app/location.ts';
import { serverNow } from '../app/realtime.ts';
import { navigate, type View } from '../app/router.ts';
import type { Network } from '../lib/network.ts';
import { mainPattern } from '../lib/network.ts';
import { applyFocus, installLayers, LAYERS, type Palette } from './layers.ts';
import { VehicleMarkers } from './vehicleMarkers.ts';

maplibregl.setWorkerUrl(workerUrl);

const BASEMAPS = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
};

const PALETTES: Record<'light' | 'dark', Palette> = {
  light: { dark: false, surface: '#ffffff', ink: '#26302d', casing: '#ffffff', accent: '#1f4fa3' },
  dark: { dark: true, surface: '#17201d', ink: '#c9d4cf', casing: '#101715', accent: '#8fb2ff' },
};

/** Downtown and the river bend: what most visitors and riders are looking at. */
const HOME_CENTER: [number, number] = [-90.0745, 29.9555];

export interface MapHandle {
  zoomIn(): void;
  zoomOut(): void;
  showLocation(): void;
}

interface MapViewProps {
  network: Network;
  view: View;
  theme: 'light' | 'dark';
  padding: PaddingOptions;
  compact: boolean;
}

export const MapView = forwardRef<MapHandle, MapViewProps>(function MapView({ network, view, theme, padding, compact }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibre | null>(null);
  const markersRef = useRef<VehicleMarkers | null>(null);
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const followRef = useRef(false);
  /** The vehicle the camera has zoomed to, so a deep link zooms once data arrives. */
  const framedVehicleRef = useRef<string | null>(null);
  const [styleVersion, setStyleVersion] = useState(0);
  const realtime = useRealtime();
  const location = useLocation();
  const themeRef = useRef(theme);

  // --------------------------------------------------------------- create
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const [west, south, east, north] = network.bounds;
    const map = new maplibregl.Map({
      container,
      style: BASEMAPS[themeRef.current],
      center: HOME_CENTER,
      zoom: compact ? 11.6 : 12.6,
      minZoom: 9,
      maxZoom: 18.5,
      maxBounds: [
        [west - 0.25, south - 0.2],
        [east + 0.25, north + 0.2],
      ],
      // Added below, positioned so the phone sheet never covers it.
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      cooperativeGestures: false,
      fadeDuration: 150,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), compact ? 'top-left' : 'bottom-right');
    map.touchZoomRotate.disableRotation();

    // Below this zoom, vehicle numbers are unreadable clutter; CSS shows dots.
    const updateScale = () => {
      container.dataset.scale = map.getZoom() < 12.4 ? 'far' : 'near';
    };
    map.on('zoom', updateScale);
    updateScale();
    map.keyboard.disableRotation();
    map.getCanvas().setAttribute('aria-label', 'Map of routes, stops and vehicles');
    mapRef.current = map;
    map.setPadding(padding);

    // Compact attribution starts expanded; keep it to the (i) button until asked.
    map.once('load', () => container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'));

    map.on('style.load', () => {
      installLayers(map, network, PALETTES[themeRef.current], `${import.meta.env.BASE_URL}data/route-lines.json`);
      setStyleVersion((version) => version + 1);
    });

    // Clicks: stops first (they sit on top of lines), then route lines.
    const stopLayers = [LAYERS.selectedStop, LAYERS.focusStops, LAYERS.stops];
    const routeLayers = [LAYERS.focus, LAYERS.routes];
    const hit = (point: maplibregl.Point, layers: string[]): MapGeoJSONFeature | undefined => {
      const present = layers.filter((id) => map.getLayer(id));
      if (!present.length) return undefined;
      const box: [maplibregl.PointLike, maplibregl.PointLike] = [
        [point.x - 8, point.y - 8],
        [point.x + 8, point.y + 8],
      ];
      return map.queryRenderedFeatures(box, { layers: present })[0];
    };

    map.on('click', (event: MapMouseEvent) => {
      const stop = hit(event.point, stopLayers);
      if (stop?.properties.id) {
        navigate({ name: 'stop', stopId: String(stop.properties.id) });
        return;
      }
      const line = hit(event.point, routeLayers);
      if (line?.properties.route) {
        navigate({ name: 'route', routeId: String(line.properties.route), directionId: null });
      }
    });

    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: 'map-tip' });
    map.on('mousemove', (event: MapMouseEvent) => {
      const stop = hit(event.point, stopLayers);
      const line = stop ? undefined : hit(event.point, routeLayers);
      map.getCanvas().style.cursor = stop || line ? 'pointer' : '';

      if (stop) {
        popup.setLngLat(event.lngLat).setText(String(stop.properties.name)).addTo(map);
      } else if (line) {
        const route = network.routesById.get(String(line.properties.route));
        if (route) popup.setLngLat(event.lngLat).setText(`${route.shortName} ${route.longName}`).addTo(map);
      } else {
        popup.remove();
      }
    });
    map.on('mouseout', () => popup.remove());
    map.on('dragstart', () => {
      followRef.current = false;
    });

    markersRef.current = new VehicleMarkers(map, {
      onSelect: (vehicleId) => navigate({ name: 'vehicle', vehicleId }),
    });

    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container);

    return () => {
      resize.disconnect();
      markersRef.current?.destroy();
      map.remove();
      mapRef.current = null;
    };
    // The map is created once per network; theme and padding are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);

  // ---------------------------------------------------------------- theme
  useEffect(() => {
    const map = mapRef.current;
    if (!map || themeRef.current === theme) return;
    themeRef.current = theme;
    map.setStyle(BASEMAPS[theme], { diff: false });
  }, [theme]);

  // -------------------------------------------------------------- padding
  // Applied immediately, not animated: a camera move in the same render
  // (fitting a route) must see the final padding or it frames the wrong area.
  useEffect(() => {
    mapRef.current?.setPadding(padding);
  }, [padding.left, padding.bottom, padding.top, padding.right]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------- vehicles
  useEffect(() => {
    const unsubscribe = vehicleStore.subscribe(() => {
      markersRef.current?.update(vehicleStore.get().vehicles, serverNow());
      if (followRef.current && view.name === 'vehicle') followVehicle(view.vehicleId);
    });
    markersRef.current?.update(vehicleStore.get().vehicles, serverNow());
    const labels = setInterval(() => markersRef.current?.refreshLabels(serverNow()), 15_000);
    return () => {
      unsubscribe();
      clearInterval(labels);
    };
  }, [view]);

  function followVehicle(vehicleId: string) {
    const map = mapRef.current;
    const vehicle = vehicleStore.get().vehicles.get(vehicleId);
    if (!map || !vehicle) return;
    const first = framedVehicleRef.current !== vehicleId;
    framedVehicleRef.current = vehicleId;
    map.easeTo({
      center: [vehicle.position[1], vehicle.position[0]],
      ...(first ? { zoom: Math.max(14.5, map.getZoom()) } : {}),
      duration: first ? 700 : 1400,
    });
  }

  // ---------------------------------------------------------- focus/camera
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleVersion) return;

    const focusRouteId =
      view.name === 'route'
        ? view.routeId
        : view.name === 'vehicle'
          ? (vehicleStore.get().vehicles.get(view.vehicleId)?.route.id ?? null)
          : null;
    const route = focusRouteId ? network.routesById.get(focusRouteId) : undefined;
    const routeStops = route
      ? [...new Set(route.directions.flatMap((direction) => mainPattern(network, route, direction.id)?.stops ?? []))]
      : [];

    applyFocus(
      map,
      network,
      { routeId: route?.id ?? null, routeStops, stopId: view.name === 'stop' ? view.stopId : null },
      realtime.snapshot?.detours ?? [],
      PALETTES[themeRef.current],
    );
    markersRef.current?.setFocus(route?.id ?? null, view.name === 'vehicle' ? view.vehicleId : null);
  }, [view, styleVersion, network, realtime.snapshot?.detours]);

  // Camera moves only when the selection itself changes.
  const cameraKey =
    view.name === 'route' ? `route:${view.routeId}` : view.name === 'stop' ? `stop:${view.stopId}` : view.name === 'vehicle' ? `vehicle:${view.vehicleId}` : view.name;
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? { duration: 0 } : { duration: 700 };

    if (view.name === 'route') {
      const route = network.routesById.get(view.routeId);
      if (!route) return;
      const bounds = new maplibregl.LngLatBounds();
      route.patterns.forEach((id) => network.patternsById.get(id)?.shape.forEach(([lat, lng]) => bounds.extend([lng, lat])));
      // fitBounds adds this to the map's own padding (the panel), so only a margin is needed.
      if (!bounds.isEmpty()) map.fitBounds(bounds as LngLatBoundsLike, { padding: 48, maxZoom: 15, ...motion });
    } else if (view.name === 'stop') {
      const stop = network.stopsById.get(view.stopId);
      if (!stop) return;
      const visible = map.getBounds().contains([stop.lng, stop.lat]);
      if (!visible || map.getZoom() < 15) {
        map.easeTo({ center: [stop.lng, stop.lat], zoom: Math.max(15.5, map.getZoom()), ...motion });
      }
    } else if (view.name === 'vehicle') {
      followRef.current = true;
      const vehicle = vehicleStore.get().vehicles.get(view.vehicleId);
      if (vehicle) {
        framedVehicleRef.current = view.vehicleId;
        map.easeTo({ center: [vehicle.position[1], vehicle.position[0]], zoom: Math.max(14.5, map.getZoom()), ...motion });
      } else {
        framedVehicleRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraKey, network]);

  // ---------------------------------------------------------- user marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (location.status !== 'ready') {
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      return;
    }
    if (!userMarkerRef.current) {
      const element = document.createElement('div');
      element.className = 'user-location';
      element.setAttribute('role', 'img');
      element.setAttribute('aria-label', 'Your location');
      userMarkerRef.current = new maplibregl.Marker({ element }).setLngLat([location.position[1], location.position[0]]).addTo(map);
    } else {
      userMarkerRef.current.setLngLat([location.position[1], location.position[0]]);
    }
  }, [location]);

  useImperativeHandle(ref, () => ({
    zoomIn: () => mapRef.current?.zoomIn(),
    zoomOut: () => mapRef.current?.zoomOut(),
    showLocation: () => {
      if (location.status === 'ready') {
        mapRef.current?.easeTo({ center: [location.position[1], location.position[0]], zoom: Math.max(15, mapRef.current.getZoom()) });
      }
    },
  }));

  return <div ref={containerRef} className="map" />;
});
