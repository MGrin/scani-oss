import type { Page } from '@playwright/test';

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
}

interface TokenSearchHit {
  id?: string;
  symbol: string;
  source: 'database' | 'external';
}

interface JobStatusResponse {
  state: 'queued' | 'active' | 'progress' | 'completed' | 'failed' | 'not_found';
  returnvalue?: {
    accountId: string;
    holdings: Array<{ id: string; tokenId: string; symbol: string; balance: string }>;
  } | null;
  failedReason?: string | null;
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

  // 3. Poll `jobs.status` until the worker finishes. The job persists
  //    the holding row in its first phase (DB transaction) and then
  //    spends most of its time on pricing. We need `completed` so the
  //    `returnvalue` is populated; pricing failures for fiat USD are
  //    rare in the dev stack but a failed terminal state is still useful
  //    to surface as an error.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const statusInput = encodeURIComponent(JSON.stringify({ jobId: enqueueResult.jobId }));
    const statusRes = await page.request.get(
      `${API_BASE_URL}/trpc/jobs.status?input=${statusInput}`
    );
    if (!statusRes.ok()) {
      throw new Error(`trpc.jobs.status failed: ${statusRes.status()} ${await statusRes.text()}`);
    }
    const statusBody = (await statusRes.json()) as { result: { data: JobStatusResponse } };
    const data = statusBody.result.data;
    if (data.state === 'completed' && data.returnvalue) {
      const created = data.returnvalue.holdings.find((h) => h.tokenId === dbHit.id);
      if (!created) {
        throw new Error(
          `manual-holdings-create job ${enqueueResult.jobId} returned no holding for tokenId ${dbHit.id}`
        );
      }
      return {
        id: created.id,
        accountId: data.returnvalue.accountId,
        tokenId: created.tokenId,
        symbol: created.symbol,
        balance: created.balance,
      };
    }
    if (data.state === 'failed') {
      throw new Error(
        `manual-holdings-create job ${enqueueResult.jobId} failed: ${data.failedReason ?? '<no reason>'}`
      );
    }
    if (data.state === 'not_found') {
      throw new Error(`manual-holdings-create job ${enqueueResult.jobId} not found`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`manual-holdings-create job ${enqueueResult.jobId} did not complete within 30s`);
}
