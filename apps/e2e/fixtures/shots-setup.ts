import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';
import { signIn } from './auth';
import { createAccount, createHolding } from './ui';

// `import.meta.dir` is Bun-only and this module is loaded by the Playwright
// runner under Node; resolve the standard ESM way instead.
const E2E_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

/** Playwright-format storage state for the harness user. Gitignored. */
export const SESSION_FILE = resolve(E2E_ROOT, '.shots-session.json');

/**
 * Routes captured when `SHOT_ROUTES` isn't set. Kept to the surfaces a UI
 * change is most likely to touch; narrow with `--routes=/,/holdings`, or point
 * the harness at what you're building with `--routes=/v3`.
 */
const DEFAULT_ROUTES = [
  '/',
  '/holdings',
  '/accounts',
  '/institutions',
  '/vaults',
  '/groups',
  '/payments',
  '/add-data',
  '/settings',
];

/**
 * Fixed portfolio seeded once per harness user. Deterministic on purpose:
 * identical data across runs is what makes two screenshot sets comparable.
 * Fiat-only — crypto tokens arrive from a CoinGecko sync a local stack may
 * never have run, whereas these rows ship in migration 0000.
 */
const PORTFOLIO = [
  {
    account: 'Shots Checking',
    type: 'Checking Account',
    holdings: [{ symbol: 'USD', quantity: '12500' }],
  },
  {
    account: 'Shots Savings',
    type: 'Savings Account',
    holdings: [{ symbol: 'EUR', quantity: '8200' }],
  },
  {
    account: 'Shots Brokerage',
    type: 'Investment Account',
    holdings: [
      { symbol: 'GBP', quantity: '4300' },
      { symbol: 'CHF', quantity: '1750' },
    ],
  },
];

export interface ShotOptions {
  routes: string[];
  outDir: string;
  fullPage: boolean;
  settleMs: number;
}

/**
 * Capture options, read from the environment so `scripts/shots.ts` can pass
 * CLI flags through to the Playwright runner in the child process.
 */
export function shotOptions(env: NodeJS.ProcessEnv = process.env): ShotOptions {
  const routes = env.SHOT_ROUTES?.split(',')
    .map((route) => route.trim())
    .filter((route) => route.length > 0);
  return {
    routes: routes?.length ? routes : DEFAULT_ROUTES,
    outDir: resolve(E2E_ROOT, env.SHOT_OUT ?? 'shots'),
    fullPage: env.SHOT_VIEWPORT_ONLY !== '1',
    settleMs: Number(env.SHOT_SETTLE_MS ?? 1200),
  };
}

export function slugify(route: string): string {
  const trimmed = route.replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0) return 'index';
  return trimmed.replace(/[^a-zA-Z0-9]+/g, '-');
}

async function assertStackUp(): Promise<void> {
  const probes: Array<[label: string, url: string]> = [
    ['api', `${API_BASE_URL}/health`],
    ['frontend', BASE_URL],
  ];
  for (const [label, url] of probes) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      throw new Error(
        `${label} not reachable at ${url} (${(err as Error).message}). ` +
          'Start the stack first: `bun dev:stack` from the repo root.'
      );
    }
  }
}

async function isSignedIn(page: Page): Promise<boolean> {
  const res = await page.request.get(`${API_BASE_URL}/trpc/holdings.getWithDetails?input=%7B%7D`);
  return res.ok();
}

async function seedPortfolio(page: Page): Promise<void> {
  for (const spec of PORTFOLIO) {
    const account = await createAccount(page, { name: spec.account, type: spec.type });
    for (const holding of spec.holdings) {
      try {
        await createHolding(page, {
          accountId: account.id,
          symbol: holding.symbol,
          quantity: holding.quantity,
        });
      } catch (err) {
        // A holding is created by a worker job that also fetches a price;
        // stacks without upstream access fail the pricing half. The account
        // still renders, so a partial portfolio beats no screenshots at all.
        console.warn(
          `  ! ${spec.account}/${holding.symbol} not seeded: ${(err as Error).message.split('\n')[0]}`
        );
      }
    }
  }
}

async function storedSessionIsValid(browser: Browser): Promise<boolean> {
  if (!existsSync(SESSION_FILE)) return false;
  const context = await browser.newContext({ storageState: SESSION_FILE, baseURL: BASE_URL });
  try {
    return await isSignedIn(await context.newPage());
  } finally {
    await context.close();
  }
}

/**
 * Playwright globalSetup for the shots config. Confirms the stack is up and
 * leaves a signed-in, seeded storage state at `SESSION_FILE` for every
 * viewport project to load.
 *
 * The session is reused across runs on purpose: the API rate-limits sign-ins
 * to 6 per IP per hour, so re-authenticating every run would lock the harness
 * out after a handful of invocations. `SHOT_FRESH=1` (`--fresh`) forces a new
 * user and a new seed.
 */
export default async function globalSetup(): Promise<void> {
  await assertStackUp();
  const browser = await chromium.launch();
  try {
    if (process.env.SHOT_FRESH !== '1' && (await storedSessionIsValid(browser))) {
      console.log('Reusing stored session (--fresh to reseed).');
      return;
    }

    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();
    const { email } = await signIn({ page, label: 'shots' });
    console.log(`Signed in as ${email}; seeding portfolio…`);
    await seedPortfolio(page);
    await context.storageState({ path: SESSION_FILE });
    await context.close();
  } finally {
    await browser.close();
  }
}
