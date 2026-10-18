import { useEffect, useMemo, useState } from 'react';
import type { RealtimeAlert, RealtimeDetour } from '../../shared/types.ts';
import { departuresForStop, type Departure } from '../lib/arrivals.ts';
import type { Network } from '../lib/network.ts';
import { trackVehicles, type TrackedVehicle } from '../lib/vehicles.ts';
import { useSchedules } from './data.ts';
import { isFresh, realtimeStore, serverNow } from './realtime.ts';
import { createStore, useStore } from './store.ts';

/** Server-corrected "now", re-rendering every `intervalMs`, aligned to the interval. */
export function useNow(intervalMs = 10_000): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      setNow(serverNow());
      timer = setTimeout(tick, intervalMs - (Date.now() % intervalMs));
    };
    timer = setTimeout(tick, intervalMs - (Date.now() % intervalMs));
    return () => clearTimeout(timer);
  }, [intervalMs]);
  return now;
}

export function useRealtime() {
  return useStore(realtimeStore);
}

// ---------------------------------------------------------------------------
// Vehicles: tracked once per snapshot, shared by map and panels.
// ---------------------------------------------------------------------------

export interface VehicleFrame {
  vehicles: Map<string, TrackedVehicle>;
  previous: Map<string, TrackedVehicle>;
  /** Client time the frame was produced, for animation. */
  at: number;
}

export const vehicleStore = createStore<VehicleFrame>({ vehicles: new Map(), previous: new Map(), at: 0 });

let trackedFor: unknown = null;

/** Recompute tracked vehicles when a new snapshot arrives. */
export function syncVehicles(network: Network) {
  const { snapshot } = realtimeStore.get();
  if (!snapshot || snapshot === trackedFor) return;
  trackedFor = snapshot;
  const current = vehicleStore.get().vehicles;
  vehicleStore.set({ vehicles: trackVehicles(network, snapshot, current), previous: current, at: performance.now() });
}

export function useVehicles(): Map<string, TrackedVehicle> {
  return useStore(vehicleStore).vehicles;
}

export function useVehicleSync(network: Network | null) {
  const realtime = useRealtime();
  useEffect(() => {
    if (network) syncVehicles(network);
  }, [network, realtime.snapshot]);
}

// ---------------------------------------------------------------------------
// Departures
// ---------------------------------------------------------------------------

export interface DepartureBoard {
  departures: Departure[];
  loading: boolean;
  /** Realtime is current enough to trust "live" labels. */
  live: boolean;
}

export function useDepartures(network: Network, stopId: string, horizonMs?: number): DepartureBoard {
  const patternIds = useMemo(
    () => [...new Set((network.visitsByStop.get(stopId) ?? []).map((visit) => visit.pattern.id))],
    [network, stopId],
  );
  const { schedules, loading, version } = useSchedules(patternIds);
  const realtime = useRealtime();
  const now = useNow(10_000);
  const live = isFresh(realtime, now);

  const departures = useMemo(
    // A stale snapshot's predictions are worse than the timetable: drop them.
    () => departuresForStop(network, stopId, schedules, live ? realtime.snapshot : null, now, { horizonMs }),
    // `schedules` is one shared Map filled in place; `version` marks each arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [network, stopId, version, realtime.snapshot, live, now, horizonMs],
  );

  return { departures, loading, live };
}

// ---------------------------------------------------------------------------
// Alerts and detours relevant to a route or stop
// ---------------------------------------------------------------------------

export function useServiceChanges(filter: { routeId?: string; stopId?: string; routeIds?: string[] } = {}) {
  const { snapshot } = useRealtime();
  return useMemo(() => {
    const routeIds = new Set([...(filter.routeIds ?? []), ...(filter.routeId ? [filter.routeId] : [])]);
    const matchesRoute = (ids: string[]) => !routeIds.size || ids.some((id) => routeIds.has(id));

    const alerts: RealtimeAlert[] = (snapshot?.alerts ?? []).filter(
      (alert) =>
        (!filter.stopId && !routeIds.size) ||
        (filter.stopId && alert.stops.includes(filter.stopId)) ||
        (routeIds.size && matchesRoute(alert.routes)) ||
        (!alert.routes.length && !alert.stops.length),
    );

    const detours: RealtimeDetour[] = (snapshot?.detours ?? []).filter(
      (detour) =>
        matchesRoute(detour.routeIds) &&
        (!filter.stopId || Object.values(detour.skippedStops).some((stops) => stops.includes(filter.stopId!)) || !!routeIds.size),
    );

    return { alerts, detours };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, filter.routeId, filter.stopId, filter.routeIds?.join('|')]);
}
