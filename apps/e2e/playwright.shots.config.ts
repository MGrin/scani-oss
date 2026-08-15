import { defineConfig, devices } from '@playwright/test';
import { VIEWPORTS } from './fixtures/devices';

/**
 * Config for `bun run shots` — the screenshot harness, not the spec suite.
 * Separate from `playwright.config.ts` so the capture pass never joins a test
 * run and a test run never joins a capture: different testDir, no retries, no
 * parallelism (the shots share one seeded user), and its own globalSetup that
 * signs in and seeds.
 *
 * Which viewports run is decided by the `--project` flags `scripts/shots.ts`
 * passes; capture options arrive via SHOT_* env vars (see fixtures/shots-setup).
 */
export default defineConfig({
  testDir: './capture',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // One test walks the whole route list, so the budget is per-run, not per-page.
  timeout: 5 * 60_000,
  reporter: [['list']],
  globalSetup: './fixtures/shots-setup',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    // Animations mid-flight are the main source of run-to-run pixel churn.
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: VIEWPORTS.map((viewport) => ({
    name: viewport.name,
    use: { ...devices[viewport.device] },
  })),
});
