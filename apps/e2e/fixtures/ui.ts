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
