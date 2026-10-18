import gtfsRealtime from 'gtfs-realtime-bindings';
import { describe, expect, it, vi } from 'vitest';
import { handleRealtimeRequest, type CacheStore } from '../../shared/realtime/http.ts';
import { buildSnapshot } from '../../shared/realtime/snapshot.ts';
import type { RealtimeSnapshot, TripIndexFile } from '../../shared/types.ts';

const { transit_realtime: rt } = gtfsRealtime;
const NOW = Date.UTC(2026, 9, 19, 13, 0, 0); // Monday 8am in New Orleans
const seconds = (ms: number) => Math.floor(ms / 1000);

const tripIndex: TripIndexFile = {
  feedVersion: 'TEST',
  feedEndDate: '20271231',
  patterns: ['P1'],
  patternRoutes: ['R1'],
  patternStops: [['A', 'B', 'C', 'D']],
  trips: { T1: 0, T2: 0 },
};

function feed(entities: object[]): Uint8Array {
  return rt.FeedMessage.encode(
    rt.FeedMessage.fromObject({ header: { gtfsRealtimeVersion: '2.0', timestamp: seconds(NOW) - 20 }, entity: entities }),
  ).finish();
}

const vehicles = feed([
  {
    id: '1',
    vehicle: {
      trip: { tripId: 'T1', routeId: 'R1' },
      position: { latitude: 29.95, longitude: -90.07, bearing: 90, speed: 5 },
      timestamp: seconds(NOW) - 30,
      vehicle: { id: 'V1' },
    },
  },
  {
    // Ten-minute-old position: no longer where the vehicle is.
    id: '2',
    vehicle: { trip: { tripId: 'T2', routeId: 'R1' }, position: { latitude: 29.95, longitude: -90.06 }, timestamp: seconds(NOW) - 900, vehicle: { id: 'V2' } },
  },
]);

const trips = feed([
  {
    id: 't1',
    tripUpdate: {
      trip: { tripId: 'T1', routeId: 'R1' },
      vehicle: { id: 'V1' },
      stopTimeUpdate: [
        { stopId: 'A', arrival: { time: seconds(NOW) - 600 } }, // long past: dropped
        { stopId: 'B', arrival: { time: seconds(NOW) + 120 } },
        { stopId: 'C', scheduleRelationship: rt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED },
      ],
    },
  },
  { id: 't2', tripUpdate: { trip: { tripId: 'T2', routeId: 'R1', scheduleRelationship: rt.TripDescriptor.ScheduleRelationship.CANCELED } } },
  { id: 't3', tripUpdate: { trip: { tripId: 'UNKNOWN', routeId: 'R1' } } },
]);

const alerts = feed([]);

function upstream(overrides: Partial<Record<'vehicles' | 'trips' | 'alerts', Uint8Array | number>> = {}) {
  const bodies = { vehicles, trips, alerts, ...overrides };
  return vi.fn(async (input: RequestInfo | URL) => {
    const name = String(input).split('/').pop() as keyof typeof bodies;
    const body = bodies[name];
    if (typeof body === 'number') return new Response('down', { status: body });
    return new Response(new Uint8Array(body));
  }) as unknown as typeof fetch;
}

function memoryCache(): CacheStore & { stored: () => boolean } {
  let entry: { body: string; headers: [string, string][] } | null = null;
  return {
    stored: () => entry !== null,
    async match() {
      return entry ? new Response(entry.body, { headers: entry.headers }) : undefined;
    },
    async put(_key, response) {
      entry = { body: await response.text(), headers: [...response.headers.entries()] };
    },
  };
}

