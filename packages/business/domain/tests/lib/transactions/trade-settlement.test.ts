import { describe, expect, test } from 'bun:test';
import {
  settlementLegsFor,
  tradesWithReportedCashSide,
} from '../../../src/lib/transactions/trade-settlement';

const VOO = 'token-voo';
const USD = 'token-usd';
const BNB = 'token-bnb';
const USDT = 'token-usdt';
const EUR = 'token-eur';
const CAD = 'token-cad';
const AT = new Date('2026-07-14T14:30:00Z');

type Trade = Parameters<typeof settlementLegsFor>[0];

function ibkrBuy(over: Partial<Trade> = {}): Trade {
  return {
    kind: 'buy',
    tokenId: VOO,
    counterQuantity: '-1000',
    counterTokenId: USD,
    feeQuantity: '-1',
    feeTokenId: USD,
    externalId: 'ibkr-trade-42',
    source: 'ibkr-api',
    ...over,
  };
}

describe('settlementLegsFor', () => {
  test('an IBKR buy settles out of the cash holding, with its commission as a fee row', () => {
    expect(settlementLegsFor(ibkrBuy())).toEqual([
      { tokenId: USD, kind: 'settle_out', quantity: '-1000', externalId: 'ibkr-trade-42:settle' },
      { tokenId: USD, kind: 'fee', quantity: '-1', externalId: 'ibkr-trade-42:fee' },
    ]);
  });

  test('an IBKR sell settles into the cash holding', () => {
    const legs = settlementLegsFor(
      ibkrBuy({ kind: 'sell', counterQuantity: '1000', feeQuantity: null, feeTokenId: null })
    );
    expect(legs).toEqual([
      { tokenId: USD, kind: 'settle_in', quantity: '1000', externalId: 'ibkr-trade-42:settle' },
    ]);
  });

  test('the settlement is the counter quantity exactly, gross of commission', () => {
    const [settle] = settlementLegsFor(ibkrBuy({ counterQuantity: '-1000.4523' }));
    expect(settle?.quantity).toBe('-1000.4523');
  });

  test('a fee written unsigned still lands as an outflow', () => {
    const fee = settlementLegsFor(ibkrBuy({ feeQuantity: '1.25' })).find((l) => l.kind === 'fee');
    expect(fee?.quantity).toBe('-1.25');
  });

  test('a dust fee is written in plain notation', () => {
    const fee = settlementLegsFor(ibkrBuy({ feeQuantity: '-0.00000001' })).find(
      (l) => l.kind === 'fee'
    );
    expect(fee?.quantity).toBe('-0.00000001');
  });

  test('a Kraken buy gets nothing, because Kraken already reports the cash row', () => {
    expect(settlementLegsFor(ibkrBuy({ source: 'kraken-api' }))).toEqual([]);
  });

  test('a wallet swap leg gets nothing', () => {
    expect(settlementLegsFor(ibkrBuy({ kind: 'swap_out', source: 'bybit-api' }))).toEqual([]);
  });

  test('a zero counter gets nothing', () => {
    expect(settlementLegsFor(ibkrBuy({ counterQuantity: '0' }))).toEqual([]);
    expect(settlementLegsFor(ibkrBuy({ counterQuantity: '-0.000' }))).toEqual([]);
  });

  test('a missing counter gets nothing', () => {
    expect(settlementLegsFor(ibkrBuy({ counterQuantity: null }))).toEqual([]);
    expect(settlementLegsFor(ibkrBuy({ counterTokenId: null }))).toEqual([]);
  });

  test('a fee paid in the traded asset writes no fee row', () => {
    const legs = settlementLegsFor({
      kind: 'buy',
      tokenId: BNB,
      counterQuantity: '-300',
      counterTokenId: USDT,
      feeQuantity: '-0.001',
      feeTokenId: BNB,
      externalId: 'binance-7',
      source: 'binance-api',
    });
    expect(legs).toEqual([
      { tokenId: USDT, kind: 'settle_out', quantity: '-300', externalId: 'binance-7:settle' },
    ]);
  });

  test('a zero fee writes no fee row', () => {
    const legs = settlementLegsFor(ibkrBuy({ feeQuantity: '0' }));
    expect(legs.map((l) => l.kind)).toEqual(['settle_out']);
  });

  test('a trade whose cash side is reported keeps its commission and writes no settlement', () => {
    expect(settlementLegsFor(ibkrBuy(), true)).toEqual([
      { tokenId: USD, kind: 'fee', quantity: '-1', externalId: 'ibkr-trade-42:fee' },
    ]);
  });
});

// SC-1464. IBKR charges a conversion's commission in the base currency, the
// same currency as the leg that carries it. The rule above (a fee in the
// traded asset stays on the trade) is right for a stock or a coin, and wrong
// for cash: the conversion's commission leaves the cash holding, and without a
// row the ledger misses it.
describe('the commission on a conversion, in its own currency (SC-1464)', () => {
  const usdLeg: Trade = {
    kind: 'sell',
    tokenId: USD,
    counterQuantity: '400',
    counterTokenId: CAD,
    feeQuantity: '-2',
    feeTokenId: USD,
    externalId: 'ibkr-fx-1',
    source: 'ibkr-api',
  };

  test('is written as a fee row on that cash', () => {
    expect(settlementLegsFor(usdLeg, true)).toEqual([
      { tokenId: USD, kind: 'fee', quantity: '-2', externalId: 'ibkr-fx-1:fee' },
    ]);
  });

  test('the other leg of the conversion carries no commission and writes nothing', () => {
    const cadLeg: Trade = {
      ...usdLeg,
      kind: 'buy',
      tokenId: CAD,
      counterQuantity: '-284.89',
      counterTokenId: USD,
      feeQuantity: null,
      feeTokenId: null,
      externalId: 'ibkr-fx-1:quote',
    };
    expect(settlementLegsFor(cadLeg, true)).toEqual([]);
  });
});

describe('tradesWithReportedCashSide', () => {
  // IBKR's EUR.USD conversion after SC-1452: one row per currency, each the
  // other's counter.
  const base = {
    source: 'ibkr-api',
    occurredAt: AT,
    tokenId: EUR,
    quantity: '500',
    counterTokenId: USD,
    counterQuantity: '-545.25',
  };
  const quote = {
    source: 'ibkr-api',
    occurredAt: AT,
    tokenId: USD,
    quantity: '-545.250',
    counterTokenId: EUR,
    counterQuantity: '500.00',
  };
  const stock = {
    source: 'ibkr-api',
    occurredAt: AT,
    tokenId: VOO,
    quantity: '2',
    counterTokenId: USD,
    counterQuantity: '-1000',
  };

  test('both legs of a conversion are reported, a stock trade beside them is not', () => {
    const reported = tradesWithReportedCashSide([base, quote, stock]);
    expect(reported.has(base)).toBe(true);
    expect(reported.has(quote)).toBe(true);
    expect(reported.has(stock)).toBe(false);
  });

  test('one leg alone is not reported', () => {
    expect(tradesWithReportedCashSide([base]).size).toBe(0);
  });

  test('a mirror at another instant or from another source is not the same conversion', () => {
    expect(
      tradesWithReportedCashSide([base, { ...quote, occurredAt: new Date(AT.getTime() + 1000) }])
        .size
    ).toBe(0);
    expect(tradesWithReportedCashSide([base, { ...quote, source: 'binance-api' }]).size).toBe(0);
  });

  test('a mirror with a different amount is not the same conversion', () => {
    expect(tradesWithReportedCashSide([base, { ...quote, quantity: '-545.26' }]).size).toBe(0);
  });
});
