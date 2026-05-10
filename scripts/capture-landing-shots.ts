/**
 * Capture three product screenshots for the landing page hero strip.
 *
 * Output: `apps/frontend/landing/public/screenshots/{dashboard,holdings,integrations}.png`
 * (lazy-loaded by `apps/frontend/landing/src/components/sections/ProductShowcase.tsx`).
 *
 * Run locally with a real session:
 *
 *   bun add -d playwright
 *   bunx playwright install chromium
 *   SCANI_DEMO_EMAIL="…" SCANI_DEMO_OTP="…" \
 *     bun scripts/capture-landing-shots.ts
 *
 * Why a script (not a one-off): the hero refresh needs the same crops
 * each time, and we'd like to re-run on UI changes without re-cropping
 * by hand. Run it whenever the dashboard / holdings / integrations
 * pages change visually.
 *
 * The script signs in via Better-Auth's email-OTP flow against
 * https://app.scani.xyz. It expects:
 *   - SCANI_DEMO_EMAIL: an account with realistic-looking demo data
 *   - SCANI_DEMO_OTP:   the most recent OTP the inbox received
 *                       (or use SCANI_DEMO_SESSION_COOKIE to skip OTP)
 *
 * If you don't have demo credentials, the placeholders rendered by
 * `Screenshot` in `ProductShowcase.tsx` will keep the page rendering;
 * skipping the script is safe — it just leaves real screenshots for
 * a follow-up.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

interface Shot {
  slug: 'dashboard' | 'holdings' | 'integrations';
  path: string;
  waitForSelector: string;
}

const SHOTS: ReadonlyArray<Shot> = [
  { slug: 'dashboard', path: '/v2', waitForSelector: '[data-testid="portfolio-overview"]' },
  { slug: 'holdings', path: '/v2/holdings', waitForSelector: 'table' },
  { slug: 'integrations', path: '/v2/integrations', waitForSelector: 'h1' },
];

async function main() {
  const baseUrl = process.env.SCANI_BASE_URL ?? 'https://app.scani.xyz';
  const email = process.env.SCANI_DEMO_EMAIL;
  const otp = process.env.SCANI_DEMO_OTP;
  const sessionCookie = process.env.SCANI_DEMO_SESSION_COOKIE;

  if (!sessionCookie && (!email || !otp)) {
    console.error(
      'Need either SCANI_DEMO_SESSION_COOKIE, or both SCANI_DEMO_EMAIL + SCANI_DEMO_OTP.'
    );
    process.exit(1);
  }

  const playwright = await import('playwright').catch(() => null);
  if (!playwright) {
    console.error(
      "playwright isn't installed. Run: `bun add -d playwright && bunx playwright install chromium`"
    );
    process.exit(1);
  }

  const outDir = resolve(__dirname, '..', 'apps/frontend/landing/public/screenshots');
  await mkdir(outDir, { recursive: true });

  const browser = await playwright.chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
  });

  if (sessionCookie) {
    await ctx.addCookies([
      {
        name: 'better-auth.session_token',
        value: sessionCookie,
        domain: new URL(baseUrl).hostname,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ]);
  } else {
    // Email-OTP login flow. The exact selectors are app-side so update
    // them if Better-Auth's email OTP UI changes.
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/auth`);
    await page.fill('input[type=email]', email!);
    await page.click('button[type=submit]');
    await page.fill('input[name=code]', otp!);
    await page.click('button[type=submit]');
    await page.waitForURL((u) => !u.pathname.startsWith('/auth'), { timeout: 30_000 });
    await page.close();
  }

  for (const shot of SHOTS) {
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}${shot.path}`, { waitUntil: 'networkidle' });
    await page.waitForSelector(shot.waitForSelector, { timeout: 15_000 }).catch(() => {
      console.warn(
        `[${shot.slug}] selector "${shot.waitForSelector}" never appeared; capturing anyway`
      );
    });
    const out = resolve(outDir, `${shot.slug}.png`);
    await page.screenshot({ path: out, fullPage: false });
    console.log(`[${shot.slug}] → ${out}`);
    await page.close();
  }

  await browser.close();
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
