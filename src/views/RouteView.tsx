import { useMemo } from 'react';
import { useNow, useRealtime, useServiceChanges, useVehicles } from '../app/hooks.ts';
import { toggleSavedRoute, usePreferences } from '../app/preferences.ts';
import { isFresh } from '../app/realtime.ts';
import { navigate } from '../app/router.ts';
import { countdown, gtfsClock, modeNoun } from '../lib/format.ts';
import { mainPattern, type Network, type Pattern, type Route } from '../lib/network.ts';
import { localDate, weekdayIndex } from '../lib/time.ts';
import type { TrackedVehicle } from '../lib/vehicles.ts';
import { AlertNotice, DetourNotice, EmptyState, IconToggle, ShareButton, ViewHeader } from '../ui/common.tsx';
import { LiveMark } from '../ui/Icon.tsx';
import { RouteBadge } from '../ui/RouteBadge.tsx';

export function RouteHeader({ route }: { route: Route | undefined }) {
  const preferences = usePreferences();
  if (!route) return <ViewHeader title="Route not found" />;
  const saved = preferences.savedRoutes.includes(route.id);

  return (
    <ViewHeader
      actions={
        <>
          <IconToggle icon="star" label={saved ? 'Remove from saved' : 'Save route'} pressed={saved} onClick={() => toggleSavedRoute(route.id)} />
          <ShareButton title={`${route.shortName} ${route.longName}`} />
        </>
      }
    >
      <div className="route-heading">
        <RouteBadge route={route} size="lg" />
        <h1 className="route-heading__name">{route.longName}</h1>
      </div>
    </ViewHeader>
  );
}

export function RouteView({ network, routeId, directionId }: { network: Network; routeId: string; directionId: number | null }) {
  const route = network.routesById.get(routeId);
  if (!route) {
    return <EmptyState title="This route isn’t in the current timetable">RTA may have renumbered or discontinued it.</EmptyState>;
  }
  const direction = route.directions.find((entry) => entry.id === directionId) ?? route.directions[0]!;
  const pattern = mainPattern(network, route, direction.id);
  return <RouteDetail network={network} route={route} directionId={direction.id} pattern={pattern} />;
}

function RouteDetail({ network, route, directionId, pattern }: { network: Network; route: Route; directionId: number; pattern: Pattern | null }) {
  const vehicles = useVehicles();
  const realtime = useRealtime();
  const now = useNow();
  const live = isFresh(realtime, now);
  const { alerts, detours } = useServiceChanges({ routeId: route.id });

  const onRoute = useMemo(() => [...vehicles.values()].filter((vehicle) => vehicle.route.id === route.id), [vehicles, route.id]);
  const day = weekdayIndex(localDate(now));
  const headway = day === 5 ? route.headways.saturday : day === 6 ? route.headways.sunday : route.headways.weekday;

  return (
    <div className="route">
      <dl className="facts">
        <div>
          <dt>Running now</dt>
          <dd>{onRoute.length ? `${onRoute.length} ${modeNoun(route.mode, onRoute.length)}` : 'None reporting'}</dd>
        </div>
        {headway && (
          <div>
            <dt>Scheduled</dt>
            <dd>Every {headway} min</dd>
          </div>
        )}
        {route.span && (
          <div>
            <dt>Service</dt>
            <dd>
              {gtfsClock(route.span.first)} to {gtfsClock(route.span.last)}
            </dd>
          </div>
        )}
      </dl>

      <DetourNotice network={network} detours={detours} />
      <AlertNotice alerts={alerts} />

      {route.directions.length > 1 && (
        <div className="segmented" role="tablist" aria-label="Direction">
          {route.directions.map((direction) => (
            <button
              key={direction.id}
              type="button"
              role="tab"
              aria-selected={direction.id === directionId}
              className="segmented__option"
              onClick={() => navigate({ name: 'route', routeId: route.id, directionId: direction.id }, { replace: true })}
            >
              <span className="segmented__to">To</span> {direction.headsign}
            </button>
          ))}
        </div>
      )}

      {pattern ? (
        <StopLine network={network} route={route} pattern={pattern} vehicles={onRoute} now={now} live={live} />
      ) : (
        <EmptyState title="No stop list for this direction" />
      )}
    </div>
  );
}

/**
 * The route as a line of stops, with vehicles drawn between the stops they
 * are actually between, and the next live arrival at each stop.
 */
