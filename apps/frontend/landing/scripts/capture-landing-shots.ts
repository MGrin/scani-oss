import { chromium } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Captures screenshots of the Scani app for use on the landing page.
 * Outputs to apps/frontend/landing/public/screenshots/
 *
 * Usage:
 *   SCANI_EMAIL=you@example.com SCANI_PASSWORD=yourpass bun run apps/frontend/landing/scripts/capture-landing-shots.ts
 */

const APP_URL = process.env.SCANI_APP_URL ?? 'https://app.scani.xyz';
const EMAIL = process.env.SCANI_EMAIL ?? '';
const PASSWORD = process.env.SCANI_PASSWORD ?? '';

const OUT_DIR = path.resolve(__dirname, '../public/screenshots');

const SHOTS = [
  { id: 'dashboard', path: '/', waitFor: '[data-testid="net-worth-chart"], .recharts-surface, canvas', filename: 'dashboard.png' },
  { id: 'holdings', path: '/holdings', waitFor: 'table, [role="table"], .holdings-list', filename: 'holdings.png' },
  { id: 'integrations', path: '/integrations', waitFor: 'text=CRYPTO EXCHANGES', filename: 'integrations.png' },
  { id: 'accounts', path: '/accounts', waitFor: 'text=Accounts', filename: 'accounts.png' },
  { id: 'institutions', path: '/institutions', waitFor: 'text=Institutions', filename: 'institutions.png' },
  { id: 'manual-entry', path: '/manual-entry', waitFor: 'text=Manual Entry', filename: 'manual-entry.png' },
  { id: 'import', path: '/import', waitFor: 'text=Import File', filename: 'import.png' },
  { id: 'wallet-import', path: '/wallet-import', waitFor: 'text=Import Crypto Wallet', filename: 'wallet-import.png' },
  { id: 'jobs', path: '/jobs', waitFor: 'text=Completed', filename: 'jobs.png' },
];

async function main() {
  if (!EMAIL || !PASSWORD) {
    throw new Error('SCANI_EMAIL and SCANI_PASSWORD environment variables are required');
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
  });
  const page = await context.newPage();

  // Log in
  console.log('Logging in...');
  await page.goto(`${APP_URL}/login`);
  await page.waitForLoadState('networkidle');

  // Fill email
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  await emailInput.fill(EMAIL);

  // Fill password
  const passwordInput = page.locator('input[type="password"], input[name="password"]').first();
  await passwordInput.fill(PASSWORD);

  // Submit
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`${APP_URL}/**`, { timeout: 15000 });
  console.log('Logged in successfully');

  // Give React time to settle
  await page.waitForTimeout(2000);

  for (const shot of SHOTS) {
    console.log(`Capturing ${shot.id}...`);
    await page.goto(`${APP_URL}${shot.path}`);
    await page.waitForLoadState('networkidle');

    // Wait for meaningful content
    try {
      await page.waitForSelector(shot.waitFor, { timeout: 10000 });
    } catch {
      console.warn(`  waitFor selector not found for ${shot.id}, proceeding anyway`);
    }

    // Extra settle time for charts/canvas
    await page.waitForTimeout(2500);

    const outPath = path.join(OUT_DIR, shot.filename);
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`  Saved ${outPath}`);
  }

  await browser.close();
  console.log('Done!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
