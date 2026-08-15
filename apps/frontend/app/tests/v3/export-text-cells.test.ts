import { describe, expect, test } from 'bun:test';
import { v3Sources } from './helpers/v3-sources';

/**
 * The one hole an inverted rule has by construction.
 *
 * SC-93's hide-amounts option withholds `money`, `percent` and `number` cells
 * and keeps `text` — safe by default, because anything numeric that nobody
 * classified is withheld. But **`text` survives**, so a figure rendered *as a
 * string* walks straight through the control. Nothing today does that; every
 * `exportText` call site carries a symbol, a name, a status, a purpose or a
 * coverage grade.
 *
 * The risk is future work, and specifically layout work: SC-94 added a PDF
 * renderer, and formatting an amount into a string "just for the layout" is the
 * natural thing to reach for next. So the invariant is written down here rather
 * than left as a property of the current code:
 *
 * > **`exportText` must never carry a figure.**
 *
 * A source scan rather than a runtime assertion, for the reason
 * `safe-area.test.ts` is one: the thing being protected is a *call site*, and a
 * call site that does not exist yet cannot be caught by a test of behaviour.
 * The check is deliberately crude — it fails on the argument's spelling — which
 * makes it noisy in exactly one direction: a false positive costs a rename or
 * an explicit `exportCount`, and a false negative costs a leak.
 */

/** Identifiers that name a figure. A column built from any of these belongs in
 *  `exportMoney` / `exportNumber` / `exportPercent` / `exportCount`, all of
 *  which the withholding rule understands. */
const FIGURE_WORDS =
  /\b(amount|amounts|balance|price|value|total|totals|sum|cost|spend|gain|loss|pnl|profit|converted|equivalent|worth|quantity|qty)\b/i;

/** Call sites whose argument merely *mentions* a figure word while carrying no
 *  figure. Each one is a deliberate exemption, and each says why. */
const ALLOWED = new Set<string>([
  // `coverageQuality` is a grade — 'full' | 'partial' | 'estimated' | 'unknown'.
  'exportText(point.coverageQuality)',
  'exportText(row.coverageQuality)',
]);

function callsToExportText(code: string): string[] {
  const calls: string[] = [];
  const marker = 'exportText(';
  let from = 0;
  for (;;) {
    const start = code.indexOf(marker, from);
    if (start === -1) break;
    let depth = 0;
    let end = start + marker.length - 1;
    for (; end < code.length; end += 1) {
      const char = code[end];
      if (char === '(') depth += 1;
      else if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    calls.push(code.slice(start, end + 1).replace(/\s+/g, ' '));
    from = end + 1;
  }
  return calls;
}

describe('exportText never carries a figure', () => {
  test('no v3 source formats a value into a text export cell', async () => {
    const offenders: string[] = [];

    for (const file of v3Sources()) {
      const code = await Bun.file(file.path).text();
      if (!code.includes('exportText(')) continue;

      for (const call of callsToExportText(code)) {
        if (ALLOWED.has(call)) continue;
        if (FIGURE_WORDS.test(call)) offenders.push(`${file.name}: ${call}`);
      }
    }

    // If this trips: the column carries a figure, so give it the cell kind that
    // says so. `exportMoney` / `exportNumber` / `exportPercent` are withheld by
    // "Hide amounts"; `exportCount` is a tally and is kept. Adding it to
    // ALLOWED is right only when the value genuinely is not a figure — and then
    // the entry needs a comment saying what it is.
    expect(offenders).toEqual([]);
  });

  test('the scan actually reaches the export call sites', () => {
    // A guard on the guard. If `v3Sources()` or the marker ever stops matching,
    // the test above passes vacuously and the invariant is unprotected without
    // anything going red.
    const seen = v3Sources().length;
    expect(seen).toBeGreaterThan(20);
  });
});

describe('the figure-word list itself', () => {
  test('catches the shape this is guarding against', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is the source shape under test, not an interpolation that failed to run
    expect(FIGURE_WORDS.test('exportText(`${amount} ${currency}`)')).toBe(true);
    expect(FIGURE_WORDS.test('exportText(describeConversion(total, symbolFor))')).toBe(true);
    expect(FIGURE_WORDS.test('exportText(formatCurrency(holding.value, base))')).toBe(true);
  });

  test('leaves ordinary identity columns alone', () => {
    expect(FIGURE_WORDS.test('exportText(item.token.symbol)')).toBe(false);
    expect(FIGURE_WORDS.test('exportText(vendor.displayName)')).toBe(false);
    expect(FIGURE_WORDS.test('exportText(job.state)')).toBe(false);
  });
});
