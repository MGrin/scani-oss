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

/** Playwright-format storage state for the baseline user. Gitignored. */
export const VISUAL_SESSION_FILE = resolve(E2E_ROOT, '.visual-session.json');

/**
 * A second signed-in user with nothing in it, for the screens declared
 * `session: 'empty'` (SC-473).
 *
 * A separate account rather than a wiped one. Home decides between its
 * onboarding panel and its portfolio on `counts.holdings === 0`, so the empty
 * state is only reachable by *being* a new account — and emptying the seeded
 * one to photograph it would delete what every other baseline here is a
 * picture of. Two sessions cost one extra sign-in on the first run of a
 * stack and nothing on the ones after it, which is the same bargain the
 * seeded session already makes with the api's 6-per-hour sign-in limit.
 */
export const VISUAL_EMPTY_SESSION_FILE = resolve(E2E_ROOT, '.visual-empty-session.json');

/**
 * A third signed-in user holding enough accounts to make the allocation bar
 * FOLD, for the screen declared `session: 'allocation'` (SC-815).
 *
 * A separate account rather than more accounts on the seeded one, for the
 * reason `screens.ts` gives about what stays out: the eleven existing
 * baselines are pictures of the seeded portfolio, and growing it to reach a
 * fold would rewrite every one of them to buy coverage on a single block.
 * A third sign-in costs one more of the api's 6-per-IP-per-hour budget on the
 * first run of a stack and nothing on the ones after it — the same bargain
 * the empty session already makes.
 */
export const VISUAL_ALLOCATION_SESSION_FILE = resolve(E2E_ROOT, '.visual-allocation-session.json');

/**
 * The websocket `scripts/visual.ts` publishes for the containerised browser.
 * There is no local fallback on purpose: a baseline rendered by whatever
 * Chromium happens to be on the host is exactly the artefact this harness
 * exists to avoid producing.
 */
export function remoteEndpoint(): string {
  const ws = process.env.PW_VISUAL_WS;
  if (!ws) {
    throw new Error(
      'PW_VISUAL_WS is unset — the visual harness renders in the Playwright ' +
        'container, never on the host. Run it through `bun run visual`.'
    );
  }
  return ws;
}

/**
 * Every holding is denominated in the base currency, and that is the whole
 * point: a EUR row has to be converted to be displayed, so its rendered figure
 * is a function of whatever FX rate the stack last fetched rather than of this
 * list. The screenshot harness next door can afford that; a committed baseline
 * cannot.
 *
 * Fiat rather than crypto for the reason `fixtures/shots-setup.ts` gives: USD
 * ships in migration `0000`, where a token identity from a CoinGecko sync only
 * exists on a stack that has run one.
 */
const PORTFOLIO = [
  {
    account: 'Everyday',
    type: 'Checking Account',
    holdings: [{ symbol: 'USD', quantity: '12500' }],
  },
  {
    account: 'Reserve',
    type: 'Savings Account',
    holdings: [{ symbol: 'USD', quantity: '48250' }],
  },
  {
    account: 'Brokerage',
    type: 'Investment Account',
    holdings: [{ symbol: 'USD', quantity: '132400' }],
  },
];

/**
 * Eight accounts, every holding USD, for the folding allocation bar.
 *
 * EIGHT, and the first reason written here for it was wrong. It claimed seven
 * would fold a tail of exactly one, indistinguishable in a picture from a
 * seventh segment simply drawn. `foldAllocation` makes that impossible: it
 * sets `keepable = slots - 1` the moment the parts outnumber the budget, so a
 * budget-triggered fold always stands for at least TWO — its own comment says
 * so. Seven accounts would have folded perfectly well.
 *
 * The real reason is headroom. `MIN_VISIBLE_SHARE` folds any part under 1%
 * independently of the budget, so a seed sized exactly at the threshold can
 * stop folding for a reason that has nothing to do with the count. At eight,
 * five are named and three fold, which leaves room for a share to drift
 * without the screen quietly becoming a picture of something else.
 *
 * ALL USD, and that is a constraint rather than a convenience: a non-USD
 * holding is converted for display, so its rendered figure is a function of
 * whatever FX rate the stack last fetched. `PORTFOLIO` above says the same
 * thing and this seed is under the same rule.
 *
 * The bar this feeds is cut BY ACCOUNT, not by token type. SC-815 was opened
 * to widen the seed to seven token TYPES and that is unreachable: five exist
 * in `token_types`, and all 136 tokens seeded by migration `0000` are fiat, so
 * a stack that has run no CoinGecko sync can produce exactly one type. Cutting
 * by account needs no token the migrations do not already ship (SC-820).
 *
 * Distinct, descending quantities on purpose. Order decides colour — slot N
 * goes to the Nth item — so equal values would leave the ramp's assignment up
 * to a sort's tie-breaking and the baseline would be a picture of that.
 */
