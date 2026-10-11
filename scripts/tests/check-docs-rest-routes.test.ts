import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runCheckDocs } from '../lib/run-check-docs';
import { replayStrandedMutations, withMutatedSources } from '../lib/test-source-mutations';

// Each test spawns `bun scripts/check-docs.ts`; see check-docs-package-inventory.test.ts (SC-694).
setDefaultTimeout(30_000);

/**
 * SC-1648. The REST reference page lists every `/api/v1` route by hand, and
 * `docs:check` holds that list to the route table in both directions. These
 * tests exist so the check has been SEEN to fail.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const PAGE = path.join(REPO_ROOT, 'apps/frontend/docs/src/content/docs/reference/rest-api.md');

const restored = replayStrandedMutations(REPO_ROOT);
if (restored.length > 0) console.log(`restored ${restored.length} file(s): ${restored.join(', ')}`);

const ORIGINAL = readFileSync(PAGE, 'utf8');

function withPage(page: string): { exitCode: number; output: string } {
  // Control: the substitution matched, so the check runs against a changed page.
  expect(page).not.toBe(ORIGINAL);
  const result = withMutatedSources(REPO_ROOT, { [PAGE]: page }, () => runCheckDocs(REPO_ROOT));
  expect(readFileSync(PAGE, 'utf8')).toBe(ORIGINAL);
  return result;
}

const A_REAL_ROW = /^\| `GET \/api\/v1\/lots` \|.*\n/m;

describe('docs:check rest-routes (SC-1648)', () => {
  test('the committed page passes', () => {
    const { exitCode, output } = runCheckDocs(REPO_ROOT);
    expect(output).not.toContain('[rest-routes]');
    expect(exitCode).toBe(0);
  });

  test('a route missing from the page fails, naming it', () => {
    expect(ORIGINAL).toMatch(A_REAL_ROW);
    const { exitCode, output } = withPage(ORIGINAL.replace(A_REAL_ROW, ''));
    expect(exitCode).toBe(1);
    expect(output).toContain('[rest-routes]');
    expect(output).toContain('GET /api/v1/lots');
  });

  test('a row for a route that does not exist fails, naming it', () => {
    const ghost = '| `DELETE /api/v1/holdings/{holdingId}` | Deletes a holding. |\n';
    const { exitCode, output } = withPage(ORIGINAL.replace(A_REAL_ROW, (row) => row + ghost));
    expect(exitCode).toBe(1);
    expect(output).toContain('[rest-routes]');
    expect(output).toContain('DELETE /api/v1/holdings/{holdingId}');
  });
});
