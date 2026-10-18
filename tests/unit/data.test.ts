import { describe, expect, it } from 'vitest';
import { absorbShortRuns } from '../../scripts/gtfs/corridors.ts';
import { parseCsv, parseGtfsTime } from '../../scripts/gtfs/csv.ts';
import { contrastRatio, routeColors } from '../../scripts/gtfs/colors.ts';
import { normalizeStopName } from '../../scripts/gtfs/names.ts';
import { cumulativeDistances, pointAlongLine, projectOntoLine } from '../../shared/geo.ts';
import { decodePolyline, encodePolyline } from '../../shared/polyline.ts';
import { createSearchIndex } from '../../src/lib/search.ts';
import { network } from './fixtures.ts';

describe('stop names', () => {
  it.each([
    ['St. Charles Ave. at Napoleon Ave.', 'St Charles Ave at Napoleon Ave'],
    ['S Carrollton Aveat Spruce St', 'S Carrollton Ave at Spruce St'],
    ['Jackson Ave.at Rousseau St.', 'Jackson Ave at Rousseau St'],
    ['St Charles Ave & Broadway St', 'St Charles Ave at Broadway St'],
    ['Canal St. and Magazine St.', 'Canal St at Magazine St'],
    ['N.O. East Hub', 'New Orleans East Hub'],
    ['N O. East Hub', 'New Orleans East Hub'],
    ['Main Library- CBD', 'Main Library-CBD'],
    ["Village De L'est", "Village De L'Est"],
    ['A. P. Tureaud Ave. at N. Broad St.', 'A. P. Tureaud Ave at N Broad St'],
    ['French Market Station', 'French Market Station'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeStopName(input)).toBe(expected);
  });
});

describe('csv', () => {
  it('handles BOM, quotes, escaped quotes and CRLF', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
    ]);
  });

  it('parses GTFS times beyond 24h', () => {
    expect(parseGtfsTime('25:14:00')).toBe(25 * 3600 + 14 * 60);
    expect(parseGtfsTime('')).toBeNull();
  });
});

describe('colours', () => {
  it('darkens pale route colours until lines read on the map', () => {
    const { color, textColor } = routeColors('00ffff', 0);
    expect(contrastRatio(color, '#f2f1ee')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(color, textColor)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['c146c1', 'f7941d', '00b6de', 'ffd200'])('gives readable badge text on #%s', (raw) => {
    const { color, textColor } = routeColors(raw, 0);
    expect(contrastRatio(color, textColor)).toBeGreaterThanOrEqual(4.5);
  });

  it('assigns a fallback for the feed’s "no colour" value', () => {
    expect(routeColors('c8c8c8', 1).color).not.toBe('#c8c8c8');
  });
});

describe('geometry', () => {
  const line: [number, number][] = [
    [29.95, -90.08],
    [29.95, -90.07],
    [29.96, -90.07],
  ];

  it('round-trips encoded polylines', () => {
    expect(decodePolyline(encodePolyline(line))).toEqual(line);
  });

  it('projects onto a polyline and walks back along it', () => {
    const distances = cumulativeDistances(line);
    const projection = projectOntoLine([29.9502, -90.075], line, distances);
    expect(projection.offsetMeters).toBeLessThan(30);
    const { point } = pointAlongLine(line, distances, projection.distanceAlong);
    expect(point[1]).toBeCloseTo(-90.075, 4);
  });

  it('restricts projection to a distance window', () => {
    const distances = cumulativeDistances(line);
    const restricted = projectOntoLine([29.95, -90.075], line, distances, distances[1]!, Infinity);
    expect(restricted.distanceAlong).toBeGreaterThanOrEqual(distances[1]!);
  });
});

describe('corridor smoothing', () => {
  it('absorbs short runs into their longer neighbour', () => {
    expect(absorbShortRuns([1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1], 3)).toEqual(Array(11).fill(1));
    expect(absorbShortRuns([1, 1, 1, 2, 2, 2, 2, 2], 3)).toEqual([1, 1, 1, 2, 2, 2, 2, 2]);
  });
});

describe('search', () => {
  const search = createSearchIndex(network);

  it('ranks the route first for a route number', () => {
    expect(search('1')[0]).toMatchObject({ kind: 'route' });
  });

  it('finds stops by name and by code', () => {
    expect(search('stop c')[0]).toMatchObject({ kind: 'stop', stop: { id: 'C' } });
    expect(search('103')[0]).toMatchObject({ kind: 'stop', stop: { id: 'D' } });
  });

  it('returns nothing for an empty query', () => {
    expect(search('   ')).toEqual([]);
  });
});