const ALLOCATION_PORTFOLIO = [
  { account: 'Current', type: 'Checking Account', quantity: '184000' },
  { account: 'Emergency Fund', type: 'Savings Account', quantity: '96500' },
  { account: 'Retirement', type: 'Investment Account', quantity: '73250' },
  { account: 'Taxable Brokerage', type: 'Investment Account', quantity: '54800' },
  { account: 'Joint Savings', type: 'Savings Account', quantity: '31900' },
  { account: 'Travel Fund', type: 'Savings Account', quantity: '18400' },
  { account: 'Old Current', type: 'Checking Account', quantity: '9750' },
  { account: 'Cash Buffer', type: 'Other', quantity: '4200' },
];

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
      // Unlike the screenshot harness, a partial seed is not tolerable here:
      // a missing row renders an empty state, and an empty state captured as
      // a baseline is a gate that passes forever on a screen it never saw.
      await createHolding(page, {
        accountId: account.id,
        symbol: holding.symbol,
        quantity: holding.quantity,
        jobTimeoutMs: 120_000,
      });
    }
  }
}

/**
 * The eight-account portfolio. Same intolerance of a partial seed as
 * `seedPortfolio`: a missing account here silently lowers the part count, and
 * below seven the bar stops folding — which is the one thing the screen this
 * seeds exists to photograph. The spec asserts the fold rendered rather than
 * trusting this loop (`foldedAllocation` in `screens.ts`).
 */
async function seedAllocationPortfolio(page: Page): Promise<void> {
  for (const spec of ALLOCATION_PORTFOLIO) {
    const account = await createAccount(page, { name: spec.account, type: spec.type });
    await createHolding(page, {
      accountId: account.id,
      symbol: 'USD',
      quantity: spec.quantity,
      jobTimeoutMs: 120_000,
    });
  }
}

async function storedSessionIsValid(browser: Browser, file: string): Promise<boolean> {
  if (!existsSync(file)) return false;
  const context = await browser.newContext({ storageState: file, baseURL: BASE_URL });
  try {
    return await isSignedIn(await context.newPage());
  } finally {
    await context.close();
  }
}

/**
 * Signs a new user in and leaves its storage state at `file`, running `seed`
 * against the signed-in page first when there is one to run.
 */
async function establishSession(
  browser: Browser,
  file: string,
  label: string,
  seed?: (page: Page) => Promise<void>
): Promise<void> {
  const context = await browser.newContext({ baseURL: BASE_URL });
  const page = await context.newPage();
  const { email } = await signIn({ page, label });
  // intentional: names the user the baselines taken under this session describe
  console.log(`Signed in as ${email}${seed ? '; seeding portfolio…' : ' (left empty)'}`);
  await seed?.(page);
  await context.storageState({ path: file });
  await context.close();
}

/**
 * Playwright globalSetup for the visual config: confirms the stack is up and
 * leaves a signed-in, seeded storage state at `VISUAL_SESSION_FILE`, an empty
 * one at `VISUAL_EMPTY_SESSION_FILE`, and an eight-account one at
 * `VISUAL_ALLOCATION_SESSION_FILE`.
 *
 * Three sign-ins on a cold run, against the api's limit of 6 per IP per hour.
 * That is the headroom this loop has, and a fourth session is the change that
 * would spend it.
 *
 * The session is reused across runs for the same reason the screenshot
 * harness reuses its own — the API rate-limits sign-ins to 6 per IP per hour —
 * and it is a *separate* session from that harness's because the two seed
 * different portfolios. `VISUAL_FRESH=1` forces a new user and a new seed.
 */
export default async function globalSetup(): Promise<void> {
  await assertStackUp();
  const browser = await chromium.connect(remoteEndpoint(), { exposeNetwork: '<loopback>' });
  const fresh = process.env.VISUAL_FRESH === '1';
  try {
    for (const [file, label, seed] of [
      [VISUAL_SESSION_FILE, 'visual', seedPortfolio],
      [VISUAL_EMPTY_SESSION_FILE, 'visual-empty', undefined],
      [VISUAL_ALLOCATION_SESSION_FILE, 'visual-allocation', seedAllocationPortfolio],
    ] as const) {
      if (!fresh && (await storedSessionIsValid(browser, file))) {
        // intentional: tells the operator which user the baselines describe
        console.log(`Reusing stored ${label} session (VISUAL_FRESH=1 to reseed).`);
        continue;
      }
      await establishSession(browser, file, label, seed);
    }
  } finally {
    await browser.close();
  }
}
