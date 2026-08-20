import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import {
  fiatCurrencyLabel,
  rankFiatCurrencies,
} from '../../../src/v3/components/form/FiatCurrencyField';

/**
 * The ranking is the whole reason this is not a plain filtered list: 69 fiat
 * currencies is too many to scan and few enough that nothing may be hidden, so
 * order is the only lever left.
 */

type Currency = Parameters<typeof rankFiatCurrencies>[0][number];

function currency(symbol: string, name: string): Currency {
  return { id: `id-${symbol}`, symbol, name };
}

const LIST: Currency[] = [
  currency('CHF', 'Swiss Franc'),
  currency('USD', 'United States Dollar'),
  currency('EUR', 'Euro'),
  currency('RUB', 'Russian Rouble'),
  currency('CAD', 'Canadian Dollar'),
];

const symbols = (query: string): string[] =>
  rankFiatCurrencies(LIST, query).map((entry) => entry.symbol);

describe('rankFiatCurrencies', () => {
  test('no query is every currency, alphabetically', () => {
    expect(symbols('')).toEqual(['CAD', 'CHF', 'EUR', 'RUB', 'USD']);
  });

  test('the symbol you typed leads the ones that merely contain those letters', () => {
    // The whole point: "Dollar", "Franc" and "Euro" all hold an "r", and every
    // one of them sorts before RUB — a plain substring filter buries the
    // rouble under four currencies that are not it.
    expect(symbols('r')).toEqual(['RUB', 'CAD', 'CHF', 'EUR', 'USD']);
  });

  test('within a band the alphabet decides', () => {
    expect(symbols('c')).toEqual(['CAD', 'CHF']);
  });

  test('the name is searchable, not just the symbol', () => {
    expect(symbols('swiss')).toEqual(['CHF']);
    expect(symbols('dollar')).toEqual(['CAD', 'USD']);
  });

  test('case and surrounding space do not change the answer', () => {
    expect(symbols('  UsD  ')).toEqual(['USD']);
  });

  test('nothing matching is empty rather than everything', () => {
    expect(symbols('zzz')).toEqual([]);
  });

  test('the list handed in is not reordered under its owner', () => {
    const original = [...LIST];
    rankFiatCurrencies(LIST, 'c');
    expect(LIST).toEqual(original);
  });
});

describe('fiatCurrencyLabel', () => {
  test('names the currency as well as its code', () => {
    expect(fiatCurrencyLabel({ symbol: 'USD', name: 'United States Dollar' })).toBe(
      'USD — United States Dollar'
    );
  });
});

/**
 * v2's `FiatCurrencySelect` carried its three strings as literals. They are
 * keyed here, which is the whole reason the rewrite could not be a `git mv`
 * (SC-320 phase 2) — `v3.*` keys are registered by the v3 chunk alone.
 */
describe('the picker says the same things in English it always did', () => {
  const t = i18n.t.bind(i18n);

  test('the search field asks for a currency', () => {
    expect(t('v3.form.fiatCurrency.searchPlaceholder')).toBe('Search currencies…');
  });

  test('an empty search says so without claiming the currency does not exist', () => {
    expect(t('v3.form.fiatCurrency.empty')).toBe('No currency by that name');
  });

  test('the noun reads as a sentence once RecordPicker frames it', () => {
    expect(t('v3.form.recordPicker.change', { label: t('v3.form.fiatCurrency.noun') })).toBe(
      'Change currency'
    );
  });
});

/**
 * The defect this pins was found by clicking, not by reading (SC-320 phase 3).
 *
 * `RecordPicker`'s "Change" is a clear, so the first version of this field
 * reported `''` to its caller before showing the search box. On Settings that
 * merely made the account briefly currency-less; on Vaults the create block
 * defaults its currency in an effect keyed on the value being empty, so the
 * clear was undone on the same render and the currency **could not be changed
 * at all** — the picker closed itself the instant it opened.
 *
 * Both consumers require a currency. Nothing here may report the absence of
 * one; only a chosen one.
 */
test('changing the currency never reports an empty one to its caller', async () => {
  const source = await Bun.file(
    new URL('../../../src/v3/components/form/FiatCurrencyField.tsx', import.meta.url)
  ).text();
  expect(source).toContain('onChange(currencyId)');
  expect(source).not.toContain("onChange('')");
});

/**
 * The compact label, found by looking rather than by reading (SC-320 phase 3
 * slice 2).
 *
 * Beside an amount the field gets half a `FieldRow` — about 80px once
 * `RecordPicker` has spent the rest on its "Change" button — and
 * "USD — United States Dollar" truncated there to `USD …`, hiding the one part
 * of the value that identifies it. v2's own version of this slot passed
 * `variant="compact"` for the same reason; the v3 rewrite had dropped it.
 *
 * Only the settled state drops the name. The search rows still carry it, and
 * by the time the settled state is showing the reader has just chosen the
 * thing.
 */
test('the compact field shows the code alone, and the full field still names it', async () => {
  const source = await Bun.file(
    new URL('../../../src/v3/components/form/FiatCurrencyField.tsx', import.meta.url)
  ).text();
  expect(source).toContain('compact ? selected.symbol : fiatCurrencyLabel(selected)');
});

test('both token sheets ask for the compact label, since both sit beside an amount', async () => {
  for (const name of ['CreateCustomTokenSheet', 'EditCustomTokenPriceSheet']) {
    const source = await Bun.file(
      new URL(`../../../src/v3/components/tokens/${name}.tsx`, import.meta.url)
    ).text();
    expect(source).toContain('compact');
  }
});
