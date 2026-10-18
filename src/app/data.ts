/**
 * Static data: the network (loaded once at startup) and per-pattern
 * timetables (loaded on demand, cached for the session).
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

export async function loadNetwork(): Promise<void> {
  networkStore.set({ status: 'loading' });
  try {
    const response = await fetch(`${BASE}data/network.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const file = (await response.json()) as NetworkFile;
    if (file.format !== NETWORK_FORMAT_VERSION) throw new Error('Unexpected data format');
    networkStore.set({ status: 'ready', network: indexNetwork(file) });
  } catch (error) {
    networkStore.set({
      status: 'error',
      message: navigator.onLine
        ? 'The route map could not be loaded.'
        : 'You are offline and the route map has not been saved on this device yet.',
    });
    console.error('Network load failed', error);
  }
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
const scheduleVersion = createStore(0);

function fetchSchedule(patternId: string): Promise<void> {
  let request = pending.get(patternId);
  if (!request) {
    request = fetch(`${BASE}data/schedules/${encodeURIComponent(patternId)}.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<ScheduleFile>;
      })
      .then((file) => {
        schedules.set(patternId, file);
        scheduleVersion.set((version) => version + 1);
      })
      .catch((error: unknown) => {
        // Allow a retry next time the pattern is needed.
        pending.delete(patternId);
        console.warn(`Schedule ${patternId} failed to load`, error);
      });
    pending.set(patternId, request);
  }
  return request;
}

/**
 * Timetables for the given patterns. Returns whatever has loaded so far and
 * re-renders as the rest arrive, so the screen fills in rather than waiting.
 */
export function useSchedules(patternIds: readonly string[]): {
  schedules: ReadonlyMap<string, ScheduleFile>;
  loading: boolean;
  /** Changes whenever another timetable arrives; use it as a memo dependency. */
  version: number;
} {
  const version = useStore(scheduleVersion);
  const key = patternIds.join('|');

  useEffect(() => {
    // Each arrival bumps scheduleVersion, which re-renders subscribers.
    patternIds.filter((id) => !schedules.has(id)).forEach(fetchSchedule);
    // patternIds is represented by key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { schedules, loading: patternIds.some((id) => !schedules.has(id)), version };
}
