import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import {
  createCustomTokenBlockers,
  currencyIdForSymbol,
  currencySymbolForId,
  isSymbolTakenError,
  parsePositivePrice,
  priceBlockers,
} from '../../../src/v3/lib/custom-tokens';

const t = i18n.t.bind(i18n);

const CURRENCIES = [
  { id: 'id-usd', symbol: 'USD' },
  { id: 'id-eur', symbol: 'EUR' },
  { id: 'id-gbp', symbol: 'GBP' },
];

describe('parsePositivePrice', () => {
  test('an empty field is no price, not a price of zero', () => {
    // The whole reason this is not `Number(value)`: the router rejects 0 with a
    // 400 that says nothing the form could not have said first.
    expect(parsePositivePrice('')).toBeNull();
    expect(parsePositivePrice('   ')).toBeNull();
  });

  test('zero and negatives are refused', () => {
    expect(parsePositivePrice('0')).toBeNull();
    expect(parsePositivePrice('-5')).toBeNull();
  });

  test('a canonical AmountInput string is the number', () => {
    expect(parsePositivePrice('1234.56')).toBe(1234.56);
    expect(parsePositivePrice('0.00000042')).toBe(4.2e-7);
  });

  test('anything unparseable is no price', () => {
    expect(parsePositivePrice('abc')).toBeNull();
    expect(parsePositivePrice('Infinity')).toBeNull();
  });
});

/**
 * The picker stores token ids; `createCustom` and `updateCustomPrice` both take
 * a symbol. A mix-up across that boundary records a price against the wrong
 * currency and nothing anywhere reports it, which is why both directions are
 * one function each rather than an inline `.find` at four call sites.
 */
describe('the id/symbol boundary', () => {
  test('a symbol resolves to the id the picker holds', () => {
    expect(currencyIdForSymbol(CURRENCIES, 'EUR')).toBe('id-eur');
  });

  test('case and surrounding space do not change the answer', () => {
    // `latestPriceBaseCurrency` comes off a row a person typed into months ago.
    expect(currencyIdForSymbol(CURRENCIES, '  eur ')).toBe('id-eur');
  });

  test('an absent or unknown symbol is the empty id, which is a blocker', () => {
    expect(currencyIdForSymbol(CURRENCIES, null)).toBe('');
    expect(currencyIdForSymbol(CURRENCIES, undefined)).toBe('');
    expect(currencyIdForSymbol(CURRENCIES, 'XYZ')).toBe('');
    expect(currencyIdForSymbol([], 'USD')).toBe('');
  });

  test('an id resolves back to the symbol the API takes', () => {
    expect(currencySymbolForId(CURRENCIES, 'id-gbp')).toBe('GBP');
  });

  test('an unknown id is null rather than a guess', () => {
    // The submit handler bails on null. Falling back to a default here would
    // send a price denominated in a currency nobody chose.
    expect(currencySymbolForId(CURRENCIES, 'id-nope')).toBeNull();
    expect(currencySymbolForId(CURRENCIES, '')).toBeNull();
  });
});

describe('what the create form is still missing', () => {
  const complete = {
    symbol: 'ACME',
    name: 'Acme Corp shares',
    price: '12.5',
    currencyId: 'id-usd',
  };

  test('a complete draft blocks nothing', () => {
    expect(createCustomTokenBlockers(t, complete)).toEqual([]);
  });

  test('an empty form names every missing thing, not just the first', () => {
    // v2 answers this question with one boolean, which can disable a button but
    // cannot say why — the defect `FormActions` exists to fix.
    expect(
      createCustomTokenBlockers(t, { symbol: '', name: '', price: '', currencyId: '' })
    ).toEqual(['enter a symbol', 'enter a name', 'enter a price above zero', 'choose a currency']);
  });

  test('the order is the order of the fields down the form', () => {
    const blockers = createCustomTokenBlockers(t, { ...complete, symbol: '', price: '' });
    expect(blockers).toEqual(['enter a symbol', 'enter a price above zero']);
  });

  test('whitespace is not a symbol or a name', () => {
    expect(createCustomTokenBlockers(t, { ...complete, symbol: '   ' })).toEqual([
      'enter a symbol',
    ]);
    expect(createCustomTokenBlockers(t, { ...complete, name: '\t' })).toEqual(['enter a name']);
  });
});

describe('what the price form is still missing', () => {
  test('a price and a currency is all it asks for — the reason is optional', () => {
    expect(priceBlockers(t, { price: '9.99', currencyId: 'id-eur' })).toEqual([]);
  });

  test('zero is not a price', () => {
    expect(priceBlockers(t, { price: '0', currencyId: 'id-eur' })).toEqual([
      'enter a price above zero',
    ]);
  });

  test('no currency chosen blocks even with a price typed', () => {
    expect(priceBlockers(t, { price: '9.99', currencyId: '' })).toEqual(['choose a currency']);
  });
});

/**
 * A taken symbol is the create form's one failure a reader can act on, and
 * `describeQueryError` has no 409 branch — it would render "Couldn't create the
 * token", which describes the request rather than the collision.
 */
describe('isSymbolTakenError', () => {
  test('a tRPC CONFLICT is the symbol already existing', () => {
    expect(isSymbolTakenError({ data: { httpStatus: 409 } })).toBe(true);
  });

  test('every other failure is not', () => {
    expect(isSymbolTakenError({ data: { httpStatus: 400 } })).toBe(false);
    expect(isSymbolTakenError({ data: { httpStatus: 500 } })).toBe(false);
    expect(isSymbolTakenError({ data: null })).toBe(false);
    expect(isSymbolTakenError(new Error('already exists'))).toBe(false);
    expect(isSymbolTakenError(null)).toBe(false);
    expect(isSymbolTakenError(undefined)).toBe(false);
  });
});

/**
 * The English these forms say, resolved through the real instance against the
 * shipped `en.json` — v2 carried every one of these as a literal, which is the
 * whole reason the rewrite could not be a `git mv` (SC-320 phase 2).
 */
describe('the forms say the same things in English', () => {
  test('the blockers line completes into a sentence', () => {
    expect(t('v3.form.blockers', { blockers: 'enter a symbol, enter a name' })).toBe(
      'To continue: enter a symbol, enter a name.'
    );
  });

  test('a taken symbol names the symbol and says what to do about it', () => {
    expect(t('v3.tokens.create.symbolTaken', { symbol: 'ACME' })).toBe(
      'ACME already exists. Pick another symbol, or edit that token’s price instead.'
    );
  });

  test('the price sheet is titled by its token', () => {
    expect(t('v3.tokens.price.title', { symbol: 'ACME' })).toBe('ACME price');
  });

  test('both forms say custom tokens are shared, which is the surprising part', () => {
    expect(t('v3.tokens.create.description')).toContain('shared with everyone');
    expect(t('v3.tokens.price.description')).toContain('Anyone here can change it');
  });
});