describe('buildSnapshot', () => {
  it('decodes, resolves patterns and drops what riders should not see', async () => {
    const snapshot = await buildSnapshot({ fetch: upstream(), tripIndex, now: () => NOW });

    expect(snapshot.vehicles.map((v) => v.id)).toEqual(['V1']);
    expect(snapshot.vehicles[0]).toMatchObject({ patternId: 'P1', bearing: 90, speed: 5 });

    const t1 = snapshot.trips.T1!;
    expect(t1.patternId).toBe('P1');
    expect(t1.stops).toEqual([
      ['B', 120, 0],
      ['C', null, 1],
    ]);
    expect(snapshot.trips.T2!.status).toBe('canceled');
    // Two of three non-added trips are in the timetable.
    expect(snapshot.tripMatchRate).toBeCloseTo(2 / 3, 2);
    expect(snapshot.degraded).toEqual([]);
  });

  it('reports a failed feed instead of failing the snapshot', async () => {
    const snapshot = await buildSnapshot({ fetch: upstream({ alerts: 500 }), tripIndex, now: () => NOW });
    expect(snapshot.degraded).toEqual(['alerts']);
    expect(snapshot.vehicles).toHaveLength(1);
  });

  it('fails when neither vehicles nor trips are available', async () => {
    await expect(buildSnapshot({ fetch: upstream({ vehicles: 503, trips: 503 }), tripIndex, now: () => NOW })).rejects.toThrow(/unavailable/);
  });
});

describe('handleRealtimeRequest', () => {
  const request = (headers: Record<string, string> = {}) => new Request('https://example.test/api/realtime', { headers });

  it('serves from the shared cache inside the fresh window', async () => {
    const fetchMock = upstream();
    const cache = memoryCache();
    let now = NOW;
    const options = { fetch: fetchMock, tripIndex, cache, now: () => now };

    expect((await handleRealtimeRequest(request(), options)).status).toBe(200);
    now += 5_000;
    expect((await handleRealtimeRequest(request(), options)).status).toBe(200);
    // Three feeds fetched once; the second request came from cache.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('answers 304 when the client already has this feed version', async () => {
    const options = { fetch: upstream(), tripIndex, cache: memoryCache(), now: () => NOW };
    const first = await handleRealtimeRequest(request(), options);
    const etag = first.headers.get('ETag')!;
    const second = await handleRealtimeRequest(request({ 'If-None-Match': etag }), options);
    expect(second.status).toBe(304);
  });

  it('shares one upstream build between concurrent requests', async () => {
    const fetchMock = upstream();
    const options = { fetch: fetchMock, tripIndex, now: () => NOW };
    await Promise.all([handleRealtimeRequest(request(), options), handleRealtimeRequest(request(), options)]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('prefers a recent complete snapshot over a partial one', async () => {
    const cache = memoryCache();
    let now = NOW;
    await handleRealtimeRequest(request(), { fetch: upstream(), tripIndex, cache, now: () => now });

    now += 30_000;
    const response = await handleRealtimeRequest(request(), { fetch: upstream({ trips: 500 }), tripIndex, cache, now: () => now });
    const body = (await response.json()) as RealtimeSnapshot;
    expect(response.headers.get('X-Stale')).toBe('1');
    expect(body.degraded).toEqual([]);
    expect(Object.keys(body.trips)).toContain('T1');
  });

  it('falls back to the last snapshot when NORTA is down, then gives up', async () => {
    const cache = memoryCache();
    let now = NOW;
    await handleRealtimeRequest(request(), { fetch: upstream(), tripIndex, cache, now: () => now });

    const down = upstream({ vehicles: 503, trips: 503, alerts: 503 });
    now += 60_000;
    const stale = await handleRealtimeRequest(request(), { fetch: down, tripIndex, cache, now: () => now });
    expect(stale.status).toBe(200);
    expect(stale.headers.get('X-Stale')).toBe('1');

    now += 10 * 60_000;
    const failed = await handleRealtimeRequest(request(), { fetch: down, tripIndex, cache, now: () => now });
    expect(failed.status).toBe(502);
  });

  it('rejects other methods', async () => {
    const response = await handleRealtimeRequest(new Request('https://example.test/api/realtime', { method: 'POST' }), {
      fetch: upstream(),
      tripIndex,
    });
    expect(response.status).toBe(405);
  });
});
