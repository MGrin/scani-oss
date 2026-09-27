import { signIn } from '../../fixtures/auth';
import { expect, test } from '../../fixtures/test';

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
 * A hand-typed institution: the user types a name and a type, and the SPA fires
 * `batchOperations.ensureAccount` (file-import path) or
 * `batchOperations.createHoldingsBatch` (manual-entry path), both of which
 * accept an `institution: { name, typeId, website? }` and create the row as a
 * side-effect. That row stays private to its creator (SC-1354).
 *
 * The other way in, `institutions.createFromWebsite`, has the server scrape the
 * site and returns a shared, verified row; it is covered by the api's router
 * tests with a stubbed scrape, since a live third-party page is not a stable
 * e2e target.
 */
test.describe('institutions: custom add by name', () => {
  test('user creates a custom institution by name', async ({ page }, testInfo) => {
    await signIn({ page, testInfo });

    // `Date.now()` is load-bearing, not decoration. `institutions.name` is
    // matched globally by `ensureAccount`, and testIds recycle across
    // sequential `playwright test` invocations — so a name built from the
    // testId alone makes this spec pass exactly once against a given database
    // and return `createdInstitution: false` on every run after. That is
    // invisible in CI, which gets a fresh database each run, and it is the
    // first thing you hit when you try to measure a pass rate by running the
    // suite repeatedly (SC-489). The `website` field dodged the same problem
    // by being omitted; the name cannot be.
    const projectTag = `${testInfo.testId}-${testInfo.project.name}-${Date.now()}`;
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
