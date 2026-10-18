import { useState, type ReactNode } from 'react';
import type { RealtimeAlert, RealtimeDetour } from '../../shared/types.ts';
import { useNow, useRealtime, useVehicles } from '../app/hooks.ts';
import { isFresh, refreshRealtime } from '../app/realtime.ts';
import { goBack, navigate } from '../app/router.ts';
import { ago, clockTime, vehicleCountLabel } from '../lib/format.ts';
import type { Network } from '../lib/network.ts';
import { localDate } from '../lib/time.ts';
import { Icon, type IconName } from './Icon.tsx';
import { RouteBadge } from './RouteBadge.tsx';

export function ViewHeader({ title, children, actions }: { title?: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="view-header">
      <div className="view-header__bar">
        <button type="button" className="icon-button" onClick={goBack} aria-label="Back">
          <Icon name="back" />
        </button>
        {title && <div className="view-header__title">{title}</div>}
        {actions && <div className="view-header__actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function IconToggle({ icon, label, pressed, onClick }: { icon: IconName; label: string; pressed?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`icon-button${pressed ? ' is-on' : ''}`} aria-pressed={pressed} aria-label={label} title={label} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

/** Share via the system sheet where available, otherwise copy the link. */
export function ShareButton({ title }: { title: string }) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const url = location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Dismissed share sheet or blocked clipboard: nothing to report.
    }
  };
  return (
    <button type="button" className="icon-button" onClick={share} aria-label={copied ? 'Link copied' : 'Share'} title={copied ? 'Link copied' : 'Share'}>
      <Icon name="share" />
      <span className="visually-hidden" aria-live="polite">
        {copied ? 'Link copied' : ''}
      </span>
    </button>
  );
}

/** Data freshness, always visible: riders deserve to know how old a time is. */
export function LiveStatus({ network }: { network: Network }) {
  const realtime = useRealtime();
  const vehicles = useVehicles();
  const now = useNow(5_000);
  const fresh = isFresh(realtime, now);
  const expired = localDate(now) > network.feed.endDate;
  const mismatch = realtime.snapshot && realtime.snapshot.tripMatchRate < 0.6;

  const counts = { bus: 0, streetcar: 0, ferry: 0 };
  vehicles.forEach((vehicle) => {
    counts[vehicle.route.mode] += 1;
  });

  let tone: 'live' | 'warn' | 'idle' = 'live';
  let message: ReactNode;

  if (realtime.offline) {
    tone = 'warn';
    message = 'You’re offline. Times shown are scheduled.';
  } else if (!realtime.snapshot && !realtime.error) {
    tone = 'idle';
    message = 'Connecting to live data…';
  } else if (!fresh) {
    tone = 'warn';
    message = realtime.confirmedAt
      ? `Live data stopped updating ${ago(realtime.confirmedAt, now)}. Times shown are scheduled.`
      : `${realtime.error ?? 'Live data is unavailable.'} Times shown are scheduled.`;
  } else {
    message = (
      <>
        <span className="live-status__lead">Live</span> updated {ago(realtime.confirmedAt!, now)}. {vehicleCountLabel(counts)} reporting.
      </>
    );
  }

  return (
    <div className={`live-status live-status--${tone}`} role="status" aria-live="polite">
      <span className="live-status__dot" aria-hidden="true" />
      <span className="live-status__text">{message}</span>
      {tone === 'warn' && !realtime.offline && (
        <button type="button" className="text-button" onClick={refreshRealtime}>
          Retry
        </button>
      )}
      {(expired || mismatch) && (
        <p className="live-status__schedule">
          {expired
            ? `The timetable in this app ended on ${formatDate(network.feed.endDate)}. Scheduled times may be wrong.`
            : 'Many live trips are missing from this app’s timetable. It may be out of date.'}
        </p>
      )}
    </div>
  );
}

export function DetourNotice({ network, detours, stopId }: { network: Network; detours: RealtimeDetour[]; stopId?: string }) {
  if (!detours.length) return null;
  const routes = [...new Set(detours.flatMap((detour) => detour.routeIds))]
    .map((id) => network.routesById.get(id))
    .filter((route): route is NonNullable<typeof route> => Boolean(route));
  const skipsHere = stopId ? detours.some((detour) => Object.values(detour.skippedStops).some((stops) => stops.includes(stopId))) : false;
  const skipped = [...new Set(detours.flatMap((detour) => Object.values(detour.skippedStops).flat()))]
    .map((id) => network.stopsById.get(id)?.name)
    .filter(Boolean);

  return (
    <section className="notice notice--detour" aria-label="Detour">
      <Icon name="detour" className="notice__icon" />
      <div>
        <p className="notice__title">
          {skipsHere ? 'Some trips skip this stop' : routes.length === 1 ? `Route ${routes[0]!.shortName} is on detour` : 'Detours in effect'}
        </p>
        <p className="notice__body">
          {skipsHere
            ? `${routes.map((route) => route.shortName).join(', ')} trips on detour don’t stop here. Their times are marked below.`
            : skipped.length
              ? `Not served: ${skipped.slice(0, 4).join('; ')}${skipped.length > 4 ? `, and ${skipped.length - 4} more` : ''}.`
              : 'Some trips run a different path.'}
        </p>
        <button type="button" className="text-button" onClick={() => navigate({ name: 'alerts' })}>
          Detour details
        </button>
      </div>
    </section>
  );
}

export function AlertNotice({ alerts }: { alerts: RealtimeAlert[] }) {
  if (!alerts.length) return null;
  return (
    <>
      {alerts.slice(0, 2).map((alert) => (
        <section key={alert.id} className="notice notice--alert" aria-label="Service alert">
          <Icon name="alert" className="notice__icon" />
          <div>
            <p className="notice__title">{alert.header || 'Service alert'}</p>
            {alert.description && <p className="notice__body">{truncate(alert.description, 220)}</p>}
            {alerts.length > 2 && (
              <button type="button" className="text-button" onClick={() => navigate({ name: 'alerts' })}>
                All {alerts.length} alerts
              </button>
            )}
          </div>
        </section>
      ))}
    </>
  );
}

export function RouteBadges({ network, routeIds, limit = 8 }: { network: Network; routeIds: string[]; limit?: number }) {
  const routes = routeIds.map((id) => network.routesById.get(id)).filter((route): route is NonNullable<typeof route> => Boolean(route));
  return (
    <span className="badges">
      {routes.slice(0, limit).map((route) => (
        <RouteBadge key={route.id} route={route} size="sm" />
      ))}
      {routes.length > limit && <span className="badges__more">+{routes.length - limit}</span>}
    </span>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty__title">{title}</p>
      {children && <div className="empty__body">{children}</div>}
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton__row" />
      ))}
    </div>
  );
}

export function formatDate(yyyymmdd: string): string {
  const date = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8), 12));
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
}

export { clockTime };
