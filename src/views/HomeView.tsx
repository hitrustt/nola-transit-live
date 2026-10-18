import { useDeferredValue, useMemo } from 'react';
import { haversineMeters } from '../../shared/geo.ts';
import { useDepartures, useNow, useServiceChanges, useVehicles } from '../app/hooks.ts';
import { requestLocation, useLocation } from '../app/location.ts';
import { usePreferences } from '../app/preferences.ts';
import { navigate } from '../app/router.ts';
import { countdown, distance, gtfsClock, walkMinutes } from '../lib/format.ts';
import { groupRoutesByMode, type Network, type Route, type Stop } from '../lib/network.ts';
import { createSearchIndex, type SearchResult } from '../lib/search.ts';
import { weekdayIndex, localDate } from '../lib/time.ts';
import { EmptyState, RouteBadges } from '../ui/common.tsx';
import { Icon, LiveMark } from '../ui/Icon.tsx';
import { RouteBadge } from '../ui/RouteBadge.tsx';

export function HomeHeader({ query, onQuery }: { query: string; onQuery: (value: string) => void }) {
  return (
    <div className="home-header">
      <div className="brand">
        <span className="tile tile--brand" aria-hidden="true">
          NOLA
        </span>
        <span className="brand__name">
          Transit Live <span className="brand__sub">New Orleans RTA, unofficial</span>
        </span>
        <button type="button" className="icon-button brand__about" onClick={() => navigate({ name: 'about' })} aria-label="About this app">
          <Icon name="info" />
        </button>
      </div>
      <label className="search">
        <Icon name="search" className="search__icon" />
        <span className="visually-hidden">Search routes and stops</span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder="Route, stop, or stop number"
          autoComplete="off"
          enterKeyHint="search"
          spellCheck={false}
        />
        {query && (
          <button type="button" className="search__clear" onClick={() => onQuery('')} aria-label="Clear search">
            <Icon name="close" size={18} />
          </button>
        )}
      </label>
    </div>
  );
}

export function HomeView({ network, query }: { network: Network; query: string }) {
  const deferred = useDeferredValue(query.trim());
  return deferred ? <SearchResults network={network} query={deferred} /> : <HomeContent network={network} />;
}

// ---------------------------------------------------------------------------

function SearchResults({ network, query }: { network: Network; query: string }) {
  const search = useMemo(() => createSearchIndex(network), [network]);
  const results = search(query);

  if (!results.length) {
    return (
      <EmptyState title={`Nothing matches “${query}”`}>
        Try a route number like 12, a street like Canal, or the stop number on the sign.
      </EmptyState>
    );
  }

  return (
    <ul className="list" aria-label="Search results">
      {results.map((result) => (
        <li key={result.kind === 'route' ? `r:${result.route.id}` : `s:${result.stop.id}`}>
          <ResultRow network={network} result={result} />
        </li>
      ))}
    </ul>
  );
}

function ResultRow({ network, result }: { network: Network; result: SearchResult }) {
  if (result.kind === 'route') return <RouteRow route={result.route} />;
  return <StopRow network={network} stop={result.stop} />;
}

// ---------------------------------------------------------------------------

