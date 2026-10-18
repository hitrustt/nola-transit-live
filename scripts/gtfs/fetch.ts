/**
 * Downloads NORTA's published GTFS feed and unpacks it into .cache/gtfs.
 *
 *   npm run data:fetch            # official URL
 *   npm run data:fetch -- ./x.zip # a local zip instead
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

export const GTFS_URL = 'https://www.norta.com/RTA/media/GTFS/GTFS.zip';
export const CACHE_DIR = path.resolve('.cache', 'gtfs');

export async function fetchGtfs(source = GTFS_URL): Promise<string> {
  let archive: Uint8Array;

  if (/^https?:/.test(source)) {
    console.log(`Downloading ${source}`);
    const response = await fetch(source, {
      headers: { 'User-Agent': 'nola-transit-live data pipeline' },
    });

    if (!response.ok) {
      throw new Error(`GTFS download failed: HTTP ${response.status}`);
    }

    archive = new Uint8Array(await response.arrayBuffer());
  } else {
    archive = new Uint8Array(fs.readFileSync(source));
  }

  const files = unzipSync(archive);
  const names = Object.keys(files).filter((name) => name.endsWith('.txt'));

  if (!names.includes('stop_times.txt') && !names.some((name) => name.endsWith('/stop_times.txt'))) {
    throw new Error('Archive does not look like a GTFS feed (no stop_times.txt)');
  }

  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  for (const name of names) {
    // Some agencies zip a folder rather than its contents.
    fs.writeFileSync(path.join(CACHE_DIR, path.basename(name)), files[name]!);
  }

  fs.writeFileSync(
    path.join(CACHE_DIR, '.source.json'),
    JSON.stringify({ source, fetchedAt: new Date().toISOString() }),
  );

  console.log(`Unpacked ${names.length} files to ${path.relative(process.cwd(), CACHE_DIR)}`);
  return CACHE_DIR;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fetchGtfs(process.argv[2]).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
