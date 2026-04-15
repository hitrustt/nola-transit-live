import { getRoutes } from './gtfs';

export const REALTIME_REFRESH_MS = 10000;

const REALTIME_MODE = import.meta.env.VITE_REALTIME_MODE ?? 'bustime';
const DEFAULT_DEMO_URL = `${import.meta.env.BASE_URL}data/vehicle-positions.json`;
const DEFAULT_BUSTIME_URL = import.meta.env.VITE_BUSTIME_URL ?? '/api/vehicles';

const routeIndexPromise = getRoutes().then((routes) => {
  return new Map(
    routes.map((route) => [
      route.id,
      {
        ...route,
        metrics: buildRouteMetrics(route.shape),
      },
    ]),
  );
});

function buildRouteMetrics(shape) {
  const segments = [];
  let totalDistance = 0;

  for (let index = 0; index < shape.length - 1; index += 1) {
    const start = shape[index];
    const end = shape[index + 1];
    const distance = Math.hypot(end[0] - start[0], end[1] - start[1]);

    segments.push({
      start,
      end,
      distance,
      startOffset: totalDistance,
      endOffset: totalDistance + distance,
    });

    totalDistance += distance;
  }

  return {
    segments,
    totalDistance,
  };
}

function interpolateAlongRoute(route, progress) {
  if (!route.metrics.totalDistance || !route.metrics.segments.length) {
    const [lat, lng] = route.shape[0] ?? [0, 0];
    return { lat, lng, bearing: 0 };
  }

  const normalizedProgress = ((progress % 1) + 1) % 1;
  const targetDistance = normalizedProgress * route.metrics.totalDistance;
  const segment =
    route.metrics.segments.find(
      (candidate) =>
        targetDistance >= candidate.startOffset && targetDistance <= candidate.endOffset,
    ) ?? route.metrics.segments.at(-1);

  const segmentDistance = segment.distance || 1;
  const segmentProgress = (targetDistance - segment.startOffset) / segmentDistance;
  const lat = segment.start[0] + (segment.end[0] - segment.start[0]) * segmentProgress;
  const lng = segment.start[1] + (segment.end[1] - segment.start[1]) * segmentProgress;
  const bearing =
    (Math.atan2(segment.end[1] - segment.start[1], segment.end[0] - segment.start[0]) * 180) /
    Math.PI;

  return { lat, lng, bearing };
}

function headingToBearing(heading) {
  const normalized = String(heading ?? '').trim().toUpperCase();
  const bearings = {
    N: 0,
    NE: 45,
    E: 90,
    SE: 135,
    S: 180,
    SW: 225,
    W: 270,
    NW: 315,
  };

  return bearings[normalized] ?? 0;
}

async function parseDemoPayload(payload, now = Date.now()) {
  const routeIndex = await routeIndexPromise;
  const entities = Array.isArray(payload?.entity) ? payload.entity : [];

  return entities
    .map((entity) => {
      const vehicle = entity?.vehicle;
      const routeId = vehicle?.trip?.route_id;
      const route = routeIndex.get(routeId);

      if (!vehicle || !route) {
        return null;
      }

      const rawPosition = vehicle.position ?? {};
      const headerTimestamp = Number(payload?.header?.timestamp ?? 0);
      const realtimeProgress =
        typeof rawPosition.progress === 'number'
          ? rawPosition.progress +
            (now / 1000 - headerTimestamp) * Number(rawPosition.progressRate ?? 0)
          : null;

      const derivedPosition =
        typeof rawPosition.latitude === 'number' && typeof rawPosition.longitude === 'number'
          ? {
              lat: rawPosition.latitude,
              lng: rawPosition.longitude,
              bearing: Number(rawPosition.bearing ?? 0),
            }
          : interpolateAlongRoute(route, realtimeProgress ?? 0);

      return {
        id: vehicle.vehicle?.id ?? entity.id,
        routeId,
        routeShortName: route.shortName,
        routeColor: route.color,
        routeLongName: route.longName,
        directionLabel: vehicle.trip?.direction_id ?? null,
        tripId: vehicle.trip?.trip_id ?? null,
        lat: derivedPosition.lat,
        lng: derivedPosition.lng,
        bearing: derivedPosition.bearing,
        timestamp: vehicle.timestamp ?? payload?.header?.timestamp ?? null,
      };
    })
    .filter(Boolean);
}

async function parseBustimeXml(xmlText) {
  const routeIndex = await routeIndexPromise;
  const document = new DOMParser().parseFromString(xmlText, 'text/xml');
  const buses = [...document.getElementsByTagName('bus')];

  return buses
    .map((bus) => {
      const routeId = bus.getElementsByTagName('rt')[0]?.textContent?.trim();
      const route = routeIndex.get(routeId);

      if (!route) {
        return null;
      }

      const vehicleId = bus.getElementsByTagName('id')[0]?.textContent?.trim();
      const lat = Number(bus.getElementsByTagName('lat')[0]?.textContent);
      const lng = Number(bus.getElementsByTagName('lon')[0]?.textContent);
      const direction = bus.getElementsByTagName('dn')[0]?.textContent?.trim();

      if (!vehicleId || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        return null;
      }

      return {
        id: vehicleId,
        routeId,
        routeShortName: route.shortName,
        routeColor: route.color,
        routeLongName: route.longName,
        directionLabel: direction ?? null,
        tripId: bus.getElementsByTagName('wid2')[0]?.textContent?.trim() ?? null,
        lat,
        lng,
        bearing: headingToBearing(direction),
        timestamp: Date.now(),
      };
    })
    .filter(Boolean);
}

export async function fetchVehiclePositions({
  mode = REALTIME_MODE,
  url = mode === 'bustime' ? DEFAULT_BUSTIME_URL : DEFAULT_DEMO_URL,
  signal,
  fetchImpl = window.fetch.bind(window),
} = {}) {
  const response = await fetchImpl(url, {
    signal,
    cache: 'no-store',
    headers:
      mode === 'bustime'
        ? {
            Accept: 'text/xml,application/xml,text/plain,*/*',
          }
        : {
            Accept: 'application/json',
          },
  });

  if (!response.ok) {
    throw new Error(`Realtime vehicle request failed with status ${response.status}`);
  }

  if (mode === 'bustime') {
    const payload = await response.text();
    return parseBustimeXml(payload);
  }

  const payload = await response.json();
  return parseDemoPayload(payload);
}