function StopLine({
  network,
  route,
  pattern,
  vehicles,
  now,
  live,
}: {
  network: Network;
  route: Route;
  pattern: Pattern;
  vehicles: TrackedVehicle[];
  now: number;
  live: boolean;
}) {
  const realtime = useRealtime();

  // Vehicles on any pattern of this direction, placed by nearest stop on the main pattern.
  const placed = useMemo(() => {
    const byGap = new Map<number, TrackedVehicle[]>();
    for (const vehicle of vehicles) {
      if (!vehicle.pattern || vehicle.pattern.directionId !== pattern.directionId) continue;
      const gap = gapIndex(pattern, vehicle);
      if (gap === null) continue;
      if (!byGap.has(gap)) byGap.set(gap, []);
      byGap.get(gap)!.push(vehicle);
    }
    return byGap;
  }, [vehicles, pattern]);

  // Soonest live prediction per stop for this route and direction.
  const nextByStop = useMemo(() => {
    const result = new Map<string, number>();
    const snapshot = realtime.snapshot;
    if (!snapshot || !live) return result;
    const base = snapshot.timeBase * 1000;
    for (const trip of Object.values(snapshot.trips)) {
      if (trip.routeId !== route.id || trip.status === 'canceled') continue;
      const tripPattern = trip.patternId ? network.patternsById.get(trip.patternId) : null;
      if (tripPattern && tripPattern.directionId !== pattern.directionId) continue;
      for (const [stopId, seconds, skipped] of trip.stops) {
        if (skipped || seconds === null) continue;
        const time = base + seconds * 1000;
        // NORTA keeps a stop in the list until the vehicle departs it, so a
        // time slightly in the past means "at the stop now": show it as Due.
        if (time < now - 60_000) continue;
        if (!result.has(stopId) || time < result.get(stopId)!) result.set(stopId, time);
      }
    }
    return result;
  }, [realtime.snapshot, live, route.id, pattern.directionId, network, now]);

  const skipped = useMemo(() => {
    const set = new Set<string>();
    realtime.snapshot?.detours
      .filter((detour) => detour.routeIds.includes(route.id))
      .forEach((detour) => {
        // Only detoured patterns running this direction; the other way may be unaffected.
        for (const [patternId, stops] of Object.entries(detour.skippedStops)) {
          if (network.patternsById.get(patternId)?.directionId === pattern.directionId) stops.forEach((id) => set.add(id));
        }
      });
    return set;
  }, [realtime.snapshot, route.id, pattern.directionId, network]);

  return (
    <ol className="line" style={{ '--route-color': route.color } as React.CSSProperties} aria-label={`Stops toward ${pattern.headsign}`}>
      {pattern.stops.map((stopId, index) => {
        const stop = network.stopsById.get(stopId);
        if (!stop) return null;
        const next = nextByStop.get(stopId);
        const here = placed.get(index) ?? [];
        const isEnd = index === 0 || index === pattern.stops.length - 1;
        return (
          <li key={`${stopId}-${index}`} className={`line__item${isEnd ? ' is-terminal' : ''}${skipped.has(stopId) ? ' is-skipped' : ''}`}>
            {here.map((vehicle) => (
              <button
                key={vehicle.id}
                type="button"
                className="line__vehicle"
                onClick={() => navigate({ name: 'vehicle', vehicleId: vehicle.id })}
                aria-label={`${modeNoun(route.mode)} ${vehicle.id} approaching ${stop.name}`}
              >
                <span className="line__vehicle-dot" aria-hidden="true" />
                {modeNoun(route.mode).replace(/^./, (letter) => letter.toUpperCase())} {vehicle.id}
              </button>
            ))}
            <button type="button" className="line__stop" onClick={() => navigate({ name: 'stop', stopId })}>
              <span className="line__name">{stop.name}</span>
              {skipped.has(stopId) && <span className="line__note">Detour, not served</span>}
              {next !== undefined && !skipped.has(stopId) && (
                <span className="line__next">
                  <LiveMark />
                  {countdown(next, now).value === 'Due' ? 'Due' : `${countdown(next, now).value} ${countdown(next, now).unit}`}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** Index of the stop a vehicle is heading toward on `pattern`, by projection. */
function gapIndex(pattern: Pattern, vehicle: TrackedVehicle): number | null {
  if (vehicle.pattern === pattern && vehicle.distanceAlong !== null) {
    const index = pattern.stopDistances.findIndex((distance) => distance >= vehicle.distanceAlong! - 10);
    return index === -1 ? null : index;
  }
  // A branch or short-turn pattern: use the nearest stop by straight distance.
  let best = -1;
  let bestDistance = Infinity;
  pattern.stops.forEach((stopId, index) => {
    const stopIndex = vehicle.pattern!.stops.indexOf(stopId);
    if (stopIndex === -1 || vehicle.distanceAlong === null) return;
    const delta = vehicle.pattern!.stopDistances[stopIndex]! - vehicle.distanceAlong;
    if (delta >= -10 && delta < bestDistance) {
      bestDistance = delta;
      best = index;
    }
  });
  return best === -1 ? null : best;
}
