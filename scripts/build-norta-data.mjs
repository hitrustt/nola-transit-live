import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const gtfsDir = path.join(root, 'tmp-gtfs');
const outputPath = path.join(root, 'public', 'data', 'norta-network.json');

const FALLBACK_COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#84cc16',
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#0ea5e9',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
];

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function readCsv(fileName) {
  const text = fs.readFileSync(path.join(gtfsDir, fileName), 'utf8');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const routes = readCsv('routes.txt').filter(
  (route) => route.route_type === '3' && route.route_id !== '9999',
);
const trips = readCsv('trips.txt').filter((trip) =>
  routes.some((route) => route.route_id === trip.route_id),
);
const stops = readCsv('stops.txt').filter((stop) => stop.location_type !== '1');
const shapes = readCsv('shapes.txt');

const routeMap = new Map(routes.map((route) => [route.route_id, route]));
const stopMap = new Map(
  stops.map((stop) => [
    stop.stop_id,
    {
      id: stop.stop_id,
      code: stop.stop_code || stop.stop_id,
      name: stop.stop_name,
      lat: Number(stop.stop_lat),
      lng: Number(stop.stop_lon),
      routes: new Set(),
    },
  ]),
);

const tripMap = new Map();
const tripsByRoute = new Map();

for (const trip of trips) {
  tripMap.set(trip.trip_id, trip);

  if (!tripsByRoute.has(trip.route_id)) {
    tripsByRoute.set(trip.route_id, []);
  }

  tripsByRoute.get(trip.route_id).push(trip);
}

const shapesById = new Map();

for (const row of shapes) {
  if (!shapesById.has(row.shape_id)) {
    shapesById.set(row.shape_id, []);
  }

  shapesById.get(row.shape_id).push({
    lat: Number(row.shape_pt_lat),
    lng: Number(row.shape_pt_lon),
    sequence: Number(row.shape_pt_sequence),
  });
}

for (const points of shapesById.values()) {
  points.sort((left, right) => left.sequence - right.sequence);
}

const selectedShapeIdsByRoute = new Map();
const primaryTripIdsByRoute = new Map();

for (const route of routes) {
  const routeTrips = tripsByRoute.get(route.route_id) ?? [];
  const shapeCounts = new Map();

  for (const trip of routeTrips) {
    const key = `${trip.direction_id || '0'}:${trip.shape_id}`;
    shapeCounts.set(key, (shapeCounts.get(key) ?? 0) + 1);
  }

  const byDirection = new Map();

  for (const [key, count] of shapeCounts.entries()) {
    const [directionId, shapeId] = key.split(':');
    const current = byDirection.get(directionId);

    if (!current || count > current.count) {
      byDirection.set(directionId, { shapeId, count });
    }
  }

  const selectedShapes = [...byDirection.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, 2)
    .map((entry) => entry.shapeId)
    .filter((shapeId, index, array) => array.indexOf(shapeId) === index);

  if (selectedShapes.length) {
    selectedShapeIdsByRoute.set(route.route_id, selectedShapes);
    const primaryTrip = routeTrips.find((trip) => trip.shape_id === selectedShapes[0]);
    if (primaryTrip) {
      primaryTripIdsByRoute.set(route.route_id, primaryTrip.trip_id);
    }
  }
}

const routeStopSequences = new Map();

const stopTimesText = fs.readFileSync(path.join(gtfsDir, 'stop_times.txt'), 'utf8');
const stopTimeLines = stopTimesText.split(/\r?\n/).filter(Boolean);
const stopTimeHeaders = parseCsvLine(stopTimeLines[0]);
const stopTimeIndex = Object.fromEntries(
  stopTimeHeaders.map((header, index) => [header, index]),
);

for (const line of stopTimeLines.slice(1)) {
  const values = parseCsvLine(line);
  const tripId = values[stopTimeIndex.trip_id];
  const trip = tripMap.get(tripId);

  if (!trip) {
    continue;
  }

  const route = routeMap.get(trip.route_id);
  const stopId = values[stopTimeIndex.stop_id];
  const stop = stopMap.get(stopId);

  if (!route || !stop) {
    continue;
  }

  stop.routes.add(route.route_short_name);

  if (primaryTripIdsByRoute.get(route.route_id) !== tripId) {
    continue;
  }

  if (!routeStopSequences.has(route.route_id)) {
    routeStopSequences.set(route.route_id, []);
  }

  routeStopSequences.get(route.route_id).push({
    stopId,
    sequence: Number(values[stopTimeIndex.stop_sequence]),
  });
}

const routeRecords = routes
  .map((route, index) => {
    const selectedShapeIds = selectedShapeIdsByRoute.get(route.route_id) ?? [];
    const patterns = selectedShapeIds
      .map((shapeId) =>
        (shapesById.get(shapeId) ?? []).map((point) => [
          Number(point.lat.toFixed(6)),
          Number(point.lng.toFixed(6)),
        ]),
      )
      .filter((points) => points.length > 1);

    const orderedStops = (routeStopSequences.get(route.route_id) ?? [])
      .sort((left, right) => left.sequence - right.sequence)
      .map((entry) => entry.stopId)
      .filter((stopId, stopIndex, array) => array.indexOf(stopId) === stopIndex);

    if (!patterns.length || !orderedStops.length) {
      return null;
    }

    const color =
      route.route_color && route.route_color !== 'c8c8c8'
        ? `#${route.route_color}`
        : FALLBACK_COLORS[index % FALLBACK_COLORS.length];

    const terminals = [];
    const routeTrips = tripsByRoute.get(route.route_id) ?? [];

    for (const shapeId of selectedShapeIds) {
      const trip = routeTrips.find((candidate) => candidate.shape_id === shapeId);
      if (trip?.trip_headsign && !terminals.includes(trip.trip_headsign)) {
        terminals.push(trip.trip_headsign);
      }
    }

    return {
      id: route.route_id,
      shortName: route.route_short_name,
      longName: route.route_long_name,
      description: route.route_desc || route.route_long_name,
      color,
      routeType: route.route_type,
      terminals: terminals.slice(0, 2),
      patterns,
      stopIds: orderedStops,
    };
  })
  .filter(Boolean)
  .sort((left, right) => left.shortName.localeCompare(right.shortName, undefined, { numeric: true }));

const servedStopIds = new Set(routeRecords.flatMap((route) => route.stopIds));

const stopRecords = [...stopMap.values()]
  .filter((stop) => servedStopIds.has(stop.id))
  .map((stop) => ({
    id: stop.id,
    code: stop.code,
    name: stop.name,
    lat: stop.lat,
    lng: stop.lng,
    routes: [...stop.routes].sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    ),
  }))
  .sort((left, right) => left.name.localeCompare(right.name));

writeJson(outputPath, {
  generatedAt: new Date().toISOString(),
  routes: routeRecords,
  stops: stopRecords,
});

console.log(`Wrote ${routeRecords.length} routes and ${stopRecords.length} stops to ${outputPath}`);
