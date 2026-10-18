/**
 * Route colours. NORTA publishes some colours that disappear on a light
 * basemap (cyan, pale yellow) and uses #c8c8c8 as "no colour". Lines need a
 * minimum contrast against the map, and badge text must be readable on the
 * badge, so both are corrected here once rather than in the browser.
 */

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)) as Rgb;
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as Rgb;

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
}

/** Darken in small steps until the colour holds `ratio` against `background`. */
export function ensureContrast(hex: string, background: string, ratio: number): string {
  let rgb = parseHex(hex);

  for (let step = 0; step < 40 && contrastRatio(toHex(rgb), background) < ratio; step += 1) {
    rgb = rgb.map((channel) => channel * 0.94) as Rgb;
  }

  return toHex(rgb);
}

export function readableTextColor(hex: string): '#ffffff' | '#111111' {
  return contrastRatio(hex, '#ffffff') >= contrastRatio(hex, '#111111') ? '#ffffff' : '#111111';
}

/** Distinct, map-safe colours for routes the feed leaves uncoloured. */
const FALLBACK = [
  '#b4420c', '#946200', '#4f7a12', '#0b7a5c', '#0e6f7a', '#1f63b0',
  '#4a4fc4', '#7444b8', '#9c2f8f', '#b8324f', '#6b5b45', '#3f6170',
];

const NO_COLOUR = new Set(['', 'c8c8c8', 'ffffff', '000000']);

/** Light basemap land colour; lines must read against it at 3:1 (WCAG non-text). */
const BASEMAP = '#f2f1ee';

export function routeColors(rawColor: string, index: number) {
  const base = NO_COLOUR.has(rawColor.toLowerCase())
    ? FALLBACK[index % FALLBACK.length]!
    : `#${rawColor.toLowerCase()}`;
  let color = ensureContrast(base, BASEMAP, 3);
  // Badges carry the route number in black or white on this colour; mid-tone
  // colours (magenta, orange) reach 4.5:1 with neither, so darken until white does.
  if (Math.max(contrastRatio(color, '#ffffff'), contrastRatio(color, '#111111')) < 4.5) {
    color = ensureContrast(color, '#ffffff', 4.5);
  }

  return { color, textColor: readableTextColor(color) };
}
