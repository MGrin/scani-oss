import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { splitChangeIntoMoney } from '../../src/lib/returns-money';

/**
 * SC-1297 — the attribution bar, in money rather than rates.
 *
 * The rates already exist and compose exactly (`asset + currency + cross =
 * base`, `fx-attribution.ts`). What is new is turning the window's actual
 * money change into the same three parts, and REFUSING to when the rates
 * cannot carry the weight.
 */

const d = (n: string | number) => new Decimal(n);

describe('splitChangeIntoMoney', () => {
  test('contributions are the net flow, and the rest is the gain', () => {
    const split = splitChangeIntoMoney({
      openingValue: d(1000),
      closingValue: d(1600),
      netFlow: d(400),
      attribution: null,
    });

    expect(split.contributions.toString()).toBe('400');
    expect(split.gain.toString()).toBe('200');
    // With no attribution the gain stays whole, labelled as one thing.
    expect(split.market).toBeNull();
    expect(split.currency).toBeNull();
  });

  test('a withdrawal is a negative contribution and never hides a gain', () => {
    const split = splitChangeIntoMoney({
      openingValue: d(1000),
      closingValue: d(700),
      netFlow: d(-500),
      attribution: null,
    });

    expect(split.contributions.toString()).toBe('-500');
    // Value fell 300 while 500 was taken out: the portfolio itself made 200.
    expect(split.gain.toString()).toBe('200');
  });

  test('the gain splits in the same proportions the rates do', () => {
    const split = splitChangeIntoMoney({
      openingValue: d(1000),
      closingValue: d(1200),
      netFlow: d(0),
      attribution: {
        assetReturn: '0.15',
        currencyReturn: '0.05',
        crossTerm: '0.0075',
        baseReturn: '0.2075',
      },
    });

    expect(split.gain.toString()).toBe('200');
    // 0.15 / 0.2075 of 200, and 0.05 / 0.2075 of 200.
    expect(split.market?.toFixed(2)).toBe('144.58');
    expect(split.currency?.toFixed(2)).toBe('48.19');
    expect(split.crossEffect?.toFixed(2)).toBe('7.23');
    // The parts add back to the gain exactly, so the bar cannot lie.
    const sum = split.market?.plus(split.currency ?? 0).plus(split.crossEffect ?? 0);
    expect(sum?.toString()).toBe(split.gain.toString());
  });

  test('a currency-driven loss keeps its sign', () => {
    const split = splitChangeIntoMoney({
      openingValue: d(1000),
      closingValue: d(950),
      netFlow: d(0),
      attribution: {
        assetReturn: '0.05',
        currencyReturn: '-0.0952380952',
        crossTerm: '-0.0047619048',
        baseReturn: '-0.05',
      },
    });

    expect(split.gain.toString()).toBe('-50');
    expect(split.market?.gt(0)).toBe(true);
    expect(split.currency?.lt(0)).toBe(true);
  });

  test('a base return of nearly zero leaves the gain unsplit rather than exploding', () => {
    // Assets up 20%, the currency down almost exactly as much: the shares are
    // ±huge multiples of a gain that is nearly nothing, and any split printed
    // from them is noise wearing two decimal places.
    const split = splitChangeIntoMoney({
      openingValue: d(1000),
      closingValue: d(1000),
      netFlow: d(0),
      attribution: {
        assetReturn: '0.2',
        currencyReturn: '-0.1666666667',
        crossTerm: '-0.0333333333',
        baseReturn: '0.0000000001',
      },
    });

    expect(split.gain.toString()).toBe('0');
    expect(split.market).toBeNull();
    expect(split.currency).toBeNull();
  });
});
