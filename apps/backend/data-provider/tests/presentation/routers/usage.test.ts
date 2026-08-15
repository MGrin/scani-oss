import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * That the three usage queries all mean the same thing by "error".
 *
 * The summary tile's fold is pinned on fixtures in `@scani/shared`'s
 * `tests/usage/outcomes.test.ts`;
 * the daily series is computed in Postgres, and this repo has no database
 * fixture for the data-provider, so what is checked here is that the SQL is
 * built from the same allowlist rather than from a second, hand-written
 * predicate. That is exactly how the two drifted: the tile folded `!== 'ok'`
 * in TypeScript and the chart filtered `<> 'ok'` in SQL — two spellings of one
 * denylist, wrong together and consistent with each other, which is why the
 * chart looked like a confirmation of the tile (SC-76).
 */
const SOURCE = await Bun.file(
  join(import.meta.dir, '../../../src/presentation/routers/usage.ts')
).text();

describe('usage router — one definition of an error', () => {
  test('the daily series filters on the shared failure allowlist', () => {
    expect(SOURCE).toContain('USAGE_FAILURE_OUTCOMES');
    expect(SOURCE).toContain('inArray(cloudUsageEvents.outcome');
  });

  test('the summary tile folds with the shared summarizer', () => {
    expect(SOURCE).toContain('summarizeOutcomes(');
  });

  test('no query re-derives "error" as "not the success sentinel"', () => {
    // Both spellings of the denylist, in either direction.
    expect(SOURCE).not.toMatch(/<>\s*'ok'/);
    expect(SOURCE).not.toMatch(/!==\s*'ok'/);
    expect(SOURCE).not.toMatch(/!=\s*'success'/);
  });
});
