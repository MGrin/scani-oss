/**
 * Capture landing-page product screenshots in light + dark × desktop +
 * mobile, against a real running app. Authenticates via the
 * screenshot-bot Better-Auth plugin (see
 * `apps/backend/api/src/auth/screenshot-bot-plugin.ts`).
 *
 * Outputs `apps/frontend/landing/public/screenshots/<slug>-<theme>-<device>.png`
 * — consumed by `apps/frontend/landing/src/components/sections/ProductShowcase.tsx`,
 * which picks the variant matching the visitor's system theme + viewport.
 *
 * Required env:
 *   SCREENSHOT_BOT_SECRET  shared secret matching the api's value
 *   SCANI_APP_URL          defaults to https://app.scani.xyz
 *   SCANI_API_URL          defaults to https://api.scani.xyz
 *
 * Usage:
 *   bunx playwright install --with-deps chromium
 *   SCREENSHOT_BOT_SECRET=… bun scripts/capture-landing-shots.ts
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

type Theme = 'light' | 'dark';
type Device = 'desktop' | 'mobile';

interface Shot {
  slug: string;
  path: string;
  waitFor: string;
}

const SHOTS: ReadonlyArray<Shot> = [
  { slug: 'dashboard', path: '/', waitFor: 'text=Your portfolio overview' },
  { slug: 'holdings', path: '/holdings', waitFor: 'text=/\\d+ holdings/' },
  { slug: 'integrations', path: '/integrations', waitFor: 'text=Crypto Exchanges' },
  { slug: 'accounts', path: '/accounts', waitFor: 'text=/\\d+ accounts/' },
  { slug: 'institutions', path: '/institutions', waitFor: 'text=/\\d+ institutions/' },
  { slug: 'jobs', path: '/jobs', waitFor: '[role="heading"]:has-text("Active")' },
  { slug: 'settings', path: '/settings', waitFor: '#currency' },
];

const THEMES: ReadonlyArray<Theme> = ['light', 'dark'];
const DEVICES: ReadonlyArray<Device> = ['desktop', 'mobile'];

async function main() {
  const appUrl = (process.env.SCANI_APP_URL ?? 'https://app.scani.xyz').replace(/\/$/, '');
  const apiUrl = (process.env.SCANI_API_URL ?? 'https://api.scani.xyz').replace(/\/$/, '');
  const secret = process.env.SCREENSHOT_BOT_SECRET;

  if (!secret) {
    console.error('SCREENSHOT_BOT_SECRET is required.');
    process.exit(1);
  }

  const playwright = await import('playwright').catch(() => null);
  if (!playwright) {
    console.error("playwright isn't installed. Run: bunx playwright install --with-deps chromium");
    process.exit(1);
  }
  const { chromium, devices } = playwright;

  const outDir = resolve(import.meta.dir, '..', 'apps/frontend/landing/public/screenshots');
  await mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  try {
    for (const device of DEVICES) {
      const baseContextOpts =
        device === 'mobile'
          ? devices['iPhone 14']
          : { viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 };

      for (const theme of THEMES) {
        console.log(`\n=== ${device} / ${theme} ===`);
        const ctx = await browser.newContext({
          ...baseContextOpts,
          colorScheme: theme,
        });

        await ctx.addInitScript((t) => {
          try {
            window.localStorage.setItem('scani-theme', t);
          } catch {
            // localStorage can be unavailable on about:blank; the next
            // navigation triggers this again with a real origin.
          }
        }, theme);

        const signInUrl = `${apiUrl}/api/auth/screenshot-bot/sign-in`;
        const authRes = await ctx.request.post(signInUrl, {
          headers: { Authorization: `Bearer ${secret}` },
        });
        if (!authRes.ok()) {
          throw new Error(
            `Bot sign-in failed (${authRes.status()} ${authRes.statusText()}): ${await authRes.text()}`
          );
        }

        for (const shot of SHOTS) {
          const page = await ctx.newPage();
          const target = `${appUrl}${shot.path}`;
          try {
            await page.goto(target, { waitUntil: 'networkidle', timeout: 45_000 });
            await page
              .waitForSelector(shot.waitFor, { timeout: 20_000, state: 'visible' })
              .catch((err) => {
                console.warn(
                  `  [${shot.slug}] selector "${shot.waitFor}" not visible — capturing anyway (${(err as Error).message})`
                );
              });
            // Small settle delay so fonts + charts render before snap.
            await page.waitForTimeout(750);
            const out = resolve(outDir, `${shot.slug}-${theme}-${device}.png`);
            await page.screenshot({ path: out, fullPage: false });
            console.log(`  [${shot.slug}-${theme}-${device}] → ${out}`);
          } finally {
            await page.close();
          }
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
