import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke tests against the dev server with a recorded realtime snapshot, so
 * results don't depend on what NORTA's feed says at the moment.
 */
const chromiumArgs = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const launchOptions = { args: chromiumArgs, executablePath: process.env.CHROMIUM_PATH || undefined };

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, launchOptions } },
    { name: 'phone', use: { ...devices['Pixel 7'], launchOptions } },
  ],
  webServer: {
    command: 'npx vite --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    env: { REALTIME_FIXTURE: 'tests/fixtures/realtime.json' },
  },
});
