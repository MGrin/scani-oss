import { describe, expect, test } from 'bun:test';
import { stripTrailingSlash } from '@scani/ui/v3/lib/path';

// SC-483. This replaced four copies of `.replace(/\/+$/, '')` over a browser
// pathname. That pattern backtracks quadratically on a run of slashes: the
// engine retries `\/+` from every one of them and each attempt walks to the
// end before `$` rejects it. CodeQL flagged the copy in `peek.ts`
// (js/polynomial-redos); the other three were the same defect, unreported.
describe('stripTrailingSlash', () => {
  // The accepted/rejected set the rewrite must not move — every one of these
  // was checked against `.replace(/\/+$/, '')` and matches it exactly.
  const cases: [string, string][] = [
    ['', ''],
    ['/', '/'],
    ['a', 'a'],
    ['//', ''],
    ['///', ''],
    ['/holdings', '/holdings'],
    ['/holdings/', '/holdings'],
    ['/holdings//', '/holdings'],
    ['/holdings///', '/holdings'],
    ['/a//b/', '/a//b'],
    ['a/', 'a'],
    ['/v3/holdings/abc', '/v3/holdings/abc'],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(stripTrailingSlash(input)).toBe(expected);
    });
  }

  // The trailing `x` is load-bearing: it is what makes `$` reject, so the old
  // regex retried from every one of the 80k slashes. End the string in a slash
  // instead and the greedy first attempt succeeds, hiding the blowup.
  test('80k slashes strip in well under a second', () => {
    const path = `/holdings/${'/'.repeat(80_000)}x`;
    const started = performance.now();
    expect(stripTrailingSlash(path)).toBe(path);
    const elapsed = performance.now() - started;
    // Quadratic, this input took ~2.2 s; linear it is under a millisecond.
    expect(elapsed).toBeLessThan(250);
  });
});
