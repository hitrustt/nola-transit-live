import { useNow, useRealtime, useVehicles } from '../app/hooks.ts';
import { isFresh } from '../app/realtime.ts';
import { navigate } from '../app/router.ts';
import { ago, clockTime, countdown, modeNoun } from '../lib/format.ts';
import type { Network } from '../lib/network.ts';
import { STALE_POSITION_MS, upcomingStopIndex } from '../lib/vehicles.ts';
import { alignToPattern } from '../lib/arrivals.ts';
import { EmptyState, ViewHeader } from '../ui/common.tsx';
import { LiveMark } from '../ui/Icon.tsx';
import { RouteBadge } from '../ui/RouteBadge.tsx';

export function VehicleHeader({ network, vehicleId }: { network: Network; vehicleId: string }) {
  const vehicle = useVehicles().get(vehicleId);
  if (!vehicle) return <ViewHeader title={`Vehicle ${vehicleId}`} />;
  const route = network.routesById.get(vehicle.route.id)!;
  return (
    <ViewHeader>
      <div className="route-heading">
        <RouteBadge route={route} size="lg" />
        <h1 className="route-heading__name">
          <span className="route-heading__to">To</span> {vehicle.headsign}
        </h1>
      </div>
    </ViewHeader>
  );
}

export function VehicleView({ network, vehicleId }: { network: Network; vehicleId: string }) {
  const vehicles = useVehicles();
  const realtime = useRealtime();
  const now = useNow(5_000);
  const vehicle = vehicles.get(vehicleId);

  if (!vehicle) {
    return (
      <EmptyState title={realtime.snapshot ? 'This vehicle isn’t reporting right now' : 'Loading live vehicles…'}>
        {realtime.snapshot && 'It may have finished its trip or gone out of service.'}
      </EmptyState>
    );
  }

  const trip = vehicle.tripId ? realtime.snapshot?.trips[vehicle.tripId] : undefined;
  const base = (realtime.snapshot?.timeBase ?? 0) * 1000;
  const live = isFresh(realtime, now);
  const age = now - vehicle.timestamp;
  const pattern = vehicle.pattern;
  const fromIndex = upcomingStopIndex(vehicle) ?? 0;
  // Keyed by position in the trip, not stop id: a loop visits its hub twice.
  const predicted = new Map<number, { time: number | null; skipped: boolean }>();
  if (trip && pattern) {
    alignToPattern(trip.stops.map(([stopId]) => stopId), pattern.stops).forEach((index, order) => {
      if (index === -1) return;
      const [, seconds, skipped] = trip.stops[order]!;
      predicted.set(index, { time: seconds === null ? null : base + seconds * 1000, skipped: skipped === 1 });
    });
  }
  const upcoming = pattern ? pattern.stops.slice(fromIndex).map((stopId, offset) => ({ stopId, index: fromIndex + offset })) : [];

  return (
    <div className="vehicle-detail">
      <dl className="facts">
        <div>
          <dt>{modeNoun(vehicle.route.mode).replace(/^./, (letter) => letter.toUpperCase())}</dt>
          <dd>{vehicle.id}</dd>
        </div>
        <div>
          <dt>Position</dt>
          <dd className={age > STALE_POSITION_MS ? 'is-warn' : undefined}>Updated {ago(vehicle.timestamp, now)}</dd>
        </div>
        {vehicle.speed !== null && (
          <div>
            <dt>Speed</dt>
            <dd>{vehicle.speed < 0.5 ? 'Stopped' : `${Math.round(vehicle.speed * 2.237)} mph`}</dd>
          </div>
        )}
      </dl>

      {trip?.status === 'canceled' && <p className="notice notice--alert">RTA has canceled the rest of this trip.</p>}
      {!live && realtime.snapshot && (
        <p className="section__note">Live data isn’t updating, so arrival times for this trip are hidden. The position shown is the last one reported.</p>
      )}

      {upcoming.length ? (
        <ol className="line line--compact" style={{ '--route-color': vehicle.route.color } as React.CSSProperties} aria-label="Next stops">
          {upcoming.map(({ stopId, index }) => {
            const stop = network.stopsById.get(stopId);
            if (!stop) return null;
            const prediction = predicted.get(index);
            const skipped = prediction?.skipped ?? false;
            return (
              <li key={`${stopId}-${index}`} className={`line__item${skipped ? ' is-skipped' : ''}`}>
                <button type="button" className="line__stop" onClick={() => navigate({ name: 'stop', stopId })}>
                  <span className="line__name">{stop.name}</span>
                  {skipped && <span className="line__note">Not served on this trip</span>}
                  {!skipped && live && prediction?.time && (
                    <span className="line__next" title={clockTime(prediction.time)}>
                      <LiveMark />
                      {formatPrediction(prediction.time, now)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyState title="This vehicle isn’t on a scheduled trip">It may be heading to or from the garage.</EmptyState>
      )}
    </div>
  );
}

function formatPrediction(time: number, now: number) {
  const value = countdown(time, now);
  if (value.value === 'Due') return 'Due';
  return value.unit === 'min' ? `${value.value} min` : `${value.value} ${value.unit}`;
}
