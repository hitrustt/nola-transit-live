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

let inFlight: Promise<string> | null = null;

export async function handleRealtimeRequest(request: Request, options: RealtimeHandlerOptions): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' });
  }

  const now = options.now ?? Date.now;
  const key = new Request(CACHE_KEY);
  const cached = options.cache ? await options.cache.match(key).catch(() => undefined) : undefined;
  const cachedAt = Number(cached?.headers.get('x-fetched-at') ?? 0);
  const cachedFeedTime = cached?.headers.get('x-feed-time') ?? '';

  if (cached && now() - cachedAt < FRESH_MS) {
    return respond(request, await cached.text(), cachedFeedTime, false);
  }

  try {
    inFlight ??= buildSnapshot({ fetch: options.fetch, tripIndex: options.tripIndex, now }).then((snapshot) =>
      JSON.stringify(snapshot),
    );
    const body = await inFlight;
    const { fetchedAt, feedTime, staticVersion } = JSON.parse(body) as { fetchedAt: number; feedTime: number; staticVersion: string };
    const version = `${feedTime}-${staticVersion}`;

    if (options.cache) {
      const stored = new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${STALE_LIMIT_MS / 1000}`,
          'x-fetched-at': String(fetchedAt),
          'x-feed-time': version,
        },
      });
      const write = options.cache.put(key, stored).catch(() => undefined);
      if (options.waitUntil) options.waitUntil(write);
      else await write;
    }

    return respond(request, body, version, false);
  } catch (error) {
    if (cached && now() - cachedAt < STALE_LIMIT_MS) {
      return respond(request, await cached.text(), cachedFeedTime, true);
    }

    const message = error instanceof Error ? error.message : String(error);
    return json(
      { error: error instanceof UpstreamError ? message : 'Realtime data is temporarily unavailable' },
      error instanceof UpstreamError ? 502 : 500,
      { 'Retry-After': '15' },
    );
  } finally {
    inFlight = null;
  }
}

/**
 * The ETag is NORTA's own feed timestamp, so a client that already has this
 * version of the feed gets a 304 even though the edge refetched it.
 */
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
