/**
 * A small, strict GTFS CSV reader. GTFS is RFC 4180 CSV with an optional BOM;
 * NORTA's export uses quoted fields and CRLF line endings.
 */

import fs from 'node:fs';
import path from 'node:path';

export type Row = Record<string, string>;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (; index < text.length; index += 1) {
    const char = text[index]!;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') {
        index += 1;
      }
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') {
        rows.push(row);
      }
      row = [];
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export function createGtfsReader(directory: string) {
  function load(fileName: string, required = true): { header: string[]; rows: string[][] } {
    const filePath = path.join(directory, fileName);

    if (!fs.existsSync(filePath)) {
      if (required) {
        throw new Error(`GTFS feed is missing ${fileName}`);
      }
      return { header: [], rows: [] };
    }

    const [header = [], ...rows] = parseCsv(fs.readFileSync(filePath, 'utf8'));
    return { header: header.map((name) => name.trim()), rows };
  }

  return {
    /** Read a table into objects keyed by column name. */
    read(fileName: string, required = true): Row[] {
      const { header, rows } = load(fileName, required);
      return rows.map((values) =>
        Object.fromEntries(header.map((name, index) => [name, (values[index] ?? '').trim()])),
      );
    },

    /** Iterate a large table by column index without building row objects. */
    each(fileName: string, onRow: (values: string[], column: Record<string, number>) => void) {
      const { header, rows } = load(fileName);
      const column = Object.fromEntries(header.map((name, index) => [name, index]));

      for (const values of rows) {
        onRow(values, column);
      }
    },
  };
}

/** "25:14:00" -> seconds after service-day midnight. GTFS allows hours >= 24. */
export function parseGtfsTime(value: string | undefined): number | null {
  const match = /^\s*(\d+):(\d{2}):(\d{2})\s*$/.exec(value ?? '');

  if (!match) {
    return null;
  }

  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
