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
 * ## "Expected" is the same rule, and it was missing (SC-933)
 *
 * SC-817 rejected "Expected" for the outflow figure and then left the INFLOW
 * twin — `vendors.expectedPerMonth`, over the same `historyEstimates` map —
 * spelled exactly that. This file is why it survived: it swept for "committed"
 * and said nothing about "expected", so the one guard that could have seen it
 * was not looking. Both words are now allowlisted, for the same reason.
 *
 * **The two words are not interchangeable and the allowlists are not
 * symmetrical.** "Committed" belongs to one figure. "Expected" is entitled on
 * three separate grounds, and the groups below say which, because a reader
 * adding a fourth string needs to know what claim they are making:
 *
 * 1. **A figure that resolves `expectedAmount ?? actualAmount` and substitutes
 *    NO estimate** — the income tile. That is the same resolution as "Bills
 *    committed", so the word is accurate rather than tolerated. Renaming it to
 *    "Projected" would have been SC-817's inversion pointed the other way:
 *    "projected" is this surface's word for a figure that DOES substitute.
 * 2. **A DATE.** "Expected 12 Sep" is a claim about when, not about an amount,
 *    so `expectedAmount` cannot collide with it.
 * 3. **The export column for the wire field itself.**
 *
 * ## The control
 *
 * This test can come back red in both directions: spell any inclusive label
 * "Committed" or "Expected" again — `vendors.projectedIncomePerMonth`, say —
 * and the sweeps below report it as a key outside `STRICT` / `EXPECTED`. The
 * negative case is checked too: the `PROJECTED` keys must exist, must carry
 * the word, and must not say "expected", so a rename that deleted them rather
 * than moving them fails here instead of passing quietly.
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

/**
 * The only surfaces entitled to "expected", grouped by which ground earns it
 * (SC-933). A string outside this set is either an inclusive figure wearing
 * the rejected word — the defect — or a fourth ground nobody has argued yet.
 */
const EXPECTED = new Set([
  // 1. Estimate-EXCLUSIVE money figures. `occurrenceTotals` resolves
  //    `expectedAmount ?? actualAmount ?? '0'`, so an occurrence priced from
  //    its own settled history contributes zero — the "Bills committed"
  //    resolution, stated for income.
  'v3.home.upcoming.incomeExpected_one',
  'v3.home.upcoming.incomeExpected_other',
  'v3.money.expectedIncome.title_one',
  'v3.money.expectedIncome.title_other',
  //    …and the sentence that makes that figure legible.
  'v3.money.expectedIncome.caption_one',
  'v3.money.expectedIncome.caption_other',
  // 2. Dates. Nothing here is an amount.
  'v3.money.expectedIncome.row',
  'v3.money.expectedIncome.expected',
  'v3.money.expectedIncome.expectedLate',
  'v3.money.peek.expectedOn',
  'v3.money.peek.expectedOnLate',
  // 3. The export column for the wire field itself.
  'v3.export.column.expected',
]);

/**
 * Every figure that substitutes a history estimate, and so may say neither
 * "committed" nor "expected".
 *
 * `vendors.projectedIncomePerMonth` is the INFLOW half, and it is the whole of
 * SC-933: `monthlyCommitmentByVendor(payments, INFLOW, historyEstimates)`
 * threads the same map the outflow figure does, and nothing in that map
 * filters by direction (SC-818).
 */
const PROJECTED = [
  'v3.money.recurringSummary.projectedEachMonth',
  'vendors.projectedPerMonth',
  'vendors.projectedIncomePerMonth',
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

  test('only the entitled surfaces say "expected" (SC-933)', () => {
    const said = ENGLISH.filter(([, value]) => /expect/i.test(value)).map(([key]) => key);
    expect(said.length).toBeGreaterThan(0);
    expect(said.filter((key) => !EXPECTED.has(key))).toEqual([]);
  });

  test('every estimate-inclusive figure says "projected"', () => {
    const byKey = new Map(ENGLISH);
    for (const key of PROJECTED) {
      const value = byKey.get(key);
      expect(value).toBeString();
      expect(value).toMatch(/projected/i);
    }
  });

  test('and none of them says "expected" or "committed" as well (SC-933)', () => {
    // The sweeps above are allowlists, so a key added to BOTH lists would pass
    // them and still be the defect. This asks the question directly.
    const byKey = new Map(ENGLISH);
    for (const key of PROJECTED) {
      expect(byKey.get(key)).not.toMatch(/expect|committ/i);
    }
  });

  test('the entitled "expected" figures are still there to be entitled', () => {
    // An allowlist alone cannot fail when a key is DELETED — the sweep just
    // finds nothing outside it and passes. These two are the income figure
    // itself, so their absence is a rename that has to be read here.
    const byKey = new Map(ENGLISH);
    for (const key of [
      'v3.home.upcoming.incomeExpected_other',
      'v3.money.expectedIncome.title_other',
    ]) {
      expect(byKey.get(key)).toMatch(/expected/i);
    }
  });
});
