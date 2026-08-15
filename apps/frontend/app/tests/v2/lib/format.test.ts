import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { formatMoney, formatMoneyPlain, formatQuantity } from '../../../src/v2/lib/format';

/**
 * The two rows QA round 5 filed v2 for, and the static check that keeps them
 * fixed.
 *
 * **The static check is the load-bearing half**, and the reason is worth
 * stating: Bun's ICU resolves the default locale to `en-US` no matter what
 * `LANG` / `LC_ALL` say, so `(4200000).toLocaleString()` returns `4,200,000`
 * under `bun test` and `4.200.000` in a de-DE browser. The defect SC-184
 * reports is *invisible to this runner by construction* — no assertion about
 * output can catch a call site that reintroduces it, only an assertion about
 * the source can.
 */

const V2_SRC = resolve(import.meta.dir, '../../../src/v2');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('formatQuantity', () => {
  test('shows the decimals the figure carries, not three and not eight', () => {
    // The two rows from the report, and the trailing-zero case SC-177 named.
    expect(formatQuantity(4_200_000)).toBe('4,200,000');
    expect(formatQuantity(0.5)).toBe('0.5');
    expect(formatQuantity('500000000.00000000')).toBe('500,000,000');
    expect(formatQuantity('0.28410000')).toBe('0.2841');
  });

  test('a dust balance is small rather than empty', () => {
    // `toLocaleString()` caps at three fraction digits, so both of these
    // rendered `0` — a claim the position is gone.
    expect(formatQuantity('0.00007715')).toBe('0.00007715');
    // Below the eight-decimal balance cap, where the cap itself would render
    // `0`, so it lifts rather than lies (SC-177).
    expect(formatQuantity('0.000000001')).toBe('0.000000001');
  });

  test('a quantity that survives the balance cap stops at it', () => {
    expect(formatQuantity('1.123456789123')).toBe('1.12345679');
    expect(formatQuantity('0.000000123')).toBe('0.00000012');
  });
});

describe('formatMoney', () => {
  test('the row multiplies out', () => {
    // SC-185: 4,200,000 × €0.00 is not €324.03.
    expect(formatMoney('0.00007715', 'EUR')).toBe('€0.00007715');
    expect(formatMoney(4_200_000 * 0.00007715, 'EUR')).toBe('€324.03');
    expect(formatMoney('0.000000123', 'EUR')).toBe('€0.000000123');
    expect(formatMoney(500_000_000 * 0.000000123, 'EUR')).toBe('€61.50');
  });

  test('ordinary money keeps its two decimals', () => {
    expect(formatMoney('30617.28', 'EUR')).toBe('€30,617.28');
    expect(formatMoney('98.33333333333333333333', 'EUR')).toBe('€98.33');
    expect(formatMoney(0, 'EUR')).toBe('€0.00');
    expect(formatMoney('0.009', 'EUR')).toBe('€0.01');
  });

  test('no price is a placeholder, not a zero', () => {
    expect(formatMoney(null, 'EUR')).toBe('—');
    expect(formatMoney(undefined, 'EUR')).toBe('—');
  });
});

describe('formatMoneyPlain', () => {
  test('carries the same rule without an Intl currency', () => {
    expect(formatMoneyPlain('0.00007715')).toBe('0.00007715');
    expect(formatMoneyPlain('1234.5')).toBe('1,234.50');
  });
});

describe('v2 never formats a number or a date against the device locale', () => {
  // SC-184 / SC-180. `toLocaleString` on a number follows the runtime's locale,
  // so an Amount of `4.200.000` landed beside a Value of `€324.03` — the same
  // `.` grouping digits on one row and separating them on the next. On a date
  // it produced the numeric short form beside the shared helpers' medium one.
  const BARE_LOCALE_CALL = /\.toLocale(String|DateString|TimeString)\s*\(/;

  test.each(
    sourceFiles(V2_SRC).map((file) => [relative(V2_SRC, file), file] as const)
  )('%s', async (_label, file) => {
    const source = stripComments(await Bun.file(file).text());
    expect(BARE_LOCALE_CALL.test(source)).toBe(false);
  });
});
