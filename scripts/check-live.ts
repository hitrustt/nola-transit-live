/**
 * End-to-end check against the live feeds:
 *
 *   npm run check:live            # a sample of busy stops
 *   npm run check:live -- 1041 863
 *
 * Builds a realtime snapshot exactly as the API does, computes departures with
 * the app's own engine, and compares them with the countdowns NORTA's BusTime
 * site shows for the same stops — an independent source. Reports how many of
 * NORTA's predictions we also show, and how far apart the times are.
 *
 * Exits non-zero if the static data no longer matches the live feed, which is
 * the failure that silently broke the previous version of this app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshot } from '../shared/realtime/snapshot.ts';
import type { NetworkFile, ScheduleFile, TripIndexFile } from '../shared/types.ts';
import { departuresForStop } from '../src/lib/arrivals.ts';
import { indexNetwork } from '../src/lib/network.ts';

const DATA = path.resolve('public/data');
const DEFAULT_STOPS = ['1041', '863', '809', '2098', '1047'];
const BUSTIME_ETA = 'https://bustime.norta.com/bustime/eta/getStopPredictionsETA.jsp';

async function main() {
  const network = indexNetwork(JSON.parse(fs.readFileSync(path.join(DATA, 'network.json'), 'utf8')) as NetworkFile);
  const tripIndex = JSON.parse(fs.readFileSync('shared/generated/trips.json', 'utf8')) as TripIndexFile;
  const snapshot = await buildSnapshot({ fetch, tripIndex });
  const now = snapshot.fetchedAt;

  console.log(
    `Feed ${new Date(snapshot.feedTime).toISOString()}: ${snapshot.vehicles.length} vehicles, ` +
      `${Object.keys(snapshot.trips).length} trip updates, ${snapshot.detours.length} detours, ` +
      `${Math.round(snapshot.tripMatchRate * 100)}% of trips found in timetable ${tripIndex.feedVersion}`,
  );
  if (snapshot.degraded.length) console.log(`Degraded feeds: ${snapshot.degraded.join(', ')}`);

  const schedules = new Map<string, ScheduleFile>();
  for (const file of fs.readdirSync(path.join(DATA, 'schedules'))) {
    const schedule = JSON.parse(fs.readFileSync(path.join(DATA, 'schedules', file), 'utf8')) as ScheduleFile;
    schedules.set(schedule.pattern, schedule);
  }

  const stops = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_STOPS;
  let compared = 0;
  let matched = 0;
  const differences: number[] = [];

  for (const stopId of stops) {
    const stop = network.stopsById.get(stopId);
    if (!stop) {
      console.log(`\n${stopId}: not in the timetable`);
      continue;
    }

    const ours = departuresForStop(network, stopId, schedules, snapshot, now, { horizonMs: 60 * 60_000 });
    // BusTime identifies stops by the number on the sign (stop_code), not stop_id.
    const theirs = await bustimePredictions(stop.code);

    console.log(`\n${stop.name} (stop ${stop.code})`);
    console.log(`  ours:   ${ours.slice(0, 6).map((d) => `${d.route.shortName} ${minutes(d.time, now)}${d.status === 'live' ? '*' : ''}`).join(', ') || 'none'}`);
    console.log(`  NORTA:  ${theirs.slice(0, 6).map((p) => `${p.route} ${p.minutes}m${p.scheduled ? '' : '*'}`).join(', ') || 'none'}`);

    // Match each NORTA live prediction to our nearest same-route departure.
    for (const prediction of theirs.filter((entry) => !entry.scheduled && entry.minutes <= 45)) {
      compared += 1;
      const candidates = ours.filter((d) => d.route.shortName === prediction.route && d.status !== 'canceled');
      const nearest = candidates.sort(
        (a, b) => Math.abs((a.time - now) / 60_000 - prediction.minutes) - Math.abs((b.time - now) / 60_000 - prediction.minutes),
      )[0];
      if (!nearest) continue;
      const difference = Math.abs((nearest.time - now) / 60_000 - prediction.minutes);
      if (difference <= 3) {
        matched += 1;
        differences.push(difference);
      }
    }
  }

  differences.sort((a, b) => a - b);
  const median = differences.length ? differences[Math.floor(differences.length / 2)]! : 0;
  console.log(
    `\n${matched} of ${compared} NORTA live predictions shown within 3 min (median difference ${median.toFixed(1)} min).`,
  );

  if (snapshot.tripMatchRate < 0.8) {
    console.error(
      `\nOnly ${Math.round(snapshot.tripMatchRate * 100)}% of live trips are in the timetable. Run \`npm run data -- --fetch\` to update it.`,
    );
    process.exit(1);
  }
}

interface BusTimePrediction {
  route: string;
  minutes: number;
  scheduled: boolean;
}

/** BusTime's ETA page: <pre> blocks with <rn> route, <pt> minutes and <scheduled>. */
async function bustimePredictions(stopId: string): Promise<BusTimePrediction[]> {
  try {
    const response = await fetch(`${BUSTIME_ETA}?route=all&stop=${encodeURIComponent(stopId)}`, { signal: AbortSignal.timeout(10_000) });
    const xml = await response.text();
    return [...xml.matchAll(/<pre>([\s\S]*?)<\/pre>/g)]
      .map(([, block]) => ({
        route: tag(block!, 'rn'),
        minutes: /due|approaching/i.test(tag(block!, 'pt')) ? 0 : Number(tag(block!, 'pt')),
        scheduled: tag(block!, 'scheduled') === 'true',
      }))
      .filter((entry) => entry.route && Number.isFinite(entry.minutes));
  } catch {
    return [];
  }
}

function tag(block: string, name: string): string {
  return new RegExp(`<${name}>([^<]*)</${name}>`).exec(block)?.[1]?.trim() ?? '';
}

function minutes(time: number, now: number): string {
  const value = Math.floor((time - now) / 60_000);
  return value < 1 ? 'due' : `${value}m`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
