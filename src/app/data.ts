/**
 * Static data: the network (loaded at startup) and per-pattern timetables
 * (loaded on demand, cached for the session).
 *
 * Every file carries the GTFS feed version it was built from. When RTA's
 * timetable changes, a returning rider can briefly hold a cached network.json
 * from the old feed while the server already has the new one. Mixing the two
 * puts times on the wrong stops, so any mismatch — a timetable file or the
 * realtime API reporting a different version — reloads the network fresh and
 * drops everything cached from the old version.
 */

import { useEffect } from 'react';
import type { NetworkFile, ScheduleFile } from '../../shared/types.ts';
import { NETWORK_FORMAT_VERSION } from '../../shared/types.ts';
import { indexNetwork, type Network } from '../lib/network.ts';
import { createStore, useStore } from './store.ts';

const BASE = import.meta.env.BASE_URL;

export type NetworkState =
  | { status: 'loading' }
  | { status: 'ready'; network: Network }
  | { status: 'error'; message: string };

export const networkStore = createStore<NetworkState>({ status: 'loading' });

/** Version pairs we have already reloaded for, so a persistent mismatch cannot loop. */
const reloadedFor = new Set<string>();

export async function loadNetwork(options: { fresh?: boolean } = {}): Promise<void> {
  const previous = networkStore.get();
  if (previous.status !== 'ready') networkStore.set({ status: 'loading' });

  try {
    // A fresh load uses a distinct URL so neither the HTTP cache nor the
    // service worker can answer it with the old file.
    const url = `${BASE}data/network.json${options.fresh ? `?fresh=${Date.now()}` : ''}`;
    const response = await fetch(url, options.fresh ? { cache: 'reload' } : undefined);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const file = (await response.json()) as NetworkFile;
    if (file.format !== NETWORK_FORMAT_VERSION) throw new Error('Unexpected data format');

    if (previous.status === 'ready' && previous.network.feed.version !== file.feed.version) {
      resetSchedules();
    }
    networkStore.set({ status: 'ready', network: indexNetwork(file) });
  } catch (error) {
    console.error('Network load failed', error);
    // Keep showing what we have if this was a background refresh.
    if (previous.status === 'ready') return;
    networkStore.set({
      status: 'error',
      message: navigator.onLine
        ? 'The route map could not be loaded.'
        : 'You are offline and the route map has not been saved on this device yet.',
    });
  }
}

/** Called when another file reports a different feed version than the network. */
export function noteFeedVersion(version: string) {
  const state = networkStore.get();
  if (state.status !== 'ready' || state.network.feed.version === version) return;
  const key = `${state.network.feed.version}->${version}`;
  if (reloadedFor.has(key)) return;
  reloadedFor.add(key);
  void loadNetwork({ fresh: true });
}

export function useNetwork(): Network | null {
  const state = useStore(networkStore);
  return state.status === 'ready' ? state.network : null;
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

const schedules = new Map<string, ScheduleFile>();
const pending = new Map<string, Promise<void>>();
const failed = new Set<string>();
const scheduleVersion = createStore(0);
const MAX_ATTEMPTS = 3;

function currentFeedVersion(): string | null {
  const state = networkStore.get();
  return state.status === 'ready' ? state.network.feed.version : null;
}

function resetSchedules() {
  schedules.clear();
  pending.clear();
  failed.clear();
  scheduleVersion.set((version) => version + 1);
}

function fetchSchedule(patternId: string, attempt = 1): Promise<void> {
  const existing = pending.get(patternId);
  if (existing) return existing;

  const version = currentFeedVersion();
  const request = fetch(`${BASE}data/schedules/${encodeURIComponent(patternId)}.json?v=${encodeURIComponent(version ?? '')}`)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json() as Promise<ScheduleFile>;
    })
    .then((file) => {
      pending.delete(patternId);
      if (file.feedVersion !== currentFeedVersion()) {
        noteFeedVersion(file.feedVersion);
        return;
      }
      schedules.set(patternId, file);
      failed.delete(patternId);
      scheduleVersion.set((value) => value + 1);
    })
    .catch((error: unknown) => {
      pending.delete(patternId);
      console.warn(`Schedule ${patternId} failed to load (attempt ${attempt})`, error);
      if (attempt < MAX_ATTEMPTS) {
        setTimeout(() => void fetchSchedule(patternId, attempt + 1), 2000 * attempt);
      } else {
        failed.add(patternId);
        scheduleVersion.set((value) => value + 1);
      }
    });

  pending.set(patternId, request);
  return request;
}

/** Try every failed timetable again, e.g. from a "Try again" button. */
export function retrySchedules(patternIds: readonly string[]) {
  patternIds
    .filter((id) => failed.has(id))
    .forEach((id) => {
      failed.delete(id);
      void fetchSchedule(id);
    });
  scheduleVersion.set((value) => value + 1);
}

/**
 * Timetables for the given patterns. Returns whatever has loaded so far and
 * re-renders as the rest arrive, so the screen fills in rather than waiting.
 */
export function useSchedules(patternIds: readonly string[]): {
  schedules: ReadonlyMap<string, ScheduleFile>;
  loading: boolean;
  /** Some timetables could not be downloaded after retrying. */
  failed: boolean;
  /** Changes whenever another timetable arrives; use it as a memo dependency. */
  version: number;
} {
  const version = useStore(scheduleVersion);
  const key = patternIds.join('|');

  useEffect(() => {
    patternIds.filter((id) => !schedules.has(id) && !failed.has(id)).forEach((id) => void fetchSchedule(id));
    // patternIds is represented by key; version re-runs this after a data reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  return {
    schedules,
    loading: patternIds.some((id) => !schedules.has(id) && !failed.has(id)),
    failed: patternIds.some((id) => failed.has(id)),
    version,
  };
}
