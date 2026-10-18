/**
 * NORTA's stop names mix styles: "St. Charles Ave. at Napoleon Ave.",
 * "St Charles Ave at Hillary St", "Jackson Ave.at Rousseau St.",
 * "St Charles Ave & Broadway St". These are normalised to one house style
 * (USPS-like: no periods on suffixes or directionals, "at" between streets)
 * so that lists read cleanly and search does not care which variant was used.
 */

const ABBREVIATIONS = [
  'St', 'Ave', 'Blvd', 'Dr', 'Rd', 'Hwy', 'Pl', 'Pkwy', 'Ct', 'Ln', 'Expwy', 'Ctr', 'Apts',
  'Gen', 'Jr', 'Rev', 'Sq', 'Ter', 'Cir', 'Mt', 'Ft', 'Hosp', 'Univ',
];

const ABBREVIATION_PATTERN = new RegExp(`\\b(${ABBREVIATIONS.join('|')})\\.`, 'g');
/** Directionals lose their period only when they stand alone ("N. Rampart"), not in "N.O.". */
const DIRECTIONAL_PATTERN = /\b([NSEW])\.(?=\s)/g;

export function normalizeStopName(raw: string): string {
  let name = raw.trim().replace(/\s+/g, ' ');

  // "N.O. East", "NO. East", "N O. East" all mean New Orleans East.
  name = name.replace(/\bN\.?\s?O\.?\s+East\b/g, 'New Orleans East');
  // "Main Library- CBD" -> "Main Library-CBD"
  name = name.replace(/(\S)- (\S)/g, '$1-$2').replace(/(\S) -(\S)/g, '$1-$2');
  // "L'est" -> "L'Est"
  name = name.replace(/\bL'([a-z])/g, (_match, letter: string) => `L'${letter.toUpperCase()}`);

  // "Ave.at" / "Aveat" — a missing space before "at" in the source data.
  name = name.replace(
    new RegExp(`\\b(${ABBREVIATIONS.join('|')})\\.?at\\s`, 'g'),
    (_match, word: string) => `${word} at `,
  );

  name = name.replace(ABBREVIATION_PATTERN, '$1').replace(DIRECTIONAL_PATTERN, '$1');

  // Intersections are written "X at Y"; a few use "and" or "&".
  if (!/\bat\b/i.test(name)) {
    name = name.replace(/\s+(?:&|and)\s+/i, ' at ');
  }

  return name.replace(/\s+,/g, ',').trim();
}

/** Lower-cased, punctuation-free form used for search and de-duplication. */
export function searchKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