function HomeContent({ network }: { network: Network }) {
  const preferences = usePreferences();
  const { detours, alerts } = useServiceChanges();
  const savedStops = preferences.savedStops.map((id) => network.stopsById.get(id)).filter((stop): stop is Stop => Boolean(stop));
  const savedRoutes = preferences.savedRoutes.map((id) => network.routesById.get(id)).filter((route): route is Route => Boolean(route));
  const changes = detours.length + alerts.length;

  return (
    <div className="home">
      {changes > 0 && (
        <button type="button" className="changes" onClick={() => navigate({ name: 'alerts' })}>
          <Icon name={alerts.length ? 'alert' : 'detour'} />
          <span>
            {[alerts.length ? `${alerts.length} service alert${alerts.length === 1 ? '' : 's'}` : null, detours.length ? `${detours.length} detour${detours.length === 1 ? '' : 's'}` : null]
              .filter(Boolean)
              .join(' and ')}{' '}
            in effect
          </span>
          <Icon name="chevron" className="changes__chevron" />
        </button>
      )}

      {(savedStops.length > 0 || savedRoutes.length > 0) && (
        <section className="section" aria-labelledby="saved-heading">
          <h2 id="saved-heading" className="section__title">
            Saved
          </h2>
          <ul className="list">
            {savedStops.map((stop) => (
              <li key={stop.id}>
                <SavedStop network={network} stop={stop} />
              </li>
            ))}
            {savedRoutes.map((route) => (
              <li key={route.id}>
                <RouteRow route={route} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <Nearby network={network} />

      {groupRoutesByMode(network.routes).map((group) => (
        <section key={group.mode} className="section" aria-labelledby={`group-${group.mode}`}>
          <h2 id={`group-${group.mode}`} className="section__title">
            {group.label}
          </h2>
          <ul className="list">
            {group.routes.map((route) => (
              <li key={route.id}>
                <RouteRow route={route} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Nearby({ network }: { network: Network }) {
  const location = useLocation();

  const nearby = useMemo(() => {
    if (location.status !== 'ready') return [];
    return network.stops
      .map((stop) => ({ stop, meters: haversineMeters(location.position, [stop.lat, stop.lng]) }))
      .filter((entry) => entry.meters < 1200)
      .sort((a, b) => a.meters - b.meters)
      .slice(0, 6);
  }, [network, location]);

  return (
    <section className="section" aria-labelledby="nearby-heading">
      <h2 id="nearby-heading" className="section__title">
        Near you
      </h2>
      {location.status === 'ready' ? (
        nearby.length ? (
          <ul className="list">
            {nearby.map(({ stop, meters }) => (
              <li key={stop.id}>
                <StopRow network={network} stop={stop} meta={`${distance(meters)}, ${walkMinutes(meters)} min walk`} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="section__note">No RTA stops within three quarters of a mile.</p>
        )
      ) : (
        <div className="nearby-prompt">
          <button type="button" className="button" onClick={requestLocation} disabled={location.status === 'locating'}>
            <Icon name="locate" />
            {location.status === 'locating' ? 'Finding your location…' : 'Show stops near me'}
          </button>
          {location.status === 'denied' && (
            <p className="section__note">Location is turned off for this site. Allow it in your browser settings, or search for a stop instead.</p>
          )}
          {location.status === 'unavailable' && <p className="section__note">{location.message}</p>}
        </div>
      )}
    </section>
  );
}

function SavedStop({ network, stop }: { network: Network; stop: Stop }) {
  const { departures, live } = useDepartures(network, stop.id, 90 * 60_000);
  const now = useNow();
  const next = departures.filter((departure) => departure.status === 'live' || departure.status === 'scheduled').slice(0, 2);

  return (
    <button type="button" className="row" onClick={() => navigate({ name: 'stop', stopId: stop.id })}>
      <span className="row__main">
        <span className="row__title">{stop.name}</span>
        <span className="row__meta">
          {next.length
            ? next.map((departure, index) => (
                <span key={departure.key} className="saved-next">
                  {index > 0 && ', '}
                  {departure.route.shortName} {live && departure.status === 'live' && <LiveMark />}
                  {formatShort(departure.time, now)}
                </span>
              ))
            : 'No departures in the next 90 minutes'}
        </span>
      </span>
      <Icon name="chevron" className="row__chevron" />
    </button>
  );
}

function formatShort(time: number, now: number) {
  const value = countdown(time, now);
  return value.unit === 'min' ? `${value.value} min` : value.value === 'Due' ? 'due' : `${value.value} ${value.unit}`;
}

export function StopRow({ network, stop, meta }: { network: Network; stop: Stop; meta?: string }) {
  return (
    <button type="button" className="row" onClick={() => navigate({ name: 'stop', stopId: stop.id })}>
      <span className="row__main">
        <span className="row__title">{stop.name}</span>
        <span className="row__meta">
          <RouteBadges network={network} routeIds={stop.routes} limit={6} />
          <span className="row__aside">{meta ?? `Stop ${stop.code}`}</span>
        </span>
      </span>
      <Icon name="chevron" className="row__chevron" />
    </button>
  );
}

export function RouteRow({ route }: { route: Route }) {
  const vehicles = useVehicles();
  const now = useNow(60_000);
  const running = useMemo(() => [...vehicles.values()].filter((vehicle) => vehicle.route.id === route.id).length, [vehicles, route.id]);
  const day = weekdayIndex(localDate(now));
  const headway = day === 5 ? route.headways.saturday : day === 6 ? route.headways.sunday : route.headways.weekday;

  return (
    <button type="button" className="row" onClick={() => navigate({ name: 'route', routeId: route.id, directionId: null })}>
      <RouteBadge route={route} />
      <span className="row__main">
        <span className="row__title">{route.longName}</span>
        <span className="row__meta">
          {headway ? `Every ${headway} min` : route.span ? `${gtfsClock(route.span.first)} to ${gtfsClock(route.span.last)}` : 'Limited service'}
          {running > 0 && <span className="row__running">{running} running</span>}
        </span>
      </span>
      <Icon name="chevron" className="row__chevron" />
    </button>
  );
}
