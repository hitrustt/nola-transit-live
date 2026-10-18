import { useId, useState } from 'react';
import { navigate } from '../app/router.ts';
import type { Departure } from '../lib/arrivals.ts';
import { clockTime, countdown, delayLabel } from '../lib/format.ts';
import type { Route } from '../lib/network.ts';
import { LiveMark } from './Icon.tsx';
import { RouteBadge } from './RouteBadge.tsx';

export interface DepartureGroup {
  key: string;
  route: Route;
  headsign: string;
  departures: Departure[];
}

/** One group per route and destination, ordered by the next usable departure. */
export function groupDepartures(departures: Departure[]): DepartureGroup[] {
  const groups = new Map<string, DepartureGroup>();
  for (const departure of departures) {
    const key = `${departure.route.id}|${departure.headsign}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, route: departure.route, headsign: departure.headsign, departures: [] };
      groups.set(key, group);
    }
    group.departures.push(departure);
  }
  const nextUsable = (group: DepartureGroup) =>
    group.departures.find((departure) => departure.status === 'live' || departure.status === 'scheduled')?.time ?? Infinity;
  return [...groups.values()].sort((a, b) => nextUsable(a) - nextUsable(b) || a.route.order - b.route.order);
}

export function DepartureBoard({ departures, now, live }: { departures: Departure[]; now: number; live: boolean }) {
  const groups = groupDepartures(departures);
  return (
    <ul className="board" aria-label="Departures">
      {groups.map((group) => (
        <DepartureGroupRow key={group.key} group={group} now={now} live={live} />
      ))}
    </ul>
  );
}

function DepartureGroupRow({ group, now, live }: { group: DepartureGroup; now: number; live: boolean }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const usable = group.departures.filter((departure) => departure.status === 'live' || departure.status === 'scheduled');
  const first = usable[0];
  const later = usable.slice(1, 3);
  const disruptions = group.departures.filter((departure) => departure.status === 'canceled' || departure.status === 'skipped');
  const nextDisruption = disruptions.find((departure) => !first || departure.time <= (later.at(-1)?.time ?? first.time));

  return (
    <li className="board__group">
      <button
        type="button"
        className="board__summary"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <RouteBadge route={group.route} />
        <span className="board__destination">
          <span className="board__headsign">{group.headsign}</span>
          <span className="board__detail">
            {first ? <StatusLine departure={first} live={live} /> : <span>No more departures in the next 3 hours</span>}
            {later.length > 0 && (
              <span className="board__later">
                Then {later.map((departure) => shortTime(departure, now)).join(' and ')}
              </span>
            )}
          </span>
          {nextDisruption && (
            <span className={`board__flag board__flag--${nextDisruption.status}`}>
              {nextDisruption.status === 'canceled'
                ? `${clockTime(nextDisruption.scheduled ?? nextDisruption.time)} trip canceled`
                : `${clockTime(nextDisruption.time)} trip skips this stop (detour)`}
            </span>
          )}
        </span>
        {first && <BigTime departure={first} now={now} live={live} />}
      </button>

      <div id={panelId} hidden={!open} className="board__trips">
        <ol>
          {group.departures.slice(0, 8).map((departure) => (
            <TripRow key={departure.key} departure={departure} now={now} live={live} />
          ))}
        </ol>
      </div>
    </li>
  );
}

function BigTime({ departure, now, live }: { departure: Departure; now: number; live: boolean }) {
  const time = countdown(departure.time, now);
  const isLive = live && departure.status === 'live';
  return (
    <span className={`time ${isLive ? 'time--live' : 'time--scheduled'}`} aria-label={`${isLive ? 'Live' : 'Scheduled'}, ${time.spoken}`}>
      {isLive && <LiveMark />}
      <span className="time__value">{time.value}</span>
      {time.unit && <span className="time__unit">{time.unit}</span>}
    </span>
  );
}

function StatusLine({ departure, live }: { departure: Departure; live: boolean }) {
  if (departure.status === 'live' && live) {
    const delay = delayLabel(departure.delaySeconds);
    return (
      <span className={`status status--${delay?.tone ?? 'on-time'}`}>
        {departure.scheduled === null ? 'Extra trip' : delay ? delay.text : 'Live'}
        {departure.detoured && ', on detour'}
      </span>
    );
  }
  return (
    <span className="status status--scheduled">
      Scheduled{departure.detoured && ', on detour'}
    </span>
  );
}

function TripRow({ departure, now, live }: { departure: Departure; now: number; live: boolean }) {
  const time = countdown(departure.time, now);
  const isLive = live && departure.status === 'live';
  const struck = departure.status === 'canceled' || departure.status === 'skipped';

  const content = (
    <>
      <span className={`trip__clock ${struck ? 'is-struck' : ''}`}>{clockTime(departure.time)}</span>
      <span className="trip__status">
        {departure.status === 'canceled' && 'Canceled'}
        {departure.status === 'skipped' && 'Skips this stop'}
        {departure.status === 'scheduled' && 'Scheduled'}
        {departure.status === 'live' && (live ? (delayLabel(departure.delaySeconds)?.text ?? 'Live') : 'Scheduled')}
      </span>
      {!struck && (
        <span className={`trip__countdown ${isLive ? 'is-live' : ''}`}>
          {isLive && <LiveMark />}
          {time.value}
          {time.unit && time.unit !== 'PM' && time.unit !== 'AM' ? ` ${time.unit}` : ''}
        </span>
      )}
    </>
  );

  if (departure.vehicleId && !struck) {
    return (
      <li>
        <button type="button" className="trip trip--link" onClick={() => navigate({ name: 'vehicle', vehicleId: departure.vehicleId! })}>
          {content}
          <span className="visually-hidden">Show this {departure.route.mode} on the map</span>
        </button>
      </li>
    );
  }

  return (
    <li>
      <div className="trip">{content}</div>
    </li>
  );
}

function shortTime(departure: Departure, now: number): string {
  const time = countdown(departure.time, now);
  if (time.value === 'Due') return 'now';
  return time.unit === 'min' ? `${time.value} min` : `${time.value} ${time.unit}`;
}
