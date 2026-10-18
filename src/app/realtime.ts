/**
 * Polls /api/realtime and keeps the latest snapshot plus enough status for
 * the UI to be honest about freshness.
 *
 *  - Polls every 15 s while the page is visible; stops when hidden and
 *    catches up immediately on return.
 *  - Sends If-None-Match so an unchanged feed costs a 304.
 *  - Backs off exponentially on failure (15 s → 2 min) and retries at once
 *    when the device comes back online.
 *  - Never throws away a good snapshot because one poll failed; the UI shows
 *    its age instead.
 */

import type { RealtimeSnapshot } from '../../shared/types.ts';
import { REALTIME_FORMAT_VERSION } from '../../shared/types.ts';
import { noteFeedVersion } from './data.ts';
import { createStore } from './store.ts';

export const POLL_INTERVAL_MS = 15_000;
const MAX_BACKOFF_MS = 2 * 60_000;
/** Older than this and predictions are shown as no longer live. */
export const STALE_AFTER_MS = 90_000;
/**
 * NORTA's feed header normally advances every 30 s or so. If it has not moved
 * in this long the feed itself is frozen, even though every poll succeeds.
 */
export const FEED_FROZEN_AFTER_MS = 3 * 60_000;
const REQUEST_TIMEOUT_MS = 12_000;

export interface RealtimeState {
  snapshot: RealtimeSnapshot | null;
  /**
   * Server time at which the snapshot was last confirmed current: its
   * fetchedAt, or the time of a later 304 that said nothing had changed.
   */
  confirmedAt: number | null;
  /** Client clock minus server clock, so countdowns ignore a wrong phone clock. */
  clockSkewMs: number;
  error: string | null;
  offline: boolean;
  /** True while the server is serving its cached copy because NORTA is down. */
  upstreamStale: boolean;
}

export const realtimeStore = createStore<RealtimeState>({
  snapshot: null,
  confirmedAt: null,
  clockSkewMs: 0,
  error: null,
  offline: typeof navigator !== 'undefined' ? !navigator.onLine : false,
  upstreamStale: false,
});

const ENDPOINT = `${import.meta.env.BASE_URL}api/realtime`;

let timer: ReturnType<typeof setTimeout> | null = null;
let controller: AbortController | null = null;
let etag: string | null = null;
let failures = 0;
let started = false;

async function poll() {
  clearTimer();
  if (document.visibilityState === 'hidden') return;

  controller?.abort();
  const current = new AbortController();
  controller = current;
  const requestedAt = Date.now();
  // The next poll is scheduled only when this one ends, so a request stalled
  // on a bad mobile connection must not be allowed to hang for minutes.
  const timeout = setTimeout(
    () => current.abort(new DOMException('The live data request timed out.', 'TimeoutError')),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(ENDPOINT, {
      headers: etag ? { 'If-None-Match': etag } : {},
      cache: 'no-store',
      signal: current.signal,
    });

    const receivedAt = Date.now();
    const serverDate = Date.parse(response.headers.get('Date') ?? '');
    const stale = response.headers.get('X-Stale') === '1';

    if (response.status === 304) {
      failures = 0;
      realtimeStore.set((state) => ({
        ...state,
        // A stale 304 confirms nothing new; a fresh one means the feed is current now.
        confirmedAt: stale ? state.confirmedAt : Number.isFinite(serverDate) ? serverDate : receivedAt - state.clockSkewMs,
        error: null,
        offline: false,
        upstreamStale: stale,
      }));
      schedule(POLL_INTERVAL_MS);
      return;
    }

    if (!response.ok) {
      throw new Error(response.status >= 500 ? 'NORTA’s live feed is not responding.' : `Live data request failed (${response.status}).`);
    }

    const snapshot = (await response.json()) as RealtimeSnapshot;
    if (snapshot.format !== REALTIME_FORMAT_VERSION) throw new Error('Live data is in an unexpected format.');

    etag = response.headers.get('ETag');
    failures = 0;
    // The phone's clock can be minutes off; predictions are server time.
    // The Date header is the edge's clock at response time.
    const skew = Number.isFinite(serverDate) ? (requestedAt + receivedAt) / 2 - serverDate : 0;

    realtimeStore.set({
      snapshot,
      confirmedAt: snapshot.fetchedAt,
      clockSkewMs: Math.abs(skew) > 5_000 ? skew : 0,
      error: null,
      offline: false,
      upstreamStale: stale,
    });
    // The server resolves trips against its own timetable; if that differs
    // from ours, ours is out of date (or theirs is) and must be reloaded.
    noteFeedVersion(snapshot.staticVersion);
    schedule(POLL_INTERVAL_MS);
  } catch (error) {
    // Aborted because the tab was hidden or a newer poll started: not a failure.
    if ((error as Error).name === 'AbortError') return;
    failures += 1;
    realtimeStore.set((state) => ({
      ...state,
      offline: !navigator.onLine,
      error: navigator.onLine ? ((error as Error).message || 'Live data is unavailable.') : null,
    }));
    schedule(Math.min(POLL_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS));
  } finally {
    clearTimeout(timeout);
  }
}

function schedule(delay: number) {
  clearTimer();
  timer = setTimeout(poll, delay);
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

export function startRealtime() {
  if (started) return;
  started = true;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
    else {
      clearTimer();
      controller?.abort();
    }
  });
  window.addEventListener('online', () => {
    realtimeStore.set((state) => ({ ...state, offline: false }));
    failures = 0;
    poll();
  });
  window.addEventListener('offline', () => realtimeStore.set((state) => ({ ...state, offline: true })));

  poll();
}

/** Retry now, e.g. from an error banner's button. */
export function refreshRealtime() {
  failures = 0;
  poll();
}

/** Current time on the server's clock, correcting for a wrong phone clock. */
export function serverNow(state: RealtimeState = realtimeStore.get()): number {
  return Date.now() - state.clockSkewMs;
}

/** NORTA is answering, but its feed has stopped advancing. */
export function isFeedFrozen(state: RealtimeState, now = serverNow(state)): boolean {
  return Boolean(state.snapshot) && now - state.snapshot!.feedTime > FEED_FROZEN_AFTER_MS;
}

/** Trip updates (predictions) are missing from the latest snapshot. */
export function predictionsMissing(state: RealtimeState): boolean {
  return Boolean(state.snapshot?.degraded.includes('trips'));
}

/** True when the snapshot is recent enough to call its predictions live. */
export function isFresh(state: RealtimeState, now = serverNow(state)): boolean {
  return state.confirmedAt !== null && now - state.confirmedAt < STALE_AFTER_MS && !isFeedFrozen(state, now);
}
