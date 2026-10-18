import { useRealtime } from '../app/hooks.ts';
import { setTheme, usePreferences, type ThemePreference } from '../app/preferences.ts';
import { navigate } from '../app/router.ts';
import { clockTime } from '../lib/format.ts';
import type { Network } from '../lib/network.ts';
import { EmptyState, formatDate, ViewHeader } from '../ui/common.tsx';
import { Icon } from '../ui/Icon.tsx';
import { RouteBadge } from '../ui/RouteBadge.tsx';

export function AlertsHeader() {
  return <ViewHeader title={<h1 className="view-title">Service changes</h1>} />;
}

export function AlertsView({ network }: { network: Network }) {
  const { snapshot } = useRealtime();
  const alerts = snapshot?.alerts ?? [];
  const detours = snapshot?.detours ?? [];

  if (!snapshot) return <EmptyState title="Loading service changes…" />;
  if (!alerts.length && !detours.length) {
    return <EmptyState title="No alerts or detours right now">RTA hasn’t published any service changes for today.</EmptyState>;
  }

  return (
    <div className="changes-list">
      {detours.map((detour) => {
        const routes = detour.routeIds.map((id) => network.routesById.get(id)).filter((route): route is NonNullable<typeof route> => Boolean(route));
        const skipped = [...new Set(Object.values(detour.skippedStops).flat())].map((id) => network.stopsById.get(id)).filter(Boolean);
        const directions = [...new Set(detour.patternIds.map((id) => network.patternsById.get(id)?.headsign).filter(Boolean))];
        return (
          <article key={detour.id} className="change">
            <header className="change__header">
              <Icon name="detour" />
              <span className="badges">
                {routes.map((route) => (
                  <RouteBadge key={route.id} route={route} size="sm" />
                ))}
              </span>
              <h2 className="change__title">Detour{directions.length ? ` toward ${directions.join(' and ')}` : ''}</h2>
            </header>
            {skipped.length > 0 && (
              <>
                <p className="change__label">Stops not served</p>
                <ul className="change__stops">
                  {skipped.map((stop) => (
                    <li key={stop!.id}>
                      <button type="button" className="text-button" onClick={() => navigate({ name: 'stop', stopId: stop!.id })}>
                        {stop!.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="change__meta">
              Affects {detour.tripIds.length} scheduled trips
              {detour.delayMinutes ? `, adding about ${detour.delayMinutes} min` : ''}.
              {routes[0] && (
                <>
                  {' '}
                  <button type="button" className="text-button" onClick={() => navigate({ name: 'route', routeId: routes[0]!.id, directionId: null })}>
                    See it on the map
                  </button>
                </>
              )}
            </p>
          </article>
        );
      })}

      {alerts.map((alert) => (
        <article key={alert.id} className="change">
          <header className="change__header">
            <Icon name="alert" />
            <span className="badges">
              {alert.routes.map((id) => network.routesById.get(id)).filter((route): route is NonNullable<typeof route> => Boolean(route)).map((route) => (
                <RouteBadge key={route.id} route={route} size="sm" />
              ))}
            </span>
            <h2 className="change__title">{alert.header || 'Service alert'}</h2>
          </header>
          {alert.description && <p className="change__body">{alert.description}</p>}
          {alert.periods[0]?.[1] && <p className="change__meta">Until {clockTime(alert.periods[0][1])}</p>}
          {alert.url && (
            <a className="text-button" href={alert.url} target="_blank" rel="noreferrer">
              More from RTA
            </a>
          )}
        </article>
      ))}
    </div>
  );
}

export function AboutHeader() {
  return <ViewHeader title={<h1 className="view-title">About</h1>} />;
}

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'Match device' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function AboutView({ network }: { network: Network }) {
  const preferences = usePreferences();
  const { feed, agency } = network;

  return (
    <div className="prose">
      <p>
        Transit Live shows where New Orleans RTA buses, streetcars and ferries are right now, and when the next one reaches your stop. It is an independent project and
        is not run by RTA.
      </p>

      <h2>Where the times come from</h2>
      <p>
        Times marked with <span className="inline-live">the live symbol</span> are RTA’s own predictions, built from each vehicle’s reported position. Everything else is
        the published timetable. When live data stops updating, the app switches back to the timetable and says so, rather than showing old predictions as current.
      </p>
      <p>
        Canceled trips and stops skipped by a detour stay in the list, marked, so you know not to wait for them.
      </p>

      <h2>Data</h2>
      <dl className="facts facts--stacked">
        <div>
          <dt>Timetable</dt>
          <dd>
            RTA GTFS {feed.version}, valid {formatDate(feed.startDate)} to {formatDate(feed.endDate)}
          </dd>
        </div>
        <div>
          <dt>Live data</dt>
          <dd>RTA GTFS-realtime: vehicle positions, trip updates, alerts and detours</dd>
        </div>
        <div>
          <dt>Map</dt>
          <dd>OpenFreeMap, OpenMapTiles and OpenStreetMap contributors</dd>
        </div>
      </dl>

      <h2>Appearance</h2>
      <div className="segmented" role="radiogroup" aria-label="Theme">
        {THEMES.map((theme) => (
          <button
            key={theme.value}
            type="button"
            role="radio"
            aria-checked={preferences.theme === theme.value}
            className="segmented__option"
            onClick={() => setTheme(theme.value)}
          >
            {theme.label}
          </button>
        ))}
      </div>

      <h2>Contact RTA</h2>
      <p>
        For lost items, fares or complaints, contact RTA directly{agency.phone ? ` at ` : ''}
        {agency.phone && <a href={`tel:${agency.phone.replace(/[^0-9+]/g, '')}`}>{agency.phone}</a>} or{' '}
        <a href={agency.url} target="_blank" rel="noreferrer">
          norta.com
        </a>
        .
      </p>
      {agency.fare && (
        <p>
          A standard fare is ${agency.fare.price.toFixed(2)}
          {agency.fare.transferMinutes ? `, with transfers for ${agency.fare.transferMinutes / 60} hours` : ''}. Check{' '}
          <a href={agency.fareUrl || agency.url} target="_blank" rel="noreferrer">
            RTA fares
          </a>{' '}
          for passes and reduced fares.
        </p>
      )}
    </div>
  );
}
