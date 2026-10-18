// Retakes the README screenshots in docs/ from a running dev server.
//
//   npm run dev            (in one terminal)
//   npm run screenshots    (in another)
//
// CHROMIUM_PATH lets CI or a sandbox use a preinstalled browser.

import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

async function shoot(path, file, options) {
  const page = await (await browser.newContext({ deviceScaleFactor: 2, colorScheme: 'light', ...options })).newPage();
  await page.goto(`${BASE}${path}`);
  // Wait for live vehicles, then for markers to finish gliding into place.
  await page.waitForSelector('.vehicle', { state: 'attached', timeout: 30_000 });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: file });
  await page.close();
}

await shoot('/route/12?dir=0', 'docs/screenshot.png', { viewport: { width: 1440, height: 900 } });
await shoot('/stop/1965', 'docs/screenshot-mobile.png', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await browser.close();
console.log('Saved docs/screenshot.png and docs/screenshot-mobile.png');
