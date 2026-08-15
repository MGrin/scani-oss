import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from '@playwright/test';
import { SESSION_FILE, shotOptions, slugify } from '../fixtures/shots-setup';

const opts = shotOptions();

// The signed-in, seeded state produced by the shots globalSetup. Locale and
// timezone are pinned so timestamps and number formats don't churn run to run.
test.use({
  storageState: SESSION_FILE,
  locale: 'en-US',
  timezoneId: 'UTC',
});

test('capture routes', async ({ page }, testInfo) => {
  const deviceDir = resolve(opts.outDir, testInfo.project.name);
  await mkdir(deviceDir, { recursive: true });

  for (const route of opts.routes) {
    const path = resolve(deviceDir, `${slugify(route)}.png`);
    await page.goto(route, { waitUntil: 'load' });
    // Best-effort: pages holding a live SSE subscription never reach
    // networkidle, and the settle window below covers those.
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(opts.settleMs);
    await page.screenshot({ path, fullPage: opts.fullPage });
    // intentional: the path list is the deliverable — an agent reads these
    console.log(`  ${testInfo.project.name} ${route} → ${path}`);
  }
});
