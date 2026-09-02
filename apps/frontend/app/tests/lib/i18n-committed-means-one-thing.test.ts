import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * "Committed" means ONE thing across v3, and this is what says so (SC-817).
 *
 * Two figures a segmented control apart used the same English word for
 * opposite treatments of the same estimate. `UpcomingFeed`'s "Bills committed"
 * resolves `expectedAmount ?? actualAmount`, so a bill priced from its own
 * settled history contributes zero; `RecurringSummary`'s figure resolves
 * `expectedAmount ?? historyEstimate`, so the same bill is inside it. Both were
 * internally consistent, both were captioned, and nothing told a reader
 * crossing between them that the word had changed meaning.
 *
 * SC-807 already ruled which sense wins, in shipped copy: "an estimate is not
 * a commitment". So **committed = an amount you declared**, and every figure
 * that substitutes history says **projected** instead.
 *
 * ## Why "Projected" and not "Expected" (mgrin, 2026-09-02)
 *
 * `expectedAmount` is the field name for the DECLARED, non-estimated amount.
 * Labelling the estimate-inclusive figure "Expected" would make one word mean
 * the opposite thing one layer down — the exact defect this ticket removes.
 * "Projected" is also already this surface's word: `forecast.projectedMark`,
 * "Projected balance over the next N months".
 *
 * ## Nothing here is about arithmetic
 *
 * No figure changed what it sums, deliberately. `occurrenceTotals` and
 * `sumMonthlyEquivalentByCurrency` answer different questions and both answers
 * are right; only the vocabulary was wrong.
 *
 * ## The control
 *
 * This test can come back red: spell any inclusive label "Committed" again —
 * `v3.money.recurringSummary.projectedEachMonth`, say — and the sweep below
 * reports it as a key outside `STRICT`. The negative case is checked too: the
 * `PROJECTED` keys must exist and must carry the word, so a rename that
 * deleted them rather than moving them fails here instead of passing quietly.
 */

const SHELL = resolve(import.meta.dir, '../../src/i18n/locales/en.json');
const V3 = resolve(import.meta.dir, '../../src/v3/i18n/locales/en.json');

function leaves(node: unknown, prefix = ''): [string, string][] {
  if (typeof node === 'string') return [[prefix, node]];
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

/** Every English string a reader can be shown — both halves of the locale split. */
const ENGLISH: [string, string][] = [SHELL, V3].flatMap((path) =>
  leaves(JSON.parse(readFileSync(path, 'utf8')))
);

/**
 * The only surface entitled to the word. `UpcomingFeed`'s headline and the
 * caption naming what it leaves out — one figure and the sentence that makes
 * it legible.
 */
const STRICT = new Set([
  'v3.money.upcoming.billsCommitted_one',
  'v3.money.upcoming.billsCommitted_other',
  'v3.money.upcoming.estimatedExcluded_one',
  'v3.money.upcoming.estimatedExcluded_other',
]);

/** Every figure that substitutes a history estimate, and so may not say "committed". */
const PROJECTED = [
  'v3.money.recurringSummary.projectedEachMonth',
  'vendors.projectedPerMonth',
  'v3.money.forecast.projectedTitle',
  'v3.money.forecast.ofWhichProjected',
];

describe('"committed" means one thing (SC-817)', () => {
  test('there are English strings to sweep at all', () => {
    expect(ENGLISH.length).toBeGreaterThan(500);
  });

  test('only the strict surface says "committed"', () => {
    const said = ENGLISH.filter(([, value]) => /committ/i.test(value)).map(([key]) => key);
    expect(said.length).toBeGreaterThan(0);
    expect(said.filter((key) => !STRICT.has(key))).toEqual([]);
  });

  test('every estimate-inclusive figure says "projected"', () => {
    const byKey = new Map(ENGLISH);
    for (const key of PROJECTED) {
      const value = byKey.get(key);
      expect(value).toBeString();
      expect(value).toMatch(/projected/i);
    }
  });
});
