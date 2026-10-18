// Renders the PNG app icons from public/icons/icon.svg. Run after editing the SVG: npm run icons
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const svg = fs.readFileSync('public/icons/icon.svg', 'utf8');
const font = fs.readFileSync('node_modules/@fontsource-variable/atkinson-hyperlegible-next/files/atkinson-hyperlegible-next-latin-wght-normal.woff2').toString('base64');
// CHROMIUM_PATH lets CI or a sandbox use a preinstalled browser.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
async function render(file, size, { maskable = false } = {}) {
  const inner = maskable ? `<div style="width:${size}px;height:${size}px;background:#1f4fa3;display:grid;place-items:center"><div style="width:${size*0.72}px;height:${size*0.72}px">${svg}</div></div>` : `<div style="width:${size}px;height:${size}px">${svg}</div>`;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>@font-face{font-family:'Atkinson Hyperlegible Next';src:url(data:font/woff2;base64,${font})}html,body{margin:0;background:transparent}svg{width:100%;height:100%;display:block}</style>${inner}`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, omitBackground: true });
}
await render('public/icons/icon-192.png', 192);
await render('public/icons/icon-512.png', 512);
await render('public/icons/apple-touch-icon.png', 180, { maskable: true });
await render('public/icons/icon-maskable-512.png', 512, { maskable: true });
await browser.close();
