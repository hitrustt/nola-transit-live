import { useMemo } from 'react';
import { useDepartures, useNow, useServiceChanges } from '../app/hooks.ts';
import { toggleSavedStop, usePreferences } from '../app/preferences.ts';
import { departuresForStop } from '../lib/arrivals.ts';
import { haversineMeters } from '../../shared/geo.ts';
import { clockTime, distance } from '../lib/format.ts';
import { StopRow } from './HomeView.tsx';
import type { Network, Stop } from '../lib/network.ts';
import { useSchedules } from '../app/data.ts';
import { AlertNotice, DetourNotice, EmptyState, IconToggle, RouteBadges, ShareButton, Skeleton, ViewHeader } from '../ui/common.tsx';
import { DepartureBoard } from '../ui/Departures.tsx';

export function StopHeader({ network, stop }: { network: Network; stop: Stop | undefined }) {
  const preferences = usePreferences();
  if (!stop) return <ViewHeader title="Stop not found" />;
  const saved = preferences.savedStops.includes(stop.id);

  return (
    <ViewHeader
      actions={
        <>
          <IconToggle icon="star" label={saved ? 'Remove from saved' : 'Save stop'} pressed={saved} onClick={() => toggleSavedStop(stop.id)} />
          <ShareButton title={stop.name} />
        </>
      }
    >
      <div className="stop-heading">
        {/* Echoes the cobalt-on-white street name tiles set into New Orleans sidewalks. */}
        <h1 className="tile tile--stop">{stop.name}</h1>
        <p className="stop-heading__meta">
          <span>Stop {stop.code}</span>
          <RouteBadges network={network} routeIds={stop.routes} limit={10} />
        </p>
      </div>
    </ViewHeader>
  );
}

export function StopView({ network, stopId }: { network: Network; stopId: string }) {
  const stop = network.stopsById.get(stopId);
  if (!stop) {
    return (
      <EmptyState title="This stop isn’t in the current timetable">
        RTA may have moved or retired it. Search for a nearby street instead.
      </EmptyState>
    );
  }
  return <StopDepartures network={network} stop={stop} />;
}

function StopDepartures({ network, stop }: { network: Network; stop: Stop }) {
  const { departures, loading, live } = useDepartures(network, stop.id);
  const now = useNow();
  const { alerts, detours } = useServiceChanges({ stopId: stop.id, routeIds: stop.routes });

  return (
    <div className="stop">
      <DetourNotice network={network} detours={detours} stopId={stop.id} />
      <AlertNotice alerts={alerts} />
      {loading && !departures.length ? (
        <Skeleton rows={5} />
      ) : departures.length ? (
        <DepartureBoard departures={departures} now={now} live={live} />
      ) : (
        <NoService network={network} stop={stop} now={now} />
      )}
      <NearbyStops network={network} stop={stop} />
    </div>
  );
}

/**
 * Other stops within a short walk, closest first. Most corners have a stop on
 * each side of the street, one per direction, and riders often land on the
 * wrong one.
 */
function NearbyStops({ network, stop }: { network: Network; stop: Stop }) {
  const nearby = useMemo(
    () =>
      network.stops
        .filter((other) => other.id !== stop.id)
        .map((other) => ({ stop: other, meters: haversineMeters([stop.lat, stop.lng], [other.lat, other.lng]) }))
        .filter((entry) => entry.meters <= 250)
        .sort((a, b) => a.meters - b.meters)
        .slice(0, 5),
    [network, stop],
  );

  if (!nearby.length) return null;

  return (
    <section className="section" aria-labelledby="nearby-stops">
      <h2 id="nearby-stops" className="section__title">
        Nearby stops
      </h2>
      <ul className="list">
        {nearby.map(({ stop: other, meters }) => (
          <li key={other.id}>
            <StopRow network={network} stop={other} meta={meters < 40 ? 'Across the street' : `${distance(meters)} away`} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** When nothing runs in the next 3 hours, say when service resumes. */
function NoService({ network, stop, now }: { network: Network; stop: Stop; now: number }) {
  const patternIds = useMemo(
    () => [...new Set((network.visitsByStop.get(stop.id) ?? []).map((visit) => visit.pattern.id))],
    [network, stop.id],
  );
  const { schedules, version } = useSchedules(patternIds);
  const next = useMemo(
    () => departuresForStop(network, stop.id, schedules, null, now, { horizonMs: 30 * 3600_000 })[0],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [network, stop.id, version, now],
  );

  return (
    <EmptyState title="No departures in the next 3 hours">
      {next ? `Next scheduled: route ${next.route.shortName} at ${clockTime(next.time)}.` : 'No service is scheduled from this stop.'}
    </EmptyState>
  );
}
