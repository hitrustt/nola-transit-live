import { expect, test } from '@playwright/test';

test('home shows routes, live status and vehicles', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Streetcars' })).toBeAttached();
  await expect(page.locator('.live-status__lead')).toHaveText('Live', { timeout: 20_000 });
  await expect.poll(() => page.locator('.vehicle').count(), { timeout: 20_000 }).toBeGreaterThan(10);
});

test('search finds a stop and opens its departures', async ({ page, isMobile }) => {
  await page.goto('/');
  if (isMobile) await page.locator('.sheet__handle').click();
  await page.getByRole('searchbox').fill('canal carondelet');
  await page.locator('.list .row').first().click();
  await expect(page).toHaveURL(/\/stop\//);
  await expect(page.locator('.tile--stop')).toContainText('Carondelet');
  await expect(page.locator('.board__group').first()).toBeVisible();
});

test('route page lists stops in order and switches direction', async ({ page }) => {
  await page.goto('/route/12');
  await expect(page.getByRole('heading', { name: 'St. Charles Streetcar' })).toBeVisible();
  const stops = page.locator('.line__stop');
  await expect.poll(() => stops.count()).toBeGreaterThan(30);
  await page.getByRole('tab', { name: /Canal Street/ }).click();
  await expect(page).toHaveURL(/dir=1/);
});

test('legacy links redirect to the new paths', async ({ page }) => {
  await page.goto('/?route=12&dir=0');
  await expect(page).toHaveURL(/\/route\/12\?dir=0$/);
});

test('unknown stop explains itself instead of breaking', async ({ page }) => {
  await page.goto('/stop/does-not-exist');
  await expect(page.getByText('This stop isn’t in the current timetable')).toBeVisible();
});

test('saving a stop puts it on the home screen', async ({ page, isMobile }) => {
  await page.goto('/stop/863');
  await page.getByRole('button', { name: 'Save stop' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  if (isMobile) await page.locator('.sheet__handle').click();
  await expect(page.getByRole('heading', { name: 'Saved' })).toBeVisible();
  await expect(page.locator('.list').first()).toContainText('St Charles Ave at Napoleon Ave');
});
