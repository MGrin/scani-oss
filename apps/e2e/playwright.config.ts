import { defineConfig, devices } from '@playwright/test';
import { VIEWPORTS } from './fixtures/devices';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: isCI ? 4 : 1,
  reporter: isCI
    ? [['html', { open: 'never' }], ['github']]
    : [['html', { open: 'on-failure' }], ['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  globalSetup: './fixtures/stack',
  // Mobile projects are defined but not run by default — `scripts/run.ts`
  // restricts the suite to DEFAULT_SPEC_PROJECTS. Target them explicitly with
  // `bunx playwright test --project=iphone <spec>`.
  projects: VIEWPORTS.map((viewport) => ({
    name: viewport.name,
    use: { ...devices[viewport.device] },
  })),
});
