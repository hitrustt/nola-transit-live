/**
 * Route colours are contrast-corrected at build time against the light map.
 * On the dark map several of them (St. Charles green, the navy buses) sink
 * into the background, so they are lightened here until they hold 3:1 against
 * it — the WCAG minimum for meaningful graphics.
 */

const DARK_BASEMAP = '#1c211f';

function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16)) as [number, number, number];
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const cache = new Map<string, string>();

export function colorForDarkMap(hex: string): string {
  const cached = cache.get(hex);
  if (cached) return cached;

  const background = channels(DARK_BASEMAP);
  let rgb = channels(hex);
  for (let step = 0; step < 30 && contrast(rgb, background) < 3; step += 1) {
    rgb = rgb.map((channel) => channel + (255 - channel) * 0.08) as [number, number, number];
  }
  const result = `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
  cache.set(hex, result);
  return result;
}
