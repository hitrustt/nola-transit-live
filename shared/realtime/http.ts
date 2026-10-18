/**
 * HTTP handling for /api/realtime, shared by the Cloudflare Pages Function
 * and the Vite dev server.
 *
 * Caching, in order:
 *   1. Concurrent requests in one isolate share a single in-flight build.
 *   2. A built snapshot is stored in the edge cache and served to everyone
 *      for FRESH_MS, so NORTA sees one request per window per data centre,
 *      however many riders are polling.
 *   3. If NORTA is down, the last good snapshot is served for up to
 *      STALE_LIMIT_MS, marked stale. The app shows its age to the rider
 *      rather than pretending it is live.
 *   4. Clients send If-None-Match and get a 304 when nothing changed.
 */

import type { TripIndexFile } from '../types.ts';
import { buildSnapshot, UpstreamError } from './snapshot.ts';

export const FRESH_MS = 10_000;
export const STALE_LIMIT_MS = 5 * 60_000;
const CACHE_KEY = 'https://cache.internal/api/realtime/v2';

export interface CacheStore {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}

export interface RealtimeHandlerOptions {
  fetch: typeof fetch;
  tripIndex: TripIndexFile;
  cache?: CacheStore | null;
  waitUntil?: (promise: Promise<unknown>) => void;
  now?: () => number;
}

interface Build {
  promise: Promise<string>;
  startedAt: number;
}

/**
 * The snapshot build in progress, shared by concurrent requests in this
 * isolate. It is owned by the build, not by any request: on Workers a promise
 * created by a request that is then cancelled can be abandoned, so the build
 * is handed to waitUntil and every waiter also has its own timeout.
 */
let inFlight: Build | null = null;
const BUILD_TIMEOUT_MS = 15_000;

export async function handleRealtimeRequest(request: Request, options: RealtimeHandlerOptions): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
  }

  const now = options.now ?? Date.now;
  const key = new Request(CACHE_KEY);
  const cached = options.cache ? await options.cache.match(key).catch(() => undefined) : undefined;
  const cachedAt = Number(cached?.headers.get('x-fetched-at') ?? 0);
  const cachedVersion = cached?.headers.get('x-feed-time') ?? '';
  const cachedComplete = cached?.headers.get('x-degraded') !== '1';
  const cachedUsable = Boolean(cached) && now() - cachedAt < STALE_LIMIT_MS;

  if (cached && now() - cachedAt < FRESH_MS) {
    return respond(request, await cached.text(), cachedVersion, false);
  }

  try {
    if (!inFlight || now() - inFlight.startedAt > BUILD_TIMEOUT_MS) {
      const promise = buildSnapshot({ fetch: options.fetch, tripIndex: options.tripIndex, now }).then((snapshot) =>
        JSON.stringify(snapshot),
      );
      const build: Build = { promise, startedAt: now() };
      inFlight = build;
      const settled = promise.then(
        () => undefined,
        () => undefined,
      );
      void settled.then(() => {
        if (inFlight === build) inFlight = null;
      });
      options.waitUntil?.(settled);
    }

    const body = await withTimeout(inFlight.promise, BUILD_TIMEOUT_MS);
    const parsed = JSON.parse(body) as { fetchedAt: number; feedTime: number; staticVersion: string; degraded: string[] };
    const version = `${parsed.feedTime}-${parsed.staticVersion}`;
    const degraded = parsed.degraded.length > 0;

    // One feed failing (say trip updates) yields a partial snapshot with no
    // predictions. A recent complete snapshot is the better answer: serve it,
    // marked stale, and keep it in the cache.
    if (degraded && cached && cachedUsable && cachedComplete) {
      return respond(request, await cached.text(), cachedVersion, true);
    }

    if (options.cache) {
      const stored = new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${STALE_LIMIT_MS / 1000}`,
          'x-fetched-at': String(parsed.fetchedAt),
          'x-feed-time': version,
          'x-degraded': degraded ? '1' : '0',
        },
      });
      const write = options.cache.put(key, stored).catch(() => undefined);
      if (options.waitUntil) options.waitUntil(write);
      else await write;
    }

    return respond(request, body, version, false);
  } catch (error) {
    if (cached && cachedUsable) {
      return respond(request, await cached.text(), cachedVersion, true);
    }

    const message = error instanceof Error ? error.message : String(error);
    return json(
      { error: error instanceof UpstreamError ? message : 'Realtime data is temporarily unavailable' },
      error instanceof UpstreamError ? 502 : 500,
      { 'Retry-After': '15' },
    );
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamError('Timed out waiting for NORTA')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function respond(request: Request, body: string, version: string, stale: boolean): Response {
  const etag = `"${version}"`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    // Browsers revalidate every poll; the ETag makes that a 304 when unchanged.
    'Cache-Control': 'no-cache',
    ETag: etag,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'ETag, X-Stale, Date',
    'X-Stale': stale ? '1' : '0',
  };

  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

function json(value: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}
