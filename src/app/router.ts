/**
 * Path routing. Every screen has a real URL so it can be bookmarked, shared
 * or saved to a home screen:
 *
 *   /                      home
 *   /stop/1047             a stop's departures
 *   /route/12?dir=1        a route, one direction
 *   /vehicle/351           a vehicle's trip
 *   /alerts                service alerts and detours
 *   /about                 data sources and accuracy
 *
 * Links from the old version (?route=12&dir=0&stop=1047) are redirected.
 */

import { createStore, useStore } from './store.ts';

export type View =
  | { name: 'home' }
  | { name: 'stop'; stopId: string }
  | { name: 'route'; routeId: string; directionId: number | null }
  | { name: 'vehicle'; vehicleId: string }
  | { name: 'alerts' }
  | { name: 'about' };

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export function parseLocation(pathname: string, search: string): View {
  const path = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  const params = new URLSearchParams(search);
  const [, section, id] = path.split('/').map(safeDecode);

  if (section === 'stop' && id) return { name: 'stop', stopId: id };
  if (section === 'route' && id) {
    const dir = params.get('dir');
    return { name: 'route', routeId: id, directionId: dir === null ? null : Number(dir) };
  }
  if (section === 'vehicle' && id) return { name: 'vehicle', vehicleId: id };
  if (section === 'alerts') return { name: 'alerts' };
  if (section === 'about') return { name: 'about' };

  // Legacy query-string links.
  if (params.get('stop')) return { name: 'stop', stopId: params.get('stop')! };
  if (params.get('route')) {
    const dir = params.get('dir');
    return { name: 'route', routeId: params.get('route')!, directionId: dir === null ? null : Number(dir) };
  }

  return { name: 'home' };
}

/** A truncated or hand-edited link must not throw before the app renders. */
function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

export function viewToPath(view: View): string {
  switch (view.name) {
    case 'stop':
      return `${BASE}/stop/${encodeURIComponent(view.stopId)}`;
    case 'route':
      return `${BASE}/route/${encodeURIComponent(view.routeId)}${view.directionId === null ? '' : `?dir=${view.directionId}`}`;
    case 'vehicle':
      return `${BASE}/vehicle/${encodeURIComponent(view.vehicleId)}`;
    case 'alerts':
      return `${BASE}/alerts`;
    case 'about':
      return `${BASE}/about`;
    default:
      return `${BASE}/`;
  }
}

export const viewStore = createStore<View>(
  typeof window === 'undefined' ? { name: 'home' } : parseLocation(location.pathname, location.search),
);

/** Depth of in-app history, so Back can leave the app only from the first screen. */
let depth = 0;

export function navigate(view: View, options: { replace?: boolean } = {}) {
  const path = viewToPath(view);
  if (options.replace) {
    history.replaceState({ depth }, '', path);
  } else if (path !== location.pathname + location.search) {
    depth += 1;
    history.pushState({ depth }, '', path);
  }
  viewStore.set(view);
}

/** In-app back: pop history if we pushed, otherwise go home. */
export function goBack() {
  if (depth > 0) history.back();
  else navigate({ name: 'home' }, { replace: true });
}

export function startRouter() {
  const initial = parseLocation(location.pathname, location.search);
  // Normalise legacy links in the address bar.
  history.replaceState({ depth: 0 }, '', viewToPath(initial));
  viewStore.set(initial);

  window.addEventListener('popstate', (event) => {
    depth = (event.state as { depth?: number } | null)?.depth ?? 0;
    viewStore.set(parseLocation(location.pathname, location.search));
  });
}

export function useView(): View {
  return useStore(viewStore);
}
