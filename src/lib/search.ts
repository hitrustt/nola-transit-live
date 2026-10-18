/**
 * Search over routes and stops.
 *
 * Riders type "12", "st charles", "canal at carondelet", "tulane & broad" or
 * a stop number off the sign. Every query word must prefix-match a word in
 * the target; routes outrank stops when the query looks like a route number.
 */

import type { Network, Route, Stop } from './network.ts';

export type SearchResult =
  | { kind: 'route'; route: Route; score: number }
  | { kind: 'stop'; stop: Stop; score: number };

/** Words that carry no meaning in an intersection query. */
const STOP_WORDS = new Set(['at', 'and', 'the', 'of', '&']);

/** Rider spellings -> the forms used in stop names. */
const SYNONYMS: Record<string, string> = {
  street: 'st',
  saint: 'st',
  avenue: 'ave',
  boulevard: 'blvd',
  drive: 'dr',
  road: 'rd',
  highway: 'hwy',
  parkway: 'pkwy',
  place: 'pl',
  north: 'n',
  south: 's',
  east: 'e',
  west: 'w',
  mlk: 'martin',
};

export function tokenize(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word && !STOP_WORDS.has(word))
    .map((word) => SYNONYMS[word] ?? word);
}

interface Entry {
  words: string[];
  result: SearchResult;
}

export function createSearchIndex(network: Network) {
  const entries: Entry[] = [
    ...network.routes.map<Entry>((route) => ({
      words: tokenize(`${route.shortName} ${route.longName} ${route.mode} ${route.directions.map((d) => d.headsign).join(' ')}`),
      result: { kind: 'route', route, score: 0 },
    })),
    ...network.stops.map<Entry>((stop) => ({
      words: tokenize(`${stop.name} ${stop.code}`),
      result: { kind: 'stop', stop, score: 0 },
    })),
  ];

  return function search(query: string, limit = 30): SearchResult[] {
    const terms = tokenize(query);
    if (!terms.length) return [];

    const matches: SearchResult[] = [];

    for (const entry of entries) {
      let score = 0;
      let matchedAll = true;

      for (const term of terms) {
        let best = 0;
        for (const [position, word] of entry.words.entries()) {
          if (word === term) best = Math.max(best, position === 0 ? 4 : 3);
          else if (word.startsWith(term)) best = Math.max(best, position === 0 ? 2 : 1);
        }
        if (!best) {
          matchedAll = false;
          break;
        }
        score += best;
      }

      if (!matchedAll) continue;

      const { result } = entry;
      if (result.kind === 'route') {
        // "12" should put route 12 first, not stop #1205.
        if (result.route.shortName.toLowerCase() === query.trim().toLowerCase()) score += 20;
        score += 2;
      } else if (result.stop.code === query.trim()) {
        score += 20;
      }

      matches.push({ ...result, score });
    }

    return matches
      .sort((a, b) => b.score - a.score || label(a).localeCompare(label(b), 'en', { numeric: true }))
      .slice(0, limit);
  };
}

function label(result: SearchResult): string {
  return result.kind === 'route' ? result.route.shortName : result.stop.name;
}
