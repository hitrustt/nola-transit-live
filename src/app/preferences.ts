/**
 * Things a rider sets once and expects to persist on this device: saved
 * stops and routes, and the colour theme. Stored in localStorage, which can
 * be unavailable (private mode, blocked storage) — every access is guarded
 * and the app works without it.
 */

import { createStore, useStore } from './store.ts';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface Preferences {
  savedStops: string[];
  savedRoutes: string[];
  theme: ThemePreference;
}

const KEY = 'nola-transit-live:preferences:v1';
const DEFAULTS: Preferences = { savedStops: [], savedRoutes: [], theme: 'system' };

function read(): Preferences {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Preferences>;
    return {
      savedStops: Array.isArray(parsed.savedStops) ? parsed.savedStops.filter((id) => typeof id === 'string') : [],
      savedRoutes: Array.isArray(parsed.savedRoutes) ? parsed.savedRoutes.filter((id) => typeof id === 'string') : [],
      theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system',
    };
  } catch {
    return DEFAULTS;
  }
}

export const preferencesStore = createStore<Preferences>(typeof window === 'undefined' ? DEFAULTS : read());

preferencesStore.subscribe(() => {
  try {
    localStorage.setItem(KEY, JSON.stringify(preferencesStore.get()));
  } catch {
    // Storage full or blocked: preferences last for this session only.
  }
});

// Keep several open tabs in sync.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === KEY) preferencesStore.set(read());
  });
}

export function usePreferences(): Preferences {
  return useStore(preferencesStore);
}

export function toggleSavedStop(stopId: string) {
  preferencesStore.set((current) => ({
    ...current,
    savedStops: current.savedStops.includes(stopId)
      ? current.savedStops.filter((id) => id !== stopId)
      : [stopId, ...current.savedStops],
  }));
}

export function toggleSavedRoute(routeId: string) {
  preferencesStore.set((current) => ({
    ...current,
    savedRoutes: current.savedRoutes.includes(routeId)
      ? current.savedRoutes.filter((id) => id !== routeId)
      : [routeId, ...current.savedRoutes],
  }));
}

export function setTheme(theme: ThemePreference) {
  preferencesStore.set((current) => ({ ...current, theme }));
}
