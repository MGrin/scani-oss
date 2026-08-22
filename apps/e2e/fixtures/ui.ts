// `test` here is only ever used for `test.info()`, which reads the runner's
// current TestInfo and is the same object whichever `test` you ask. The suite's
// own `fixtures/test` is deliberately NOT used: this module is reachable from
// `visual-setup` and `shots-setup`, which Playwright loads as `globalSetup`,
// and importing it there would run `base.extend()` in a module graph that has
// no test runner around it yet. Nothing here makes a request, so the
// rate-limit identity `fixtures/test` exists to attach is not in play.
import { type Page, type TestInfo, test } from '@playwright/test';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';
const ORIGIN = 'http://localhost:5173';

export interface CreatedAccount {
  id: string;
  name: string;
  institutionId: string;
}

interface CreateAccountOptions {
  name: string;
  institutionName?: string;
  /**
   * Account-type *name* (e.g. "Checking Account", "Investment Account",
   * "Cryptocurrency"). Defaults to "Checking Account" — the most generic
   * seeded type for the bank-flavoured default institution below.
   */
  type?: string;
}

interface IdName {
  id: string;
  name: string;
}

async function trpcGet<T>(page: Page, procedure: string): Promise<T> {
  const res = await page.request.get(`${API_BASE_URL}/trpc/${procedure}?input=%7B%7D`);
  if (!res.ok()) {
    throw new Error(`trpc.${procedure} failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

async function trpcMutate<T>(
  page: Page,
  procedure: string,
  data: Record<string, unknown>
): Promise<T> {
  const res = await page.request.post(`${API_BASE_URL}/trpc/${procedure}`, {
    data,
    headers: { 'content-type': 'application/json', origin: ORIGIN },
  });
  if (!res.ok()) {
    throw new Error(`trpc.${procedure} failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as { result: { data: T } };
  return body.result.data;
}

/**
 * Drive the app to create a manual account for the signed-in user.
 *
 * Implementation note: the SPA exposes NO standalone "Add Account"
 * page — accounts are only ever created as a side-effect of two
 * flows:
 *   1. FileImportPage's `AccountSelectionStep` (when the user picks
 *      "Create new account"), which calls `batchOperations.ensureAccount`
 *      to provision the row up front before enqueueing the parse job.
 *   2. ManualEntryPage's `batchOperations.createHoldingsBatch`, which
 *      creates the account *together with* one or more holdings.
 *
 * Driving the file-import wizard end-to-end for every account-needing
 * test would require five UI steps + a parse-job round-trip per test,
 * dwarfing the value of UI coverage at the account layer. We therefore
 * call `batchOperations.ensureAccount` directly via tRPC — the same
 * mutation the wizard uses under the hood. The UI walk of that wizard
 * is covered separately by the imports specs (Task 15).
 *
 * The `accounts.update` and `accounts.delete` specs that build on this
 * helper still exercise the UI page (`/v2/accounts`) for navigation and
 * empty-state assertions; the create-step is the only piece that bypasses
 * the UI.
 */
export async function createAccount(
  page: Page,
  opts: CreateAccountOptions
): Promise<CreatedAccount> {
  const wantedInstitution = opts.institutionName ?? 'JPMorgan Chase';
  const wantedType = opts.type ?? 'Checking Account';

  const institutions = await trpcGet<IdName[]>(page, 'institutions.getAll');
  const institution = institutions.find((i) => i.name === wantedInstitution);
  if (!institution) {
    throw new Error(
      `Institution "${wantedInstitution}" not seeded; available: ${institutions
        .map((i) => i.name)
        .slice(0, 5)
        .join(', ')}…`
    );
  }

  const accountTypes = await trpcGet<IdName[]>(page, 'accountTypes.getAll');
  const accountType = accountTypes.find((t) => t.name === wantedType);
  if (!accountType) {
    throw new Error(
      `Account type "${wantedType}" not seeded; available: ${accountTypes
        .map((t) => t.name)
        .join(', ')}`
    );
  }

  const result = await trpcMutate<{ accountId: string }>(page, 'batchOperations.ensureAccount', {
    account: {
      institutionId: institution.id,
      name: opts.name,
      typeId: accountType.id,
    },
  });

  return { id: result.accountId, name: opts.name, institutionId: institution.id };
}

/**
 * Open an account's v3 record surface and wait for the query its title is
 * rendered from.
 *
 * `/accounts/<id>` is a v3 route, and v3's peek opens off the URL *before* its
 * data exists: until `accounts.getByUserIdWithSummary` answers, the drawer is
 * on screen titled "Loading". So the heading a caller is about to assert on is
 * already present and already a level-2 heading — it just carries the wrong
 * accessible name for the whole of that window, which is what an assertion
 * racing it fails against.
 *
 * The window is wide here because the stack serves the SPA from a Vite dev
 * server, which compiles the module graph on demand: the first navigation into
 * a v3 route pulls the whole tree one request at a time — 442 of them on the
 * run this replaced — and on a CI runner already driving four browser workers
 * the last of those landed 5.4s and 6.7s after the navigation, either side of
 * the 5s an assertion gets by default. `tests/a11y/v3-accessibility.spec.ts`
 * met the same cost and answers it the same way, by paying it somewhere the
 * budget is explicit rather than inside the assertion.
 *
 * Waiting on the response rather than widening the assertion is the point:
 * what the title needs is that query, not more seconds, and a number chosen to
 * cover the slowest run observed so far is a number the next slower runner
 * invalidates silently.
 */
export async function gotoAccountPeek(page: Page, accountId: string): Promise<void> {
  // Armed before navigating, not after. `page.goto` resolves on `load`, and
  // under Vite's dev server `load` already waits on the module graph — so by
  // the time it returns the query can have been asked and answered, and a
  // wait registered afterwards would sit there until it timed out.
  const accountsLoaded = page.waitForResponse(
    (res) => res.url().includes('accounts.getByUserIdWithSummary') && res.ok()
  );
  await page.goto(`/accounts/${accountId}`);
  await accountsLoaded;
}

export interface CreatedHolding {
  id: string;
  accountId: string;
  tokenId: string;
  symbol: string;
  balance: string;
}

interface CreateHoldingOptions {
  accountId: string;
  /** Token symbol — must resolve via `tokens.search` (e.g. "USD"). */
  symbol: string;
  /** Decimal-string balance, e.g. "1000". */
  quantity: string;
  /**
   * How long to wait for the worker. The `DEFAULT_JOB_TIMEOUT_MS` default is
   * comfortable for a spec that seeds one holding into an idle queue; a
   * fixture that seeds a whole portfolio behind the nightly rollup chain needs
   * longer, and a timeout there means the surface under test renders its empty
   * state and the assertion passes for the wrong reason.
   */
  jobTimeoutMs?: number;
}

interface TokenSearchHit {
  id?: string;
  symbol: string;
  source: 'database' | 'external';
}

/**
 * Poll interval, and why it backs off rather than staying at 250ms.
 *
 * The api admits 300 requests a minute per client, and since SC-489 that
 * budget belongs to one test rather than to a whole Playwright project. A flat
 * 250ms poll spends 240 of those 300 a minute on `jobs.status` alone — fine
 * for the seconds a job usually takes, and self-inflicted starvation for a
 * fixture waiting out a 120s job budget. Backing off to a second keeps a fast
 * job fast (first three polls inside 1.75s) and a slow one cheap.
 */
const POLL_MIN_MS = 250;
const POLL_MAX_MS = 1_000;

/**
 * How long a job wait is allowed to take before the fixture gives up.
 *
 * 30s was the previous value and it was never the operative one: it equalled
 * Playwright's default per-test budget, which starts earlier, so the test died
 * first every time — see `reserveJobWaitBudget`. 60s is the first number here a
 * job has actually been given, and it is sized for the contended laptop this
 * suite runs on locally rather than for the CI runner, where the same suite
 * finishes in about five minutes (SC-498).
 */
const DEFAULT_JOB_TIMEOUT_MS = 60_000;

/**
 * How far inside the test's budget the fixture's own deadline sits.
 *
 * It only has to cover the assertions that run after the wait returns. Small on
 * purpose: this is slack, not a second timeout.
 */
const TEST_BUDGET_MARGIN_MS = 5_000;

/**
 * A single `jobs.status` poll's own budget.
 *
 * Without one, a poll that hangs has no deadline of its own and simply spends
 * the budget reserved below — which reproduces the unnamed failure one level
 * down, as `apiRequestContext.get: Test timeout of Nms exceeded` pointing at a
 * line of this file rather than at the api that stopped answering.
 * `jobs.status` is a single indexed read; ten seconds is already pathological.
 */
const POLL_REQUEST_TIMEOUT_MS = 10_000;

interface JobStatusResponse<R = unknown> {
  state: 'queued' | 'active' | 'progress' | 'completed' | 'failed' | 'not_found';
  returnvalue?: R | null;
  failedReason?: string | null;
}

/** A job state, or `none` when no poll ever returned one. */
export type ObservedJobState = JobStatusResponse['state'] | 'none';

/**
 * Buy this wait its own room inside the test's budget, so that a job which does
 * not finish is reported by THIS fixture and not by Playwright.
 *
 * WHY IT EXISTS (SC-498). `playwright.config.ts` sets no `timeout`, so a test
 * gets Playwright's 30s default — and the wait below used to default to 30s as
 * well, while starting some seconds into the test. The fixture's deadline was
 * therefore unreachable: Playwright's fired first, at whichever `await` the
 * fixture happened to be sitting on, and reported `Test timeout of 30000ms
 * exceeded` against a line of test plumbing. A red run then read as a product
 * failure, and two threads spent their time establishing that it was not one.
 *
 * The same arithmetic silently voided every caller who had already diagnosed
 * this and asked for longer: 45s in `imports/csv-import`, 60s in
 * `imports/screenshot-parse`, 90s in `wallet-import/import-flow`, 120s in
 * `a11y/v3-accessibility`. None of those numbers could be reached. They are
 * real for the first time.
 *
 * Playwright's timeout slot is `deadline = start + (timeout - elapsed)`, so
 * raising `timeout` raises the remaining budget by exactly as much, at once.
 * Adding rather than assigning is what makes it safe to call twice in one
 * test: two waits reserve two budgets.
 *
 * It reserves unconditionally — including when the job goes on to finish in two
 * seconds, and when the test's budget already looks generous. Both temptations
 * to skip it are unavailable rather than merely unattractive: how long the job
 * will take is the thing being measured, and `elapsed` is not exposed to a
 * fixture, so "already big enough" is not a question this code can ask. And a
 * budget can only be extended BEFORE its deadline passes; there is no second
 * chance to name the cause after Playwright has already named the wrong one.
 *
 * It does nothing when no test is running, which is not a fallback and not a
 * guess. `createHolding` below is also called from `fixtures/visual-setup.ts`
 * and `fixtures/shots-setup.ts`, both of which are `globalSetup` — they run
 * before any test exists, and there is no per-test budget there to be beaten
 * to the deadline by. `test.info()` throws in exactly one circumstance, which
 * is that one: playwright's implementation is `const info = currentTestInfo();
 * if (!info) throw new Error('test.info() can only be called while test is
 * running')`, and it raises nothing else. So the catch has a single meaning
 * rather than a plausible one.
 */
function reserveJobWaitBudget(waitMs: number): void {
  let info: TestInfo;
  try {
    info = test.info();
  } catch {
    return;
  }
  // 0 means this test opted out of timing out; there is nothing to reserve from.
  if (info.timeout === 0) return;
  info.setTimeout(info.timeout + waitMs + TEST_BUDGET_MARGIN_MS);
}

/**
 * What a timed-out wait says, and why it reports the last observed state
 * instead of a conclusion.
 *
 * The distinction a reader needs is "the worker did not finish" versus "the
 * product is broken", and the job's last state is the only thing here that
 * carries it. Still `queued` at the deadline means nothing ever picked the job
 * up, so the code under test never ran and no assertion in the spec was ever
 * reached. `active` or `progress` means a worker took it and neither finished
 * nor failed it.
 *
 * The `active` branch deliberately draws no conclusion. A contended box and a
 * processor stuck in a loop produce exactly the same state, so a message that
 * told the reader to dismiss it would be how a real regression gets absorbed
 * into a known flake — strictly worse than the flake it tidied away.
 */
export function jobWaitTimeoutMessage(opts: {
  jobId: string;
  timeoutMs: number;
  polls: number;
  lastState: ObservedJobState;
  pickedUpAfterMs: number | null;
}): string {
  const { jobId, timeoutMs, polls, lastState, pickedUpAfterMs } = opts;
  const head =
    `waitForJob(${jobId}) gave up after ${(timeoutMs / 1000).toFixed(0)}s ` +
    `and ${polls} poll(s) of trpc/jobs.status.`;
  if (lastState === 'queued') {
    return (
      `${head} The job never left the queue: no worker picked it up. ` +
      'The code under test never ran, so nothing here is an assertion about the ' +
      'product — look at the worker.'
    );
  }
  if (lastState === 'active' || lastState === 'progress') {
    const pickedUp =
      pickedUpAfterMs === null
        ? ''
        : ` A worker took it after ${(pickedUpAfterMs / 1000).toFixed(1)}s.`;
    return (
      `${head}${pickedUp} Last observed state was "${lastState}": the job neither ` +
      "finished nor failed. The worker's own log is the only thing that says " +
      'whether it was slow or stuck.'
    );
  }
  return `${head} Last observed state was "${lastState}".`;
}

interface ManualHoldingsReturn {
  accountId: string;
  holdings: Array<{ id: string; tokenId: string; symbol: string; balance: string }>;
}

/**
 * Poll `jobs.status` until the BullMQ job reaches a terminal state
 * (completed | failed) or the timeout elapses. Returns the full job
 * status payload so callers can inspect `returnvalue` / `failedReason`.
 *
 * Throws if the job is `not_found` (the api evicted the row before we
 * saw a terminal state — almost always a worker-down or wrong-jobId bug)
 * or if the deadline passes without a terminal state.
 *
 * Used by every UI/API fixture that enqueues a worker job. Specs that
 * just need "wait until done, then assert via DB/UI" can call this
 * directly; specs that care about the job's `returnvalue` (e.g.
 * screenshot-parse picker payload) should pass `R` explicitly to type
 * the return.
 *
 * Extends the running test's timeout to cover its own wait, so the deadline
 * that fires is this one and the message that appears names the worker rather
 * than a line number — see `reserveJobWaitBudget`.
 */
export async function waitForJob<R = unknown>(
  page: Page,
  jobId: string,
  opts: { timeoutMs?: number } = {}
): Promise<JobStatusResponse<R>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  reserveJobWaitBudget(timeoutMs);
  const start = Date.now();
  const deadline = start + timeoutMs;
  let intervalMs = POLL_MIN_MS;
  let polls = 0;
  let lastState: ObservedJobState = 'none';
  let pickedUpAfterMs: number | null = null;
  while (Date.now() < deadline) {
    const statusInput = encodeURIComponent(JSON.stringify({ jobId }));
    const res = await page.request.get(`${API_BASE_URL}/trpc/jobs.status?input=${statusInput}`, {
      timeout: POLL_REQUEST_TIMEOUT_MS,
    });
    polls += 1;
    if (!res.ok()) {
      throw new Error(`trpc.jobs.status failed: ${res.status()} ${await res.text()}`);
    }
    const body = (await res.json()) as { result: { data: JobStatusResponse<R> } };
    const data = body.result.data;
    lastState = data.state;
    if (data.state !== 'queued' && pickedUpAfterMs === null) pickedUpAfterMs = Date.now() - start;
    if (data.state === 'completed' || data.state === 'failed') return data;
    if (data.state === 'not_found') {
      throw new Error(`Job ${jobId} not found (worker down? wrong queue?)`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
    intervalMs = Math.min(intervalMs * 2, POLL_MAX_MS);
  }
  throw new Error(jobWaitTimeoutMessage({ jobId, timeoutMs, polls, lastState, pickedUpAfterMs }));
}

/**
 * Create a manual holding in the given account by calling the same
 * `batchOperations.createHoldingsBatch` mutation the ManualEntryPage
 * uses, with an existing `accountId` so no new account is created.
 *
 * Implementation note: the SPA has no standalone "Add Holding to existing
 * account" route — every manual-entry flow goes through the same multi-step
 * ManualEntryPage wizard, which ultimately fires `createHoldingsBatch`.
 * Driving that wizard end-to-end for every holding-needing test would
 * dwarf the value of UI coverage at the holdings layer (token search,
 * institution/account pickers, then watching a worker job). We therefore
 * call the same tRPC mutation directly and poll `jobs.status` for
 * completion — the UI walk of the wizard is covered by the manual-entry
 * spec (Task 15).
 *
 * The mutation enqueues a `manual-holdings-create` BullMQ job; the worker
 * persists the holding, then fetches prices. We wait until the job is
 * `completed` and read the holding id out of its `returnvalue`.
 */
export async function createHolding(
  page: Page,
  opts: CreateHoldingOptions
): Promise<CreatedHolding> {
  // 1. Look up the token id via `tokens.search`. For "USD" the seeded
  //    fiat row matches the query exactly, so we can pick the first
  //    database-sourced hit whose symbol matches case-insensitively.
  const searchInput = encodeURIComponent(JSON.stringify({ query: opts.symbol, limit: 10 }));
  const searchRes = await page.request.get(
    `${API_BASE_URL}/trpc/tokens.search?input=${searchInput}`
  );
  if (!searchRes.ok()) {
    throw new Error(`trpc.tokens.search failed: ${searchRes.status()} ${await searchRes.text()}`);
  }
  const searchBody = (await searchRes.json()) as { result: { data: TokenSearchHit[] } };
  const dbHit = searchBody.result.data.find(
    (t) => t.source === 'database' && t.symbol.toUpperCase() === opts.symbol.toUpperCase() && t.id
  );
  if (!dbHit?.id) {
    throw new Error(
      `Token "${opts.symbol}" not found in DB; hits: ${searchBody.result.data
        .map((t) => `${t.symbol}/${t.source}`)
        .slice(0, 5)
        .join(', ')}`
    );
  }

  // 2. Enqueue the manual-holdings-create job.
  const requestId = `e2e-${opts.accountId}-${opts.symbol}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const enqueueResult = await trpcMutate<{ jobId: string }>(
    page,
    'batchOperations.createHoldingsBatch',
    {
      requestId,
      accountId: opts.accountId,
      newHoldings: [{ tokenId: dbHit.id, balance: opts.quantity }],
      updateHoldings: [],
    }
  );

  // 3. Wait for the worker to finish. The job persists the holding row
  //    in its first phase (DB transaction) and then spends most of its
  //    time on pricing. We need `completed` so `returnvalue` is populated;
  //    pricing failures for fiat USD are rare in the dev stack but a
  //    failed terminal state is still useful to surface as an error.
  const status = await waitForJob<ManualHoldingsReturn>(page, enqueueResult.jobId, {
    timeoutMs: opts.jobTimeoutMs,
  });
  if (status.state === 'failed') {
    throw new Error(
      `manual-holdings-create job ${enqueueResult.jobId} failed: ${status.failedReason ?? '<no reason>'}`
    );
  }
  if (!status.returnvalue) {
    throw new Error(
      `manual-holdings-create job ${enqueueResult.jobId} completed without a returnvalue`
    );
  }
  const created = status.returnvalue.holdings.find((h) => h.tokenId === dbHit.id);
  if (!created) {
    throw new Error(
      `manual-holdings-create job ${enqueueResult.jobId} returned no holding for tokenId ${dbHit.id}`
    );
  }
  return {
    id: created.id,
    accountId: status.returnvalue.accountId,
    tokenId: created.tokenId,
    symbol: created.symbol,
    balance: created.balance,
  };
}
