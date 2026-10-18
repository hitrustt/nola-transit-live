/**
 * Serves /api/realtime from the Vite dev server using the same handler as
 * production, so `npm run dev` needs no Cloudflare tooling.
 *
 * REALTIME_FIXTURE=path/to/snapshot.json replays a recorded snapshot instead,
 * shifted so its times are relative to now. Used for offline work and for
 * deterministic end-to-end tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { handleRealtimeRequest, type CacheStore } from '../shared/realtime/http.ts';
import type { RealtimeSnapshot, TripIndexFile } from '../shared/types.ts';

const TRIPS_PATH = path.resolve('shared/generated/trips.json');

function memoryCache(): CacheStore {
  let stored: { body: string; headers: [string, string][] } | null = null;
  return {
    async match() {
      return stored ? new Response(stored.body, { headers: stored.headers }) : undefined;
    },
    async put(_key, response) {
      stored = { body: await response.text(), headers: [...response.headers.entries()] };
    },
  };
}

export function rebaseSnapshot(snapshot: RealtimeSnapshot, now: number): RealtimeSnapshot {
  const delta = now - snapshot.fetchedAt;
  return {
    ...snapshot,
    fetchedAt: now,
    feedTime: snapshot.feedTime + delta,
    timeBase: snapshot.timeBase + Math.round(delta / 1000),
    vehicles: snapshot.vehicles.map((vehicle) => ({ ...vehicle, timestamp: vehicle.timestamp + delta })),
  };
}

export function realtimeDevPlugin(): Plugin {
  const cache = memoryCache();
  const fixture = process.env.REALTIME_FIXTURE;

  return {
    name: 'nola-transit-live:realtime',
    configureServer(server) {
      server.middlewares.use('/api/realtime', async (req, res) => {
        try {
          if (fixture) {
            const snapshot = rebaseSnapshot(JSON.parse(fs.readFileSync(fixture, 'utf8')) as RealtimeSnapshot, Date.now());
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-cache');
            res.end(JSON.stringify(snapshot));
            return;
          }

          const tripIndex = JSON.parse(fs.readFileSync(TRIPS_PATH, 'utf8')) as TripIndexFile;
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(key, value);
          }
          const response = await handleRealtimeRequest(new Request(`http://localhost${req.url ?? '/'}`, { method: req.method, headers }), {
            fetch,
            tripIndex,
            cache,
          });
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.setHeader('Date', new Date().toUTCString());
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(error) }));
        }
      });
    },
  };
}
