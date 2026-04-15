import { Fragment, memo, startTransition, useEffect, useMemo, useRef, useState } from 'react';
import {
  Circle,
  CircleMarker,
  MapContainer,
  Pane,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import L from 'leaflet';
import { getTransitFeed } from './services/gtfs';
import { fetchVehiclePositions, REALTIME_REFRESH_MS } from './services/realtime';

const DEFAULT_CENTER = [29.9511, -90.0715];
const BUS_ICON_URL = `${import.meta.env.BASE_URL}icons/bus-marker.png`;
const LIGHT_TILE_LAYER = {
  key: 'light',
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>',
  url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
};
const NIGHT_TILE_LAYER = {
  key: 'night',
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">CARTO</a>',
  url: 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png',
};

function MapViewport({ selectedRoutes, networkBounds, selectedStop }) {
  const map = useMap();

  useEffect(() => {
    const selectedRoutePoints = selectedRoutes.flatMap((route) => route.patterns.flat());

    if (selectedRoutePoints.length) {
      map.fitBounds(L.latLngBounds(selectedRoutePoints), {
        padding: [44, 44],
        maxZoom: 14,
      });
      return;
    }

    if (selectedStop) {
      map.flyTo([selectedStop.lat, selectedStop.lng], Math.max(map.getZoom(), 15), {
        duration: 0.5,
      });
      return;
    }

    if (networkBounds) {
      map.fitBounds(networkBounds, {
        padding: [36, 36],
      });
    }
  }, [map, networkBounds, selectedRoutes, selectedStop]);

  return null;
}

function UserLocationLayer({ userLocation, shouldCenterOnUser, onCentered }) {
  const map = useMap();

  useEffect(() => {
    if (!userLocation || !shouldCenterOnUser) {
      return;
    }

    map.flyTo([userLocation.lat, userLocation.lng], Math.max(map.getZoom(), 14), {
      duration: 0.45,
    });
    onCentered();
  }, [map, onCentered, shouldCenterOnUser, userLocation]);

  if (!userLocation) {
    return null;
  }

  return (
    <Pane name="user-location" style={{ zIndex: 680 }}>
      <Circle
        center={[userLocation.lat, userLocation.lng]}
        radius={Math.max(userLocation.accuracy ?? 20, 14)}
        pathOptions={{
          color: '#2563eb',
          fillColor: '#60a5fa',
          fillOpacity: 0.16,
          weight: 1,
          opacity: 0.45,
        }}
      />
      <CircleMarker
        center={[userLocation.lat, userLocation.lng]}
        radius={7}
        pathOptions={{
          color: '#ffffff',
          fillColor: '#2563eb',
          fillOpacity: 1,
          weight: 3,
        }}
      >
        <Popup>
          <div className="min-w-36">
            <div className="font-semibold">Your Location</div>
            <div className="text-xs text-slate-500">
              Accuracy {Math.round(userLocation.accuracy ?? 0)} m
            </div>
          </div>
        </Popup>
      </CircleMarker>
    </Pane>
  );
}

function compareRouteOrder(routeA, routeB) {
  return String(routeA.shortName ?? routeA.id).localeCompare(String(routeB.shortName ?? routeB.id), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function pointKey([lat, lng]) {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

function canonicalSegment(patternStart, patternEnd) {
  const startKey = pointKey(patternStart);
  const endKey = pointKey(patternEnd);

  if (startKey <= endKey) {
    return {
      key: `${startKey}|${endKey}`,
      start: patternStart,
      end: patternEnd,
    };
  }

  return {
    key: `${endKey}|${startKey}`,
    start: patternEnd,
    end: patternStart,
  };
}

function buildRouteRankMap(routes) {
  return new Map(
    [...routes]
      .sort(compareRouteOrder)
      .map((route, index) => [route.id, index]),
  );
}

function buildCorridorRouteMap(routes) {
  const corridorMap = new Map();
  const routeRankMap = buildRouteRankMap(routes);

  routes.forEach((route) => {
    route.patterns.forEach((pattern) => {
      for (let index = 0; index < pattern.length - 1; index += 1) {
        const corridor = canonicalSegment(pattern[index], pattern[index + 1]);

        if (!corridorMap.has(corridor.key)) {
          corridorMap.set(corridor.key, new Set());
        }

        corridorMap.get(corridor.key).add(route.id);
      }
    });
  });

  return new Map(
    [...corridorMap.entries()].map(([key, routeIds]) => [
      key,
      [...routeIds].sort((routeIdA, routeIdB) => routeRankMap.get(routeIdA) - routeRankMap.get(routeIdB)),
    ]),
  );
}

function projectLatLng(map, latlng, zoom) {
  return map.project(L.latLng(latlng[0], latlng[1]), zoom);
}

function offsetPoint(point, offset) {
  return L.point(point.x + offset.x, point.y + offset.y);
}

function getRouteOffsetSpacing(zoom) {
  if (zoom <= 12) {
    return 0;
  }

  if (zoom <= 13) {
    return 2.5;
  }

  if (zoom <= 14) {
    return 4;
  }

  return 6;
}

function corridorSpacingMultiplier(routeCount) {
  if (routeCount >= 6) {
    return 0.58;
  }

  if (routeCount >= 4) {
    return 0.72;
  }

  if (routeCount >= 3) {
    return 0.84;
  }

  return 1;
}

function hasMatchingDirection(startPoint, endPoint, canonicalStart, canonicalEnd) {
  const segmentDeltaLat = endPoint[0] - startPoint[0];
  const segmentDeltaLng = endPoint[1] - startPoint[1];
  const canonicalDeltaLat = canonicalEnd[0] - canonicalStart[0];
  const canonicalDeltaLng = canonicalEnd[1] - canonicalStart[1];

  return segmentDeltaLat * canonicalDeltaLat + segmentDeltaLng * canonicalDeltaLng >= 0;
}

function buildOffsetPattern(pattern, routeId, corridorRouteMap, map, zoom, offsetSpacing = 6) {
  if (pattern.length < 2) {
    return pattern;
  }

  if (!offsetSpacing) {
    return pattern;
  }

  const projectedPoints = pattern.map((point) => projectLatLng(map, point, zoom));
  const segmentOffsets = [];

  for (let index = 0; index < pattern.length - 1; index += 1) {
    const segmentStart = pattern[index];
    const segmentEnd = pattern[index + 1];
    const corridor = canonicalSegment(segmentStart, segmentEnd);
    const corridorRouteIds = corridorRouteMap.get(corridor.key) ?? [routeId];
    const routeIds = hasMatchingDirection(segmentStart, segmentEnd, corridor.start, corridor.end)
      ? corridorRouteIds
      : [...corridorRouteIds].reverse();
    const routeIndex = Math.max(routeIds.indexOf(routeId), 0);
    const spacing = offsetSpacing * corridorSpacingMultiplier(routeIds.length);
    const offsetAmount =
      routeIds.length > 1 ? (routeIndex - (routeIds.length - 1) / 2) * spacing : 0;
    const projectedStart = projectedPoints[index];
    const projectedEnd = projectedPoints[index + 1];
    const deltaX = projectedEnd.x - projectedStart.x;
    const deltaY = projectedEnd.y - projectedStart.y;
    const segmentLength = Math.hypot(deltaX, deltaY) || 1;

    segmentOffsets.push(
      L.point((-deltaY / segmentLength) * offsetAmount, (deltaX / segmentLength) * offsetAmount),
    );
  }

  const offsetProjectedPoints = projectedPoints.map((point, index) => {
    if (index === 0) {
      return offsetPoint(point, segmentOffsets[0]);
    }

    if (index === projectedPoints.length - 1) {
      return offsetPoint(point, segmentOffsets.at(-1));
    }

    const previousOffset = segmentOffsets[index - 1];
    const nextOffset = segmentOffsets[index];
    return offsetPoint(
      point,
      L.point((previousOffset.x + nextOffset.x) / 2, (previousOffset.y + nextOffset.y) / 2),
    );
  });

  return offsetProjectedPoints.map((point) => {
    const latLng = map.unproject(point, zoom);
    return [latLng.lat, latLng.lng];
  });
}

const RouteLayer = memo(function RouteLayer({
  routes,
  selectedRouteIds,
  highlightedRouteIds,
  onSelectRoute,
}) {
  const [hoveredRouteId, setHoveredRouteId] = useState(null);
  const map = useMap();
  const [zoom, setZoom] = useState(() => map.getZoom());

  useMapEvents({
    zoomend(event) {
      setZoom(event.target.getZoom());
    },
  });

  const corridorRouteMap = useMemo(() => buildCorridorRouteMap(routes), [routes]);
  const offsetPatterns = useMemo(() => {
    const offsetSpacing = getRouteOffsetSpacing(zoom);

    return new Map(
      routes.flatMap((route) =>
        route.patterns.map((pattern, patternIndex) => [
          `${route.id}-${patternIndex}`,
          buildOffsetPattern(pattern, route.id, corridorRouteMap, map, zoom, offsetSpacing),
        ]),
      ),
    );
  }, [corridorRouteMap, map, routes, zoom]);
  const orderedRoutes = useMemo(() => {
    const hasHighlights = highlightedRouteIds ?? new Set();

    return [...routes].sort((routeA, routeB) => {
      const score = (route) => {
        if (selectedRouteIds.has(route.id)) {
          return 2;
        }

        if (hasHighlights.has(route.id)) {
          return 1;
        }

        return 0;
      };

      return score(routeA) - score(routeB);
    });
  }, [highlightedRouteIds, routes, selectedRouteIds]);

  return (
    <Pane name="routes" style={{ zIndex: 410 }}>
      {orderedRoutes.map((route) => {
        const isActive = selectedRouteIds.has(route.id);
        const isHighlighted = highlightedRouteIds?.has(route.id) ?? false;
        const isHovered = hoveredRouteId === route.id;
        const hasSelection = Boolean(selectedRouteIds.size || highlightedRouteIds?.size);
        const outerOpacity = isActive
          ? 0.98
          : isHovered
            ? 0.94
            : isHighlighted
              ? 0.9
              : hasSelection
                ? 0.05
                : 0.62;
        const innerOpacity = isActive
          ? 1
          : isHovered
            ? 0.98
            : isHighlighted
              ? 0.9
              : hasSelection
                ? 0.08
                : 0.8;
        const outerWeight = isActive
          ? 8.8
          : isHovered
            ? 8.4
            : isHighlighted
              ? 7.4
              : hasSelection
                ? 2.6
                : 5.2;
        const innerWeight = isActive
          ? 5.8
          : isHovered
            ? 5.2
            : isHighlighted
              ? 4.8
              : hasSelection
                ? 1.5
                : 3;

        return (
          route.patterns.map((pattern, patternIndex) => (
            <Fragment key={`${route.id}-${patternIndex}`}>
              <Polyline
                positions={offsetPatterns.get(`${route.id}-${patternIndex}`) ?? pattern}
                pathOptions={{
                  color: '#ffffff',
                  weight: outerWeight,
                  opacity: outerOpacity,
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
              />
              <Polyline
                positions={offsetPatterns.get(`${route.id}-${patternIndex}`) ?? pattern}
                pathOptions={{
                  color: route.color,
                  weight: innerWeight,
                  opacity: innerOpacity,
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
                eventHandlers={{
                  click: () => onSelectRoute(route.id),
                  mouseover: () => setHoveredRouteId(route.id),
                  mouseout: () => {
                    setHoveredRouteId((current) => (current === route.id ? null : current));
                  },
                }}
              >
                <Tooltip sticky>{`${route.shortName} ${route.longName}`}</Tooltip>
              </Polyline>
            </Fragment>
          ))
        );
      })}
    </Pane>
  );
});

const StopLayer = memo(function StopLayer({
  stops,
  activeRouteStopIds,
  activeRouteColor,
  selectedStopId,
  onSelectStop,
  stopColorMap,
}) {
  const [zoom, setZoom] = useState(11);

  useMapEvents({
    zoomend(event) {
      setZoom(event.target.getZoom());
    },
  });

  return (
    <Pane name="stops" style={{ zIndex: 500 }}>
      {stops.map((stop) => {
        const isSelected = stop.id === selectedStopId;
        const isInFocus = activeRouteStopIds ? activeRouteStopIds.has(stop.id) : true;
        const hasSelection = Boolean(activeRouteStopIds);
        const baseColor = stopColorMap.get(stop.id) ?? '#475569';
        const markerColor = isInFocus && activeRouteColor ? activeRouteColor : baseColor;
        let radius;

        if (zoom <= 11) {
          radius = isSelected ? 4.4 : isInFocus ? 2.2 : 1.4;
        } else if (zoom <= 13) {
          radius = isSelected ? 5.2 : isInFocus ? 3 : 1.9;
        } else {
          radius = isSelected ? 6 : isInFocus ? 4 : 2.6;
        }

        return (
          <CircleMarker
            key={stop.id}
            center={[stop.lat, stop.lng]}
            radius={radius}
            pathOptions={{
              color: isSelected ? '#111827' : markerColor,
              fillColor: '#ffffff',
              fillOpacity: isSelected ? 0.98 : isInFocus ? 0.96 : hasSelection ? 0.28 : 0.94,
              weight: isSelected ? 2.5 : 2,
              opacity: isSelected ? 1 : hasSelection && !isInFocus ? 0.22 : 0.96,
            }}
            eventHandlers={{
              click: () => onSelectStop(stop.id),
            }}
          >
            <Popup>
              <div className="min-w-44">
                <div className="font-semibold">{stop.name}</div>
                <div className="text-xs text-slate-500">{stop.code}</div>
                <div className="mt-1 text-sm">Routes: {stop.routes.join(', ')}</div>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}
    </Pane>
  );
});

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function createVehicleIcon(vehicle, isEmphasized) {
  const rotation = Number.isFinite(vehicle.bearing) ? vehicle.bearing : 0;
  const routeColor = escapeHtml(vehicle.routeColor);

  return L.divIcon({
    className: 'vehicle-icon-shell',
    html: `
      <div class="vehicle-marker ${isEmphasized ? 'vehicle-marker--active' : 'vehicle-marker--dim'}" style="--vehicle-route:${routeColor}">
        <div class="vehicle-marker__direction" style="transform:rotate(${rotation}deg)">
          <div class="vehicle-marker__pointer-outline">
            <div class="vehicle-marker__pointer-fill"></div>
          </div>
        </div>
        <div class="vehicle-marker__body">
          <div class="vehicle-marker__bus-art" style="background-image:url('${escapeHtml(BUS_ICON_URL)}')"></div>
        </div>
      </div>
    `,
    iconSize: [38, 38],
    iconAnchor: [19, 19],
    popupAnchor: [0, -12],
  });
}

function VehicleLayer({ vehicles, activeRouteId, selectedVehicleId, onSelectVehicle }) {
  const map = useMap();
  const layerRef = useRef(null);
  const markersRef = useRef(new Map());
  const animationsRef = useRef(new Map());
  const frameRef = useRef(null);
  const targetPositionsRef = useRef(new Map());

  useEffect(() => {
    const layer = L.layerGroup().addTo(map);
    layerRef.current = layer;

    return () => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
      }

      markersRef.current.forEach(({ marker }) => marker.remove());
      markersRef.current.clear();
      animationsRef.current.clear();
      targetPositionsRef.current.clear();
      layer.remove();
      layerRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    if (!layerRef.current) {
      return undefined;
    }

    const nextIds = new Set(vehicles.map((vehicle) => vehicle.id));

    markersRef.current.forEach(({ marker }, vehicleId) => {
      if (nextIds.has(vehicleId)) {
        return;
      }

      marker.remove();
      markersRef.current.delete(vehicleId);
      animationsRef.current.delete(vehicleId);
      targetPositionsRef.current.delete(vehicleId);
    });

    vehicles.forEach((vehicle) => {
      const isEmphasized =
        selectedVehicleId === vehicle.id || !activeRouteId?.size || activeRouteId.has(vehicle.routeId);
      const existing = markersRef.current.get(vehicle.id);

      if (!existing) {
        const marker = L.marker([vehicle.lat, vehicle.lng], {
          icon: createVehicleIcon(vehicle, isEmphasized),
          pane: 'vehicles',
          keyboard: false,
        });

        marker.bindTooltip(`${vehicle.id} • ${vehicle.routeId}`, {
          direction: 'top',
          offset: [0, -14],
          opacity: 0.95,
        });
        marker.on('click', () => onSelectVehicle(vehicle.id));
        marker.addTo(layerRef.current);
        markersRef.current.set(vehicle.id, { marker, vehicle });
        targetPositionsRef.current.set(vehicle.id, [vehicle.lat, vehicle.lng]);
        return;
      }

      const currentLatLng = existing.marker.getLatLng();
      const previousTarget = targetPositionsRef.current.get(vehicle.id);
      const positionChanged =
        !previousTarget ||
        previousTarget[0] !== vehicle.lat ||
        previousTarget[1] !== vehicle.lng;
      const movementBearing = positionChanged
        ? getBearingFromPoints([currentLatLng.lat, currentLatLng.lng], [vehicle.lat, vehicle.lng])
        : null;
      const nextVehicle = {
        ...vehicle,
        bearing: movementBearing ?? existing.vehicle.bearing ?? vehicle.bearing,
      };

      if (positionChanged) {
        animationsRef.current.set(vehicle.id, {
          from: [currentLatLng.lat, currentLatLng.lng],
          to: [vehicle.lat, vehicle.lng],
          startTime: performance.now(),
          endTime: performance.now() + REALTIME_REFRESH_MS,
        });
        targetPositionsRef.current.set(vehicle.id, [vehicle.lat, vehicle.lng]);
      }

      existing.marker.setIcon(createVehicleIcon(nextVehicle, isEmphasized));
      existing.marker.setTooltipContent(`${nextVehicle.id} • ${nextVehicle.routeId}`);
      existing.vehicle = nextVehicle;
    });

    const animate = (now) => {
      if (!animationsRef.current.size) {
        frameRef.current = null;
        return;
      }

      animationsRef.current.forEach((animation, vehicleId) => {
        const markerEntry = markersRef.current.get(vehicleId);

        if (!markerEntry) {
          animationsRef.current.delete(vehicleId);
          return;
        }

        const duration = animation.endTime - animation.startTime || 1;
        const progress = Math.max(0, Math.min(1, (now - animation.startTime) / duration));
        const eased = progress * progress * (3 - 2 * progress);
        const nextLat = animation.from[0] + (animation.to[0] - animation.from[0]) * eased;
        const nextLng = animation.from[1] + (animation.to[1] - animation.from[1]) * eased;

        markerEntry.marker.setLatLng([nextLat, nextLng]);

        if (progress >= 1) {
          animationsRef.current.delete(vehicleId);
        }
      });

      frameRef.current = requestAnimationFrame(animate);
    };

    if (animationsRef.current.size && !frameRef.current) {
      frameRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (frameRef.current && !animationsRef.current.size) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [activeRouteId, onSelectVehicle, selectedVehicleId, vehicles]);

  return null;
}

function VehicleDetailPopup({ vehicle, nearestStop, isNightMode, onClose }) {
  useMapEvents({
    click() {
      onClose();
    },
  });

  if (!vehicle) {
    return null;
  }

  return (
    <Popup
      position={[vehicle.lat, vehicle.lng]}
      closeButton={false}
      autoPan={false}
      offset={[0, -22]}
      className={`vehicle-detail-popup-shell ${isNightMode ? 'vehicle-detail-popup-shell--night' : ''}`}
    >
      <div className="vehicle-detail-card">
        <div className="vehicle-detail-card__header">
          <div className="vehicle-detail-card__title-row">
            <span
              className="vehicle-detail-card__route-badge"
              style={{ backgroundColor: vehicle.routeColor }}
            >
              {vehicle.routeShortName ?? vehicle.routeId}
            </span>
            <div className="vehicle-detail-card__title">{vehicle.routeLongName}</div>
          </div>
          <button type="button" onClick={onClose} className="vehicle-detail-card__close">
            Close
          </button>
        </div>

        <div className="vehicle-detail-card__direction">
          {vehicle.directionLabel ? `Direction ${vehicle.directionLabel}` : 'Vehicle detail'}
        </div>

        <div className="vehicle-detail-card__grid">
          <div>
            <div className="vehicle-detail-card__label">Vehicle ID</div>
            <div className="vehicle-detail-card__value">{vehicle.id}</div>
          </div>
          <div>
            <div className="vehicle-detail-card__label">Status</div>
            <div className="vehicle-detail-card__value">{formatRelativeUpdate(vehicle.timestamp)}</div>
          </div>
          <div className="vehicle-detail-card__span">
            <div className="vehicle-detail-card__label">Nearest Stop</div>
            <div className="vehicle-detail-card__value">
              {nearestStop
                ? nearestStop.name
                : 'Unavailable'}
            </div>
          </div>
        </div>
      </div>
    </Popup>
  );
}

function getBearingFromPoints(from, to) {
  const latDelta = to[0] - from[0];
  const lngDelta = to[1] - from[1];

  if (Math.abs(latDelta) < 0.000001 && Math.abs(lngDelta) < 0.000001) {
    return null;
  }

  return (Math.atan2(lngDelta, latDelta) * 180) / Math.PI;
}

function formatRealtimeLabel(timestamp) {
  if (!timestamp) {
    return 'Waiting for first vehicle sync';
  }

  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function formatRelativeUpdate(timestamp) {
  if (!timestamp) {
    return 'Update time unavailable';
  }

  const numericTimestamp = Number(timestamp);
  const timestampMs = numericTimestamp > 10_000_000_000 ? numericTimestamp : numericTimestamp * 1000;
  const deltaSeconds = Math.max(0, Math.round((Date.now() - timestampMs) / 1000));

  if (deltaSeconds < 10) {
    return 'Updated just now';
  }

  if (deltaSeconds < 60) {
    return `Updated ${deltaSeconds}s ago`;
  }

  const deltaMinutes = Math.round(deltaSeconds / 60);
  return `Updated ${deltaMinutes}m ago`;
}

function distanceMeters(pointA, pointB) {
  const latDistance = (pointA[0] - pointB[0]) * 111320;
  const lngDistance =
    (pointA[1] - pointB[1]) * 111320 * Math.cos((((pointA[0] + pointB[0]) / 2) * Math.PI) / 180);

  return Math.hypot(latDistance, lngDistance);
}

function NightModeIcon({ isNightMode }) {
  if (isNightMode) {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 3v2.2M12 18.8V21M4.9 4.9l1.5 1.5M17.6 17.6l1.5 1.5M3 12h2.2M18.8 12H21M4.9 19.1l1.5-1.5M17.6 6.4l1.5-1.5" strokeLinecap="round" />
        <circle cx="12" cy="12" r="4.2" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor">
      <path d="M20.4 14.3A8.6 8.6 0 0 1 9.7 3.6a.8.8 0 0 0-1-.9 9.9 9.9 0 1 0 12.6 12.6.8.8 0 0 0-.9-1Z" />
    </svg>
  );
}

function LocateMeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 2.8v2.6M12 18.6v2.6M2.8 12h2.6M18.6 12h2.6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="5.2" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path
        d="M9.7 9.1a2.8 2.8 0 1 1 4.3 2.4c-.9.6-1.6 1.2-1.6 2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="17.6" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="8.2" />
    </svg>
  );
}

function SheetToggleIcon({ collapsed }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`h-5 w-5 transition-transform ${collapsed ? '' : 'rotate-180'}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EmptyStateCard({ title, message, isNightMode, compact = false }) {
  return (
    <div
      className={`border text-left ${
        compact ? 'px-3 py-3 text-sm' : 'px-4 py-5 text-sm'
      } ${isNightMode ? 'border-white/10 bg-[#211a27] text-white' : 'border-[#e8e0ec] bg-white text-slate-900'}`}
    >
      <div className="font-semibold">{title}</div>
      <div className={`mt-1 ${isNightMode ? 'text-white/80' : 'text-slate-500'}`}>{message}</div>
    </div>
  );
}

function App() {
  const [feed, setFeed] = useState({ routes: [], stops: [] });
  const [vehicles, setVehicles] = useState([]);
  const [selectedRouteIds, setSelectedRouteIds] = useState([]);
  const [selectedStopId, setSelectedStopId] = useState(null);
  const [selectedVehicleId, setSelectedVehicleId] = useState(null);
  const [isNightMode, setIsNightMode] = useState(false);
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [isMobileSheetCollapsed, setIsMobileSheetCollapsed] = useState(false);
  const [mobileTab, setMobileTab] = useState('routes');
  const [routeSearch, setRouteSearch] = useState('');
  const [stopSearch, setStopSearch] = useState('');
  const [userLocation, setUserLocation] = useState(null);
  const [locationState, setLocationState] = useState('idle');
  const [shouldCenterOnUser, setShouldCenterOnUser] = useState(false);
  const [realtimeState, setRealtimeState] = useState({
    error: null,
    lastUpdated: null,
  });
  const locationWatchIdRef = useRef(null);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 1023px)');
    const syncViewport = (event) => {
      setIsMobileViewport(event.matches);
    };

    setIsMobileViewport(mediaQuery.matches);
    mediaQuery.addEventListener('change', syncViewport);

    return () => {
      mediaQuery.removeEventListener('change', syncViewport);
    };
  }, []);

  useEffect(() => {
    if (!isMobileViewport) {
      setIsMobileSheetCollapsed(false);
    }
  }, [isMobileViewport]);

  useEffect(() => {
    let mounted = true;

    getTransitFeed().then((data) => {
      if (!mounted) {
        return;
      }

      setFeed(data);
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timeoutId = null;
    let activeController = null;

    const pollVehicles = async () => {
      activeController?.abort();
      activeController = new AbortController();

      try {
        const nextVehicles = await fetchVehiclePositions({
          signal: activeController.signal,
        });

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setVehicles(nextVehicles);
        });
        setRealtimeState({
          error: null,
          lastUpdated: Date.now(),
        });
      } catch (error) {
        if (cancelled || error.name === 'AbortError') {
          return;
        }

        setRealtimeState((current) => ({
          ...current,
          error: error.message,
        }));
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(pollVehicles, REALTIME_REFRESH_MS);
        }
      }
    };

    pollVehicles();

    return () => {
      cancelled = true;
      if (timeoutId) {
        window.clearTimeout(timeoutId);
      }
      activeController?.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (locationWatchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatchIdRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedVehicleId) {
      return;
    }

    if (!vehicles.some((vehicle) => vehicle.id === selectedVehicleId)) {
      setSelectedVehicleId(null);
    }
  }, [selectedVehicleId, vehicles]);

  const selectedRouteIdSet = useMemo(
    () => new Set(selectedRouteIds),
    [selectedRouteIds],
  );

  const selectedRoutes = useMemo(
    () => feed.routes.filter((route) => selectedRouteIdSet.has(route.id)),
    [feed.routes, selectedRouteIdSet],
  );

  const activeRouteStopIds = useMemo(
    () =>
      selectedRoutes.length
        ? new Set(selectedRoutes.flatMap((route) => route.stopIds))
        : null,
    [selectedRoutes],
  );

  const activeRouteStops = useMemo(() => {
    if (!activeRouteStopIds) {
      return [];
    }

    return feed.stops.filter((stop) => activeRouteStopIds.has(stop.id));
  }, [activeRouteStopIds, feed.stops]);

  const hubStops = useMemo(() => {
    const sharedStops = feed.stops.filter((stop) => stop.routes.length > 1);
    return (sharedStops.length ? sharedStops : feed.stops).slice(0, 24);
  }, [feed.stops]);

  const listedStops = selectedRoutes.length ? activeRouteStops : hubStops;
  const selectedRouteLabel =
    selectedRoutes.length === 1
      ? `${selectedRoutes[0].shortName} Stops`
      : selectedRoutes.length > 1
        ? 'Selected Route Stops'
        : 'Transfer Hubs';
  const normalizedRouteSearch = routeSearch.trim().toLowerCase();
  const normalizedStopSearch = stopSearch.trim().toLowerCase();

  const selectedStop = useMemo(
    () => feed.stops.find((stop) => stop.id === selectedStopId) ?? null,
    [feed.stops, selectedStopId],
  );
  const selectedStopRouteIds = useMemo(
    () => (selectedStop && !selectedRouteIds.length ? new Set(selectedStop.routes) : null),
    [selectedRouteIds.length, selectedStop],
  );

  const routeColorMap = useMemo(
    () => new Map(feed.routes.map((route) => [route.id, route.color])),
    [feed.routes],
  );

  const stopColorMap = useMemo(() => {
    return new Map(
      feed.stops.map((stop) => {
        const [primaryRouteId] = stop.routes;
        return [stop.id, routeColorMap.get(primaryRouteId) ?? '#475569'];
      }),
    );
  }, [feed.stops, routeColorMap]);

  const networkBounds = useMemo(() => {
    const allPoints = feed.routes.flatMap((route) => route.patterns.flat());

    if (!allPoints.length) {
      return null;
    }

    return L.latLngBounds(allPoints);
  }, [feed.routes]);

  const activeVehicles = useMemo(() => {
    if (!selectedRouteIds.length) {
      return vehicles;
    }

    return vehicles.filter((vehicle) => selectedRouteIdSet.has(vehicle.routeId));
  }, [selectedRouteIdSet, selectedRouteIds.length, vehicles]);
  const selectedVehicle = useMemo(
    () => vehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? null,
    [selectedVehicleId, vehicles],
  );
  const nearestStopToSelectedVehicle = useMemo(() => {
    if (!selectedVehicle || !feed.stops.length) {
      return null;
    }

    let nearestStop = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    feed.stops.forEach((stop) => {
      const nextDistance = distanceMeters(
        [selectedVehicle.lat, selectedVehicle.lng],
        [stop.lat, stop.lng],
      );

      if (nextDistance < nearestDistance) {
        nearestStop = stop;
        nearestDistance = nextDistance;
      }
    });

    if (!nearestStop) {
      return null;
    }

    return {
      ...nearestStop,
      distanceMeters: nearestDistance,
    };
  }, [feed.stops, selectedVehicle]);

  const filteredRoutes = useMemo(() => {
    if (!normalizedRouteSearch) {
      return feed.routes;
    }

    return feed.routes.filter((route) => {
      const searchable = [
        route.id,
        route.shortName,
        route.longName,
        ...(route.terminals ?? []),
      ]
        .join(' ')
        .toLowerCase();

      return searchable.includes(normalizedRouteSearch);
    });
  }, [feed.routes, normalizedRouteSearch]);

  const filteredStops = useMemo(() => {
    if (!normalizedStopSearch) {
      return listedStops;
    }

    return listedStops.filter((stop) => {
      const searchable = [stop.name, stop.code, ...stop.routes].join(' ').toLowerCase();
      return searchable.includes(normalizedStopSearch);
    });
  }, [listedStops, normalizedStopSearch]);
  const visibleStops = useMemo(
    () => filteredStops.filter((stop) => stop.id !== selectedStopId),
    [filteredStops, selectedStopId],
  );
  const routeEmptyState = useMemo(() => {
    if (filteredRoutes.length) {
      return null;
    }

    if (normalizedRouteSearch) {
      return {
        title: 'No matching routes',
        message: 'Try a route number, terminal, or a shorter search term.',
      };
    }

    return {
      title: 'No routes loaded',
      message: 'The route list is unavailable right now.',
    };
  }, [filteredRoutes.length, normalizedRouteSearch]);
  const stopEmptyState = useMemo(() => {
    if (visibleStops.length) {
      return null;
    }

    if (normalizedStopSearch) {
      return {
        title: selectedRoutes.length ? 'No matching stops' : 'No matching transfer hubs',
        message: 'Try a stop name, stop code, or a shorter search term.',
      };
    }

    if (selectedRoutes.length) {
      return {
        title: 'No stops in view',
        message: 'Select a different route set or return to system view.',
      };
    }

    return {
      title: 'No transfer hubs loaded',
      message: 'Transfer hub data is unavailable right now.',
    };
  }, [normalizedStopSearch, selectedRoutes.length, visibleStops.length]);
  const locationMessage =
    locationState === 'denied'
      ? 'Location blocked'
      : locationState === 'unsupported'
        ? 'Location unavailable'
        : null;
  const selectedRoutesVehicleMessage =
    selectedRoutes.length && !activeVehicles.length && !realtimeState.error
      ? 'No active buses on selected routes'
      : null;

  const tileLayer = isNightMode ? NIGHT_TILE_LAYER : LIGHT_TILE_LAYER;

  const handleRouteSelection = (routeId) => {
    if (routeId === null) {
      setSelectedRouteIds([]);
      setSelectedStopId(null);
      return;
    }

    setSelectedRouteIds((current) => {
      const exists = current.includes(routeId);
      const next = exists ? current.filter((id) => id !== routeId) : [...current, routeId];

      if (!next.length) {
        setSelectedStopId(null);
      }

      return next;
    });
  };

  const clearSelections = () => {
    setSelectedRouteIds([]);
    setSelectedStopId(null);
  };

  const requestUserLocation = () => {
    if (!navigator.geolocation) {
      setLocationState('unsupported');
      return;
    }

    setLocationState('loading');

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setUserLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
        setLocationState('ready');
        setShouldCenterOnUser(true);

        if (locationWatchIdRef.current === null) {
          locationWatchIdRef.current = navigator.geolocation.watchPosition(
            (watchPosition) => {
              setUserLocation({
                lat: watchPosition.coords.latitude,
                lng: watchPosition.coords.longitude,
                accuracy: watchPosition.coords.accuracy,
              });
            },
            () => {},
            {
              enableHighAccuracy: true,
              maximumAge: 15000,
              timeout: 20000,
            },
          );
        }
      },
      () => {
        setLocationState('denied');
      },
      {
        enableHighAccuracy: true,
        maximumAge: 15000,
        timeout: 12000,
      },
    );
  };

  const handleStopSelection = (stopId) => {
    setSelectedStopId((current) => (current === stopId ? null : stopId));
  };

  return (
    <div
      className={`h-[100dvh] w-screen overflow-hidden ${
        isNightMode ? 'bg-[#151118] text-slate-100' : 'bg-[#ece9e3] text-slate-900'
      }`}
    >
      <div className="relative flex h-full min-h-0 flex-col lg:flex-row">
        <aside
          className={`z-[1000] hidden shrink-0 flex-col overflow-hidden border-b px-4 py-4 lg:flex lg:h-full lg:w-[27rem] lg:border-b-0 lg:border-r ${
            isNightMode
              ? 'border-white/10 bg-[#211a27] shadow-[0_18px_50px_rgba(0,0,0,0.32)]'
              : 'border-[#d8cfde] bg-[#f8f4fa] shadow-[0_18px_50px_rgba(35,18,44,0.12)]'
          }`}
        >
          {!isNightMode ? (
            <div className="mb-4 flex h-2 overflow-hidden border border-white/10">
              <div className="flex-1 bg-[#722c88]" />
              <div className="flex-1 bg-[#f0bf55]" />
              <div className="flex-1 bg-[#2c7a46]" />
            </div>
          ) : null}

          <div className={`mb-4 border-l-4 pl-3 ${isNightMode ? 'border-[#8f4aa7]' : 'border-[#722c88]'}`}>
            <h1 className={`font-heading mt-1 text-[1.85rem] leading-none ${isNightMode ? 'text-white' : 'text-[#5b2171]'}`}>
              New Orleans RTA Live Map
            </h1>
            <p className={`mt-2 max-w-sm text-sm leading-5 ${isNightMode ? 'text-white' : 'text-slate-600'}`}>
              Live routes, transfer points, and active vehicles across the network.
            </p>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-2 text-sm">
            <div
              className={`border p-3 ${
                isNightMode ? 'border-white/10 bg-[#2b2232]' : 'border-[#d7cedd] bg-white'
              }`}
            >
              <div className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${isNightMode ? 'text-white' : 'text-[#7b5b89]'}`}>
                Routes
              </div>
              <div className={`font-heading mt-1 text-3xl leading-none ${isNightMode ? 'text-white' : 'text-[#4f255f]'}`}>
                {feed.routes.length}
              </div>
            </div>
            <div
              className={`border p-3 ${
                isNightMode ? 'border-white/10 bg-[#2b2232]' : 'border-[#d7cedd] bg-white'
              }`}
            >
              <div className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${isNightMode ? 'text-white' : 'text-[#7b5b89]'}`}>
                Vehicles
              </div>
              <div className={`font-heading mt-1 text-3xl leading-none ${isNightMode ? 'text-white' : 'text-[#4f255f]'}`}>
                {vehicles.length}
              </div>
            </div>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handleRouteSelection(null)}
              className={`border px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] transition ${
                selectedRoutes.length
                  ? isNightMode
                    ? 'border-white/10 bg-[#2b2232] text-white hover:border-[#b77ccc]'
                    : 'border-[#d7cedd] bg-white text-[#4f255f] hover:border-[#722c88]'
                  : 'border-[#2c7a46] bg-[#2c7a46] text-white'
              }`}
            >
              System View
            </button>
            <button
              type="button"
              onClick={clearSelections}
              className={`border px-4 py-2 text-xs font-semibold uppercase tracking-[0.08em] transition ${
                isNightMode
                  ? 'border-white/10 bg-[#2b2232] text-white hover:border-[#b77ccc]'
                  : 'border-[#d7cedd] bg-white text-[#4f255f] hover:border-[#722c88]'
              }`}
            >
              Clear All
            </button>
          </div>

          {realtimeState.error ? (
            <div className={`mb-4 border px-4 py-3 text-sm ${
              isNightMode
                ? 'border-rose-400/40 bg-rose-950/30 text-rose-100'
                : 'border-rose-300 bg-rose-50 text-rose-700'
            }`}>
              {realtimeState.error}
            </div>
          ) : null}

          <section
            className={`mb-3 border ${
              isNightMode ? 'border-white/10 bg-[#261f2d]' : 'border-[#d7cedd] bg-white'
            }`}
          >
            <div className={`border-b px-4 py-3 ${isNightMode ? 'border-white/10' : 'border-[#e8e0ec]'}`}>
              <h2 className={`font-heading text-[1.15rem] leading-none ${isNightMode ? 'text-white' : 'text-[#722c88]'}`}>Routes</h2>
            </div>
            <div className="px-4 py-3">
              <input
                type="search"
                value={routeSearch}
                onChange={(event) => setRouteSearch(event.target.value)}
                placeholder="Search routes"
                className={`w-full border px-3 py-2 text-sm outline-none transition ${
                  isNightMode
                    ? 'border-white/10 bg-[#17121d] text-white placeholder:text-white/70 focus:border-[#b77ccc]'
                    : 'border-[#d7cedd] bg-white text-slate-900 placeholder:text-slate-400 focus:border-[#722c88]'
                }`}
              />
            </div>
            <div className="panel-scrollbar max-h-[28vh] space-y-1 overflow-y-auto px-2 pb-2 lg:max-h-[30vh]">
              {routeEmptyState ? (
                <EmptyStateCard
                  title={routeEmptyState.title}
                  message={routeEmptyState.message}
                  isNightMode={isNightMode}
                />
              ) : filteredRoutes.map((route) => {
                const isActive = selectedRouteIdSet.has(route.id);

                return (
                  <button
                    key={route.id}
                    type="button"
                    onClick={() => handleRouteSelection(route.id)}
                    className={`w-full border px-3 py-3 text-left transition ${
                      isActive
                        ? isNightMode
                          ? 'border-[#b77ccc] bg-[#3a3042]'
                          : 'border-[#722c88] bg-[#efe6f4]'
                        : isNightMode
                          ? 'border-white/10 bg-[#211a27] hover:border-[#b77ccc] hover:bg-[#2e2535]'
                          : 'border-[#e8e0ec] bg-white hover:border-[#b894c5] hover:bg-[#f8f4fb]'
                    }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-3">
                          <div
                            className="flex h-9 w-9 shrink-0 items-center justify-center border border-black/10 text-sm font-black text-slate-900"
                            style={{ backgroundColor: route.color }}
                          >
                            {route.shortName}
                          </div>
                          <div className="min-w-0">
                            <div className={`truncate font-semibold ${isNightMode ? 'text-white' : 'text-slate-900'}`}>
                              {route.longName}
                            </div>
                            <div className={`truncate text-sm ${isNightMode ? 'text-white' : 'text-slate-500'}`}>
                              {route.terminals.join(' to ')}
                            </div>
                          </div>
                        </div>
                      </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section
            className={`min-h-0 flex flex-1 flex-col border ${
              isNightMode ? 'border-white/10 bg-[#261f2d]' : 'border-[#d7cedd] bg-white'
            }`}
          >
            <div className={`border-b px-4 py-3 ${isNightMode ? 'border-white/10' : 'border-[#e8e0ec]'}`}>
              <h2 className={`font-heading text-[1.15rem] leading-none ${isNightMode ? 'text-white' : 'text-[#722c88]'}`}>
                {selectedRouteLabel}
              </h2>
            </div>
            <div className="px-4 py-3">
              <input
                type="search"
                value={stopSearch}
                onChange={(event) => setStopSearch(event.target.value)}
                placeholder={selectedRoutes.length ? 'Search stops' : 'Search transfer hubs'}
                className={`w-full border px-3 py-2 text-sm outline-none transition ${
                  isNightMode
                    ? 'border-white/10 bg-[#17121d] text-white placeholder:text-white/70 focus:border-[#b77ccc]'
                    : 'border-[#d7cedd] bg-white text-slate-900 placeholder:text-slate-400 focus:border-[#722c88]'
                }`}
              />
            </div>
            {selectedStop ? (
              <div
                className={`mx-4 mb-3 border px-4 py-3 ${
                  isNightMode
                    ? 'border-[#b77ccc]/50 bg-[#312737]'
                    : 'border-[#d9c7e0] bg-[#f4eaf8]'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className={`truncate font-semibold ${isNightMode ? 'text-white' : 'text-slate-900'}`}>
                      {selectedStop.name}
                    </div>
                    <div
                      className={`mt-1 text-xs font-medium uppercase tracking-[0.08em] ${
                        isNightMode ? 'text-white' : 'text-slate-500'
                      }`}
                    >
                      Stop {selectedStop.code}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedStopId(null)}
                    className={`border px-3 py-1 text-xs font-semibold uppercase tracking-[0.06em] ${
                      isNightMode
                        ? 'border-white/10 bg-[#211a27] text-white'
                        : 'border-[#d7cedd] bg-white text-[#4f255f]'
                    }`}
                  >
                    Clear
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {selectedStop.routes.map((routeId) => {
                    const routeColor = routeColorMap.get(routeId) ?? '#722c88';

                    return (
                      <span
                        key={routeId}
                        className="inline-flex items-center px-2.5 py-1 text-xs font-semibold text-white"
                        style={{ backgroundColor: routeColor }}
                      >
                        {routeId}
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <div className="panel-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-2">
              {stopEmptyState ? (
                <EmptyStateCard
                  title={stopEmptyState.title}
                  message={stopEmptyState.message}
                  isNightMode={isNightMode}
                />
              ) : visibleStops.map((stop) => {
                const isSelected = stop.id === selectedStopId;

                return (
                  <button
                    key={stop.id}
                    type="button"
                    onClick={() => handleStopSelection(stop.id)}
                    className={`w-full border px-3 py-3 text-left transition ${
                      isSelected
                        ? isNightMode
                          ? 'border-[#b77ccc] bg-[#3a3042]'
                          : 'border-[#722c88] bg-[#efe6f4]'
                        : isNightMode
                          ? 'border-white/10 bg-[#211a27] hover:border-[#b77ccc] hover:bg-[#2e2535]'
                          : 'border-[#e8e0ec] bg-white hover:border-[#b894c5] hover:bg-[#f8f4fb]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className={`truncate font-semibold ${isNightMode ? 'text-white' : 'text-slate-900'}`}>
                          {stop.name}
                        </div>
                        <div
                          className={`mt-1 text-xs font-medium uppercase tracking-[0.08em] ${
                            isNightMode ? 'text-white' : 'text-slate-500'
                          }`}
                        >
                          {stop.code}
                        </div>
                      </div>
                      <div
                        className={`text-right text-xs leading-4 ${
                          isNightMode ? 'text-white' : 'text-slate-500'
                        }`}
                      >
                        {stop.routes.join(' • ')}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

        </aside>

        <main className="relative h-full min-h-0 flex-1">
          <MapContainer
            center={DEFAULT_CENTER}
            zoom={11}
            minZoom={10}
            preferCanvas
            scrollWheelZoom
            zoomControl={!isMobileViewport}
            className="h-full w-full"
          >
            <TileLayer key={tileLayer.key} attribution={tileLayer.attribution} url={tileLayer.url} />

            <RouteLayer
              routes={feed.routes}
              selectedRouteIds={selectedRouteIdSet}
              highlightedRouteIds={selectedStopRouteIds}
              onSelectRoute={handleRouteSelection}
            />
            <StopLayer
              stops={feed.stops}
              activeRouteStopIds={activeRouteStopIds}
              activeRouteColor={selectedRoutes.length === 1 ? selectedRoutes[0].color : null}
              selectedStopId={selectedStopId}
              onSelectStop={handleStopSelection}
              stopColorMap={stopColorMap}
            />
            <Pane name="vehicles" style={{ zIndex: 650 }} />
            <VehicleLayer
              vehicles={vehicles}
              activeRouteId={selectedRouteIdSet}
              selectedVehicleId={selectedVehicleId}
              onSelectVehicle={setSelectedVehicleId}
            />
            <UserLocationLayer
              userLocation={userLocation}
              shouldCenterOnUser={shouldCenterOnUser}
              onCentered={() => setShouldCenterOnUser(false)}
            />
            <VehicleDetailPopup
              vehicle={selectedVehicle}
              nearestStop={nearestStopToSelectedVehicle}
              isNightMode={isNightMode}
              onClose={() => setSelectedVehicleId(null)}
            />
            <MapViewport
              selectedRoutes={selectedRoutes}
              networkBounds={networkBounds}
              selectedStop={selectedStop}
            />
          </MapContainer>

          <div className="absolute left-[4.75rem] top-4 right-4 z-[1000] hidden lg:block">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap gap-2">
                <div
                  className={`border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] shadow-lg ${
                    isNightMode
                      ? 'border-white/10 bg-[#1d1821] text-white'
                      : 'border-[#d6d0c6] bg-white text-slate-700'
                  }`}
                >
                  {realtimeState.error ? 'Realtime unavailable' : `Updated ${formatRealtimeLabel(realtimeState.lastUpdated)}`}
                </div>
                <div
                  className={`border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] shadow-lg ${
                    isNightMode
                      ? 'border-white/10 bg-[#1d1821] text-white'
                      : 'border-[#d6d0c6] bg-white text-slate-700'
                  }`}
                >
                  {selectedRoutesVehicleMessage ?? `${activeVehicles.length} vehicles visible`}
                </div>
              </div>

              {selectedRoutes.length ? (
                <div
                  className={`flex flex-wrap gap-2 border px-3 py-3 shadow-lg ${
                    isNightMode
                      ? 'border-white/10 bg-[#1d1821]'
                      : 'border-[#d6d0c6] bg-white'
                  }`}
                >
                  {selectedRoutes.map((route) => (
                    <button
                      key={route.id}
                      type="button"
                      onClick={() => handleRouteSelection(route.id)}
                      className="inline-flex items-center gap-2 border border-black/10 px-2.5 py-1 text-xs font-semibold text-slate-900"
                      style={{ backgroundColor: route.color }}
                    >
                      <span>{route.shortName}</span>
                      <span className="bg-white/80 px-1.5 py-0.5 text-[10px] leading-none">
                        ×
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

            </div>
          </div>

          <div className="pointer-events-none absolute bottom-4 left-4 z-[1000] hidden md:block">
            <div
              className={`border px-4 py-3 text-sm shadow-lg ${
                isNightMode
                  ? 'border-white/10 bg-[#1d1821] text-slate-200'
                  : 'border-[#d6d0c6] bg-white text-slate-700'
              }`}
            >
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#722c88]">
                Map Legend
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="h-[3px] w-8 rounded-full bg-[#722c88]" />
                  <span>Route lines</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full bg-[#722c88]" />
                  <span>Stops</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full border-2 border-white bg-[#facc15]" />
                  <span>Selected stop</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-5 w-5 rounded-full border-2 border-white bg-[#722c88]" />
                  <span>Buses</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="h-3 w-3 rounded-full border-2 border-white bg-[#2563eb]" />
                  <span>Your location</span>
                </div>
              </div>
            </div>
          </div>

          <div className="absolute right-4 top-4 z-[1000] flex flex-col items-end gap-2 lg:bottom-4 lg:top-auto">
            <button
              type="button"
              onClick={requestUserLocation}
              disabled={locationState === 'loading'}
              aria-label={locationState === 'ready' ? 'Center on my location' : 'Locate me'}
              title={locationState === 'ready' ? 'Center on my location' : 'Locate me'}
              className={`flex h-11 w-11 items-center justify-center border shadow-lg transition ${
                isNightMode
                  ? 'border-white/10 bg-[#1d1821] text-white hover:bg-[#2a2230]'
                  : 'border-[#d6d0c6] bg-white text-slate-800 hover:bg-[#f8f3fb]'
              } ${locationState === 'loading' ? 'cursor-wait opacity-80' : ''}`}
            >
              <LocateMeIcon />
            </button>

            {locationMessage ? (
              <div
                className={`border px-3 py-1 text-xs font-medium ${
                  isNightMode
                    ? 'border-white/10 bg-[#1d1821] text-white'
                    : 'border-[#d6d0c6] bg-white text-slate-600'
                }`}
              >
                {locationMessage}
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => setIsNightMode((current) => !current)}
              aria-label={isNightMode ? 'Switch to light mode' : 'Switch to night mode'}
              title={isNightMode ? 'Switch to light mode' : 'Switch to night mode'}
              className={`flex h-11 w-11 items-center justify-center border shadow-lg transition ${
                isNightMode
                  ? 'border-white/10 bg-[#1d1821] text-white hover:bg-[#2a2230]'
                  : 'border-[#d6d0c6] bg-white text-slate-800 hover:bg-[#f8f3fb]'
              }`}
            >
              <NightModeIcon isNightMode={isNightMode} />
            </button>

            <a
              href="https://github.com/hitrustt/nola-transit-live"
              target="_blank"
              rel="noreferrer"
              aria-label="Open project GitHub page"
              title="Open project GitHub page"
              className={`hidden h-11 w-11 items-center justify-center border shadow-lg transition lg:flex ${
                isNightMode
                  ? 'border-white/10 bg-[#1d1821] text-white hover:bg-[#2a2230]'
                  : 'border-[#d6d0c6] bg-white text-slate-800 hover:bg-[#f8f3fb]'
              }`}
            >
              <HelpIcon />
            </a>
          </div>

          <div className="absolute inset-x-0 bottom-0 z-[1000] lg:hidden">
            <div
              className={`mobile-sheet border-t px-4 pb-4 pt-2 ${
                isMobileSheetCollapsed ? 'mobile-sheet--collapsed' : ''
              } ${
                isNightMode
                  ? 'border-white/10 bg-[#1d1821]/98 text-slate-100'
                  : 'border-[#d6d0c6] bg-white/98 text-slate-900'
              }`}
            >
              <button
                type="button"
                onClick={() => setIsMobileSheetCollapsed((current) => !current)}
                aria-label={isMobileSheetCollapsed ? 'Expand panel' : 'Collapse panel'}
                className={`mx-auto mb-3 flex h-8 w-16 items-center justify-center rounded-full border transition ${
                  isNightMode
                    ? 'border-white/10 bg-white/5 text-slate-200'
                    : 'border-[#d6d0c6] bg-white text-[#4f255f]'
                }`}
              >
                <SheetToggleIcon collapsed={isMobileSheetCollapsed} />
              </button>

              <div className="mb-3">
                <div>
                  <div className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${isNightMode ? 'text-white/80' : 'text-slate-500'}`}>
                    {mobileTab === 'routes' ? 'Routes' : selectedRoutes.length ? 'Stops' : 'Transfer Hubs'}
                  </div>
                  <div className={`mt-1 text-sm font-semibold ${isNightMode ? 'text-white' : 'text-slate-900'}`}>
                    {mobileTab === 'routes' ? `${feed.routes.length} routes` : `${visibleStops.length} shown`}
                  </div>
                </div>
              </div>

              {!isMobileSheetCollapsed ? (
                <>
                  {realtimeState.error ? (
                    <div className={`mb-3 border px-3 py-2 text-sm ${
                      isNightMode
                        ? 'border-rose-400/40 bg-rose-950/30 text-rose-100'
                        : 'border-rose-300 bg-rose-50 text-rose-700'
                    }`}>
                      {realtimeState.error}
                    </div>
                  ) : null}

                  {selectedRoutesVehicleMessage ? (
                    <div className={`mb-3 border px-3 py-2 text-sm ${
                      isNightMode
                        ? 'border-white/10 bg-[#211a27] text-white'
                        : 'border-[#d6d0c6] bg-white text-slate-700'
                    }`}>
                      {selectedRoutesVehicleMessage}
                    </div>
                  ) : null}

                  <div className="mb-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setMobileTab('routes')}
                      className={`border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] ${
                        mobileTab === 'routes'
                          ? 'border-[#722c88] bg-[#722c88] text-white'
                          : isNightMode
                            ? 'border-white/10 bg-white/5 text-white'
                            : 'border-[#d6d0c6] bg-white text-[#4f255f]'
                      }`}
                    >
                      Routes
                    </button>
                    <button
                      type="button"
                      onClick={() => setMobileTab('hubs')}
                      className={`border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] ${
                        mobileTab === 'hubs'
                          ? 'border-[#722c88] bg-[#722c88] text-white'
                          : isNightMode
                            ? 'border-white/10 bg-white/5 text-white'
                            : 'border-[#d6d0c6] bg-white text-[#4f255f]'
                      }`}
                    >
                      {selectedRoutes.length ? 'Stops' : 'Hubs'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRouteSelection(null)}
                      className={`border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] ${
                        selectedRoutes.length
                          ? isNightMode
                            ? 'border-white/10 bg-white/5 text-white'
                            : 'border-[#d6d0c6] bg-white text-[#4f255f]'
                          : 'border-[#2c7a46] bg-[#2c7a46] text-white'
                      }`}
                    >
                      System View
                    </button>
                    <button
                      type="button"
                      onClick={clearSelections}
                      className={`border px-3 py-2 text-xs font-semibold uppercase tracking-[0.08em] ${
                        isNightMode
                          ? 'border-white/10 bg-white/5 text-white'
                          : 'border-[#d6d0c6] bg-white text-[#4f255f]'
                      }`}
                    >
                      Clear All
                    </button>
                  </div>

                  {mobileTab === 'routes' ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                      <div className="mb-3">
                        <input
                          type="search"
                          value={routeSearch}
                          onChange={(event) => setRouteSearch(event.target.value)}
                          placeholder="Search routes"
                          className={`w-full border px-3 py-2 text-sm outline-none transition ${
                            isNightMode
                              ? 'border-white/10 bg-[#17121d] text-white placeholder:text-white/70 focus:border-[#b77ccc]'
                              : 'border-[#d7cedd] bg-white text-slate-900 placeholder:text-slate-400 focus:border-[#722c88]'
                          }`}
                        />
                      </div>
                      <div className="panel-scrollbar mobile-sheet__list space-y-1 overflow-y-auto">
                        {routeEmptyState ? (
                          <EmptyStateCard
                            title={routeEmptyState.title}
                            message={routeEmptyState.message}
                            isNightMode={isNightMode}
                            compact
                          />
                        ) : filteredRoutes.map((route) => {
                          const isActive = selectedRouteIdSet.has(route.id);

                          return (
                            <button
                              key={route.id}
                              type="button"
                              onClick={() => handleRouteSelection(route.id)}
                              className={`w-full border px-3 py-3 text-left transition ${
                                isActive
                                  ? isNightMode
                                    ? 'border-[#8f4aa7] bg-[#35283c]'
                                    : 'border-[#722c88] bg-[#efe6f4]'
                                  : isNightMode
                                    ? 'border-white/10 bg-[#1d1821] hover:border-[#8f4aa7] hover:bg-[#2a2230]'
                                    : 'border-[#e8e0ec] bg-white hover:border-[#b894c5] hover:bg-[#f8f4fb]'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex min-w-0 items-center gap-3">
                                  <div
                                    className="flex h-9 w-9 shrink-0 items-center justify-center border border-black/10 text-sm font-black text-slate-900"
                                    style={{ backgroundColor: route.color }}
                                  >
                                    {route.shortName}
                                  </div>
                                  <div className="min-w-0">
                                    <div className={`truncate font-semibold ${isNightMode ? 'text-white' : 'text-slate-900'}`}>
                                      {route.longName}
                                    </div>
                                    <div className={`truncate text-sm ${isNightMode ? 'text-white' : 'text-slate-500'}`}>
                                      {route.terminals.join(' to ')}
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col">
                      <div className="mb-3">
                        <input
                          type="search"
                          value={stopSearch}
                          onChange={(event) => setStopSearch(event.target.value)}
                          placeholder={selectedRoutes.length ? 'Search stops' : 'Search transfer hubs'}
                          className={`w-full border px-3 py-2 text-sm outline-none transition ${
                            isNightMode
                              ? 'border-white/10 bg-[#17121d] text-white placeholder:text-white/70 focus:border-[#b77ccc]'
                              : 'border-[#d7cedd] bg-white text-slate-900 placeholder:text-slate-400 focus:border-[#722c88]'
                          }`}
                        />
                      </div>
                      {selectedStop ? (
                        <div
                          className={`mb-3 border px-4 py-3 ${
                            isNightMode
                              ? 'border-[#8f4aa7]/50 bg-[#2b2232]'
                              : 'border-[#d9c7e0] bg-[#f4eaf8]'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className={`truncate font-semibold ${isNightMode ? 'text-white' : 'text-slate-900'}`}>
                                {selectedStop.name}
                              </div>
                              <div className={`mt-1 text-xs font-medium uppercase tracking-[0.08em] ${isNightMode ? 'text-white' : 'text-slate-500'}`}>
                                Stop {selectedStop.code}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => setSelectedStopId(null)}
                              className={`border px-3 py-1 text-xs font-semibold uppercase tracking-[0.06em] ${
                                isNightMode
                                  ? 'border-white/10 bg-white/5 text-white'
                                  : 'border-[#d7cedd] bg-white text-[#4f255f]'
                              }`}
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                      ) : null}
                      <div className="panel-scrollbar mobile-sheet__list space-y-1 overflow-y-auto">
                        {stopEmptyState ? (
                          <EmptyStateCard
                            title={stopEmptyState.title}
                            message={stopEmptyState.message}
                            isNightMode={isNightMode}
                            compact
                          />
                        ) : visibleStops.map((stop) => {
                          const isSelected = stop.id === selectedStopId;

                          return (
                            <button
                              key={stop.id}
                              type="button"
                              onClick={() => handleStopSelection(stop.id)}
                              className={`w-full border px-3 py-3 text-left transition ${
                                isSelected
                                  ? isNightMode
                                    ? 'border-[#8f4aa7] bg-[#35283c]'
                                    : 'border-[#722c88] bg-[#efe6f4]'
                                  : isNightMode
                                    ? 'border-white/10 bg-[#1d1821] hover:border-[#8f4aa7] hover:bg-[#2a2230]'
                                    : 'border-[#e8e0ec] bg-white hover:border-[#b894c5] hover:bg-[#f8f4fb]'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                  <div className={`truncate font-semibold ${isNightMode ? 'text-white' : 'text-slate-900'}`}>
                                    {stop.name}
                                  </div>
                                  <div className={`mt-1 text-xs font-medium uppercase tracking-[0.08em] ${isNightMode ? 'text-white' : 'text-slate-500'}`}>
                                    {stop.code}
                                  </div>
                                </div>
                                <div className={`text-right text-xs leading-4 ${isNightMode ? 'text-white' : 'text-slate-500'}`}>
                                  {stop.routes.join(' • ')}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          </div>

        </main>
      </div>
    </div>
  );
}

export default App;
