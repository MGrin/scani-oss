import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { V3_CAPTURE_ROUTES, V3_NAV_PATHS, V3_PAYMENT_ROUTES } from '../../src/v3/lib/routes';

/**
 * The accessibility gate (V3-17) walks a route list that lives in the e2e
 * workspace, because that workspace does not depend on the SPA. Nothing else
 * ties the two together — so a v3 ticket that adds a surface would add it to
 * `lib/routes.ts`, ship it, and never be scanned.
 *
 * This is the tie. It reads the e2e list as text rather than importing it:
 * `apps/e2e` is not a dependency of this workspace either, and a text read is
 * the same technique `token-hygiene.test.ts` already uses for the same reason.
 */

const A11Y_ROUTES_FILE = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'e2e',
  'fixtures',
  'v3-routes.ts'
);

async function coveredRoutes(): Promise<Set<string>> {
  const source = await Bun.file(A11Y_ROUTES_FILE).text();
  const body = source.slice(source.indexOf('V3_A11Y_ROUTES'));
  return new Set([...body.matchAll(/'(\/[^']*)'/g)].map((match) => match[1] as string));
}

describe('v3 accessibility-gate coverage', () => {
  test('every nav destination is walked by the axe gate', async () => {
    const covered = await coveredRoutes();
    const missing = V3_NAV_PATHS.filter((path) => !covered.has(path));
    expect(missing).toEqual([]);
  });

  /**
   * The two routed screens that are not nav destinations. Both are forms —
   * the surfaces where a missing label or an undersized control costs the
   * most — so neither may be skipped just because nothing links to it from
   * the tab bar.
   */
  test('the routed forms outside the nav tree are walked too', async () => {
    const covered = await coveredRoutes();
    const missing = [V3_PAYMENT_ROUTES.create, V3_CAPTURE_ROUTES.manualEntry].filter(
      (path) => !covered.has(path)
    );
    expect(missing).toEqual([]);
  });
});
