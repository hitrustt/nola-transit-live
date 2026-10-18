/**
 * GET /api/realtime — Cloudflare Pages Function.
 * All logic lives in shared/realtime so it can run under Vite in development.
 */

import { handleRealtimeRequest } from '../../shared/realtime/http.ts';
import tripIndex from '../../shared/generated/trips.json';
import type { TripIndexFile } from '../../shared/types.ts';

export const onRequest: PagesFunction = (context) =>
  handleRealtimeRequest(context.request, {
    fetch: (input, init) => fetch(input, init),
    tripIndex: tripIndex as TripIndexFile,
    cache: caches.default,
    waitUntil: (promise) => context.waitUntil(promise),
  });
