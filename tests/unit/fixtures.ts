/**
 * A tiny synthetic network: one route, one pattern of four stops in a
 * straight line, one weekday service. Small enough to reason about by hand.
 */

import { encodePolyline } from '../../shared/polyline.ts';
import type { NetworkFile, RealtimeSnapshot, ScheduleFile } from '../../shared/types.ts';
import { indexNetwork } from '../../src/lib/network.ts';
import { serviceDayStart } from '../../src/lib/time.ts';

export const SERVICE_DATE = '20261019'; // Monday
export const DAY_START = serviceDayStart(SERVICE_DATE);
export const at = (hours: number, minutes = 0) => DAY_START + (hours * 3600 + minutes * 60) * 1000;

const shape: [number, number][] = [
  [29.95, -90.08],
  [29.95, -90.07],
  [29.95, -90.06],
  [29.95, -90.05],
];

export const networkFile: NetworkFile = {
  format: 2,
  feed: { version: 'TEST', startDate: '20260101', endDate: '20271231', generatedAt: '', sourceUrl: '' },
  agency: { name: 'Test', url: '', phone: '', timezone: 'America/Chicago', fareUrl: '', fare: null },
  bounds: [-90.08, 29.95, -90.05, 29.95],
  routes: [
    {
      id: 'R1',
      shortName: '1',
      longName: 'Test Line',
      mode: 'bus',
      color: '#123456',
      textColor: '#ffffff',
      patterns: ['P1'],
      directions: [{ id: 0, headsign: 'East End', headsigns: ['East End'], mainPattern: 'P1' }],
      headways: { weekday: 15, saturday: null, sunday: null },
      span: { first: '06:00', last: '22:00' },
    },
  ],
  patterns: [
    {
      id: 'P1',
      routeId: 'R1',
      directionId: 0,
      headsign: 'East End',
      shape: encodePolyline(shape),
      lengthMeters: 2896,
      stops: ['A', 'B', 'C', 'D'],
      stopDistances: [0, 965, 1931, 2896],
      tripCount: 3,
    },
  ],
  stops: ['A', 'B', 'C', 'D'].map((id, index) => ({
    id,
    code: `10${index}`,
    name: `Stop ${id}`,
    lat: 29.95,
    lng: -90.08 + index * 0.01,
    routes: ['R1'],
  })),
  services: {
    WK: { days: [true, true, true, true, true, false, false], startDate: '20260101', endDate: '20271231', added: [], removed: [] },
  },
};

export const network = indexNetwork(networkFile);

/** Trips at 8:00, 8:15 and 8:30, five minutes between stops. */
export const schedule: ScheduleFile = {
  pattern: 'P1',
  feedVersion: 'TEST',
  profiles: [[0, 300, 600, 900]],
  trips: [
    ['T800', 'WK', 8 * 3600, 0],
    ['T815', 'WK', 8 * 3600 + 900, 0],
    ['T830', 'WK', 8 * 3600 + 1800, 0],
  ],
};

export const schedules = new Map([['P1', schedule]]);

export function snapshotAt(now: number, trips: RealtimeSnapshot['trips'] = {}, extra: Partial<RealtimeSnapshot> = {}): RealtimeSnapshot {
  return {
    format: 2,
    feedTime: now,
    fetchedAt: now,
    timeBase: Math.floor(now / 1000),
    staticVersion: 'TEST',
    vehicles: [],
    trips,
    alerts: [],
    detours: [],
    tripMatchRate: 1,
    degraded: [],
    ...extra,
  };
}

/** Seconds after the snapshot's timeBase for an epoch-ms time. */
export const rel = (snapshot: RealtimeSnapshot, epochMs: number) => Math.round(epochMs / 1000) - snapshot.timeBase;
