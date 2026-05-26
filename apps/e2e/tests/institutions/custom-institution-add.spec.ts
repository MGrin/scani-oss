import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { resetAuthRateLimit } from '../../fixtures/redis';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';
const ORIGIN = 'http://localhost:5173';

interface IdName {
  id: string;
  name: string;
}

interface InstitutionRow {
  id: string;
  name: string;
  website?: string | null;
  typeId: string;
}

/**
 * Custom institutions in this app are NOT created by a dedicated
 * `institutions.create` procedure — there isn't one. The user-facing
 * flow is:
 *
 *   1. The user pastes a website URL into the "Add institution" form
 *      (ManualEntryPage or FileImportPage's AccountSelectionStep).
 *   2. The SPA calls `institutions.getOpenGraphMetadata` to autofill
 *      the institution name from the page's OG/Twitter meta tags.
 *   3. The user picks a type and submits — the SPA fires either
 *      `batchOperations.ensureAccount` (file-import path) or
 *      `batchOperations.createHoldingsBatch` (manual-entry path),
 *      both of which accept an `institution: { name, typeId, website? }`
 *      and create the row as a side-effect.
 *
 * We exercise the same two tRPC calls (`getOpenGraphMetadata` then
 * `ensureAccount`) the UI uses, then assert the new institution shows
 * up in `institutions.getByUserId`. The UI walk through the wizard is
 * covered by the manual-entry / file-import specs in Task 15.
 */
test.describe('institutions: custom add via OG metadata', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('user fetches OG metadata then creates a custom institution', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });

    // Step 1: OG metadata fetch. `example.com` is the most stable
    // public target — it's been served by IANA for decades, has a
    // tiny static body well under the 512KB bound, and resolves to
    // a non-private IP so the SSRF guard accepts it. The backend's
    // `extractOG` falls back to EMPTY_OG on parse/fetch failure
    // rather than throwing, so we only assert the call succeeds —
    // the autofill is best-effort by design.
    const ogUrl = 'https://example.com';
    const ogInput = encodeURIComponent(JSON.stringify({ url: ogUrl }));
    const ogRes = await page.request.get(
      `${API_BASE_URL}/trpc/institutions.getOpenGraphMetadata?input=${ogInput}`
    );
    expect(ogRes.ok()).toBe(true);
    const ogBody = (await ogRes.json()) as {
      result: { data: { title: string; siteName: string; description: string } };
    };
    expect(ogBody.result.data).toBeTruthy();

    // The OG title exercises the autofill path the SPA uses. We don't
    // rely on it for the institution name because: (a) OG content is
    // variable and unpredictable, (b) the testId alone may not be unique
    // across browser projects — Playwright reuses the same testId for
    // chromium and webkit runs of the same test. Using a fixed prefix +
    // project name gives deterministic, collision-free names.
    const ogTitle = ogBody.result.data.siteName || ogBody.result.data.title;
    void ogTitle; // exercised above; not used for name to keep test deterministic
    const projectTag = `${testInfo.testId}-${testInfo.project.name}`;
    const institutionName = `e2e-CustomInst-${projectTag}`;

    // Step 2: pick the first available institution type — any type
    // works for the create path; we just need a valid uuid.
    const typesRes = await page.request.get(
      `${API_BASE_URL}/trpc/institutionTypes.getAll?input=%7B%7D`
    );
    expect(typesRes.ok()).toBe(true);
    const typesBody = (await typesRes.json()) as { result: { data: IdName[] } };
    const institutionType = typesBody.result.data[0];
    if (!institutionType) throw new Error('No institution types seeded');

    // Account types are required by `ensureAccount` — same logic.
    const acctTypesRes = await page.request.get(
      `${API_BASE_URL}/trpc/accountTypes.getAll?input=%7B%7D`
    );
    expect(acctTypesRes.ok()).toBe(true);
    const acctTypesBody = (await acctTypesRes.json()) as { result: { data: IdName[] } };
    const accountType = acctTypesBody.result.data[0];
    if (!accountType) throw new Error('No account types seeded');

    // Step 3: create the custom institution by calling the same
    // `ensureAccount` mutation the file-import wizard uses. Providing
    // `institution: { … }` (with no `account.institutionId`) tells
    // the use-case to create both the institution and a starter
    // account, returning the new institutionId.
    //
    // `institutions.website` is intentionally omitted: it carries a
    // global UNIQUE constraint, and testIds recycle across sequential
    // `playwright test` invocations, so any URL built from the testId
    // would collide on the second run against a non-reset DB. Omitting
    // it avoids the constraint entirely without losing coverage of the
    // institution-creation path.
    const accountName = `e2e-acct-${projectTag}`;
    const ensureRes = await page.request.post(
      `${API_BASE_URL}/trpc/batchOperations.ensureAccount`,
      {
        data: {
          institution: {
            name: institutionName,
            typeId: institutionType.id,
          },
          account: {
            name: accountName,
            typeId: accountType.id,
          },
        },
        headers: { 'content-type': 'application/json', origin: ORIGIN },
      }
    );
    if (!ensureRes.ok()) {
      throw new Error(`ensureAccount failed: ${ensureRes.status()} ${await ensureRes.text()}`);
    }
    const ensureBody = (await ensureRes.json()) as {
      result: {
        data: {
          accountId: string;
          institutionId: string | null;
          createdInstitution: boolean;
        };
      };
    };
    expect(ensureBody.result.data.createdInstitution).toBe(true);
    expect(ensureBody.result.data.institutionId).toBeTruthy();

    // Step 4: confirm the new institution shows up in the user's list.
    const listRes = await page.request.get(
      `${API_BASE_URL}/trpc/institutions.getByUserId?input=%7B%7D`
    );
    expect(listRes.ok()).toBe(true);
    const listBody = (await listRes.json()) as { result: { data: InstitutionRow[] } };
    const created = listBody.result.data.find((i) => i.id === ensureBody.result.data.institutionId);
    expect(created).toBeTruthy();
    expect(created?.name).toBe(institutionName);
  });
});
