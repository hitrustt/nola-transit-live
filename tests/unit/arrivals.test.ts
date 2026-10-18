import { describe, expect, it } from 'vitest';
import { alignToPattern, departuresForStop } from '../../src/lib/arrivals.ts';
import { at, network, rel, schedules, snapshotAt } from './fixtures.ts';

describe('departuresForStop', () => {
  it('lists the timetable when there is no realtime data', () => {
    const now = at(8, 0);
    const result = departuresForStop(network, 'B', schedules, null, now);
    expect(result.map((d) => [d.tripId, d.status])).toEqual([
      ['T800', 'scheduled'],
      ['T815', 'scheduled'],
      ['T830', 'scheduled'],
    ]);
    expect(result[0]!.time).toBe(at(8, 5));
  });

  it('never lists the last stop of a trip as a departure', () => {
    expect(departuresForStop(network, 'D', schedules, null, at(8, 0))).toEqual([]);
  });

  it('uses a prediction for the stop and reports the delay', () => {
    const now = at(8, 0);
    const snapshot = snapshotAt(now);
    snapshot.trips.T800 = {
      routeId: 'R1',
      patternId: 'P1',
      vehicleId: 'V1',
      status: 'scheduled',
      detourId: null,
      stops: [
        ['B', rel(snapshot, at(8, 8)), 0],
        ['C', rel(snapshot, at(8, 13)), 0],
      ],
    };
    const [first] = departuresForStop(network, 'B', schedules, snapshot, now);
    expect(first).toMatchObject({ tripId: 'T800', status: 'live', vehicleId: 'V1', delaySeconds: 180 });
    expect(first!.time).toBe(at(8, 8));
  });

  it('drops a trip whose vehicle has already passed the stop', () => {
    const now = at(8, 7);
    const snapshot = snapshotAt(now);
    snapshot.trips.T800 = {
      routeId: 'R1',
      patternId: 'P1',
      vehicleId: 'V1',
      status: 'scheduled',
      detourId: null,
      stops: [['C', rel(snapshot, at(8, 10)), 0]],
    };
    const result = departuresForStop(network, 'B', schedules, snapshot, now);
    expect(result.map((d) => d.tripId)).toEqual(['T815', 'T830']);
  });

  it('keeps a late vehicle that is past its scheduled time', () => {
    // Scheduled at B 8:05, it is now 8:20 and the bus is still coming.
    const now = at(8, 20);
    const snapshot = snapshotAt(now);
    snapshot.trips.T800 = {
      routeId: 'R1',
      patternId: 'P1',
      vehicleId: 'V1',
      status: 'scheduled',
      detourId: null,
      stops: [['B', rel(snapshot, at(8, 23)), 0]],
    };
    const result = departuresForStop(network, 'B', schedules, snapshot, now);
    // Listed after the on-time 8:15 trip (due now), before the 8:30.
    expect(result.map((d) => d.tripId)).toEqual(['T815', 'T800', 'T830']);
    expect(result[1]).toMatchObject({ status: 'live', delaySeconds: 18 * 60 });
  });

  it('carries a delay forward from an earlier stop, but not an early one', () => {
    const now = at(7, 58);
    const late = snapshotAt(now);
    late.trips.T800 = {
      routeId: 'R1',
      patternId: 'P1',
      vehicleId: 'V1',
      status: 'scheduled',
      detourId: null,
      stops: [['A', rel(late, at(8, 4)), 0]],
    };
    const [lateAtC] = departuresForStop(network, 'C', schedules, late, now);
    expect(lateAtC!.time).toBe(at(8, 14)); // scheduled 8:10 + 4 min

    const early = snapshotAt(now);
    early.trips.T800 = { ...late.trips.T800, stops: [['A', rel(early, at(7, 58)), 0]] };
    const [earlyAtC] = departuresForStop(network, 'C', schedules, early, now);
    expect(earlyAtC!.time).toBe(at(8, 10)); // held to schedule
  });

  it('marks cancelled trips and skipped stops instead of hiding them', () => {
    const now = at(8, 0);
    const snapshot = snapshotAt(now);
    snapshot.trips.T815 = { routeId: 'R1', patternId: 'P1', vehicleId: null, status: 'canceled', detourId: null, stops: [] };
    snapshot.trips.T830 = {
      routeId: 'R1',
      patternId: 'P1',
      vehicleId: null,
      status: 'scheduled',
      detourId: 'D1',
      stops: [
        ['B', null, 1],
        ['C', rel(snapshot, at(8, 41)), 0],
      ],
    };
    const result = departuresForStop(network, 'B', schedules, snapshot, now);
    expect(result.map((d) => [d.tripId, d.status])).toEqual([
      ['T800', 'scheduled'],
      ['T815', 'canceled'],
      ['T830', 'skipped'],
    ]);
  });

  it('applies a published detour to trips with no trip update yet', () => {
    const now = at(8, 0);
    const snapshot = snapshotAt(now, {}, {
      detours: [{ id: 'D1', routeIds: ['R1'], patternIds: ['P1'], tripIds: ['T830'], shape: null, skippedStops: { P1: ['B'] }, delayMinutes: 2 }],
    });
    const result = departuresForStop(network, 'B', schedules, snapshot, now);
    expect(result.find((d) => d.tripId === 'T830')).toMatchObject({ status: 'skipped', detoured: true });
    expect(result.find((d) => d.tripId === 'T815')).toMatchObject({ status: 'scheduled', detoured: false });
  });

  it('adds realtime-only trips', () => {
    const now = at(8, 0);
    const snapshot = snapshotAt(now);
    snapshot.trips.EXTRA = {
      routeId: 'R1',
      patternId: 'P1',
      vehicleId: 'V9',
      status: 'added',
      detourId: null,
      stops: [['B', rel(snapshot, at(8, 2)), 0]],
    };
    const [first] = departuresForStop(network, 'B', schedules, snapshot, now);
    expect(first).toMatchObject({ tripId: 'EXTRA', status: 'live', scheduled: null, headsign: 'East End' });
  });

  it('respects the horizon and keeps a just-departed call briefly', () => {
    const result = departuresForStop(network, 'B', schedules, null, at(8, 5, ) + 30_000, { horizonMs: 15 * 60_000 });
    expect(result.map((d) => d.tripId)).toEqual(['T800', 'T815']);
  });
});

describe('alignToPattern', () => {
  it('matches the second visit of a loop to the second occurrence', () => {
    const loop = ['HUB', 'X', 'Y', 'HUB2', 'X', 'Z'];
    expect(alignToPattern(['Y', 'HUB2', 'X', 'Z'], loop)).toEqual([2, 3, 4, 5]);
    expect(alignToPattern(['X', 'Y'], loop)).toEqual([1, 2]);
    expect(alignToPattern(['Q', 'Z'], loop)).toEqual([-1, 5]);
  });
});
