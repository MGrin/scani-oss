import { defineConfig, devices } from '@playwright/test';
import { remoteEndpoint } from './fixtures/visual-setup';

/**
 * Config for `bun run visual` — the visual-regression gate (SC-24), separate
 * from both the spec suite and the screenshot harness for the same reason
 * those two are separate from each other: a capture pass must never join a
 * test run.
 *
 * Four decisions, each of which is why a baseline produced here is comparable
 * to the next one produced here:
 *
 * 1. **Every pixel is rendered in the Playwright container, never on the
 *    host.** `connectOptions` points at a `playwright run-server` inside
 *    `mcr.microsoft.com/playwright:v<version>-noble`, and `scripts/visual.ts`
 *    is what starts it. macOS and Linux do not rasterise the same text, so a
 *    baseline committed from a laptop is a baseline that fails on every other
 *    machine. `exposeNetwork: '<loopback>'` is what lets the browser inside
 *    the container reach the stack on the host's `localhost` — which matters
 *    beyond convenience, because the SPA is built against
 *    `VITE_API_URL=http://localhost:3011` and its session cookie is scoped to
 *    the host `localhost`.
 * 2. **Chromium at both viewports, and no second engine.** What a baseline
 *    asserts is our CSS, not an engine's fidelity to a phone. A WebKit copy of
 *    every screen would double the images to review for a difference that is
 *    never the defect being hunted, and the accessibility gate already walks
 *    WebKit.
 * 3. **The snapshot path names the renderer, not the runner.** Playwright's
 *    default template interpolates `{platform}` from `process.platform` —
 *    the *client's* platform. Left alone it would file container-rendered
 *    PNGs under `-darwin`, and a Linux CI would then look for baselines that
 *    do not exist while ignoring the ones that do.
 * 4. **Zero tolerance on the diff.** The renderer is deterministic — verified
 *    byte-identical across repeated runs and across fresh containers — so any
 *    non-zero pixel budget only buys the ability to miss a one-pixel shift.
 *    A threshold here would be a guess; the measurement says it is not needed.
 */
export default defineConfig({
  testDir: './visual',
  fullyParallel: false,
  // The screens share one seeded user and one API rate-limit budget.
  workers: 1,
  // A retry would re-render an identical screenshot against an identical
  // baseline. If it failed, it failed.
  retries: 0,
  timeout: 3 * 60_000,
  reporter: [['list']],
  globalSetup: './fixtures/visual-setup',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    connectOptions: { wsEndpoint: remoteEndpoint(), exposeNetwork: '<loopback>' },
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    locale: 'en-US',
    timezoneId: 'UTC',
    contextOptions: { reducedMotion: 'reduce' },
  },
  expect: {
    toHaveScreenshot: { maxDiffPixels: 0, animations: 'disabled', caret: 'hide' },
  },
  projects: [
    { name: 'desktop', grep: /@desktop/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'phone',
      grep: /@phone/,
      use: {
        // The iPhone 15 Pro descriptor for its 393×852 viewport — the same
        // width the accessibility gate and the screenshot harness use — but
        // driven by Chromium (see decision 2) and at DPR 1. A device pixel
        // ratio of 3 would triple every baseline's byte size to assert the
        // same layout.
        ...devices['iPhone 15 Pro'],
        browserName: 'chromium',
        deviceScaleFactor: 1,
      },
    },
  ],
});
