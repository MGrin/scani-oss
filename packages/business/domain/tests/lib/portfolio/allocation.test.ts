import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { aggregateAllocation, splitDebt } from '../../../src/lib/portfolio/allocation';

function holding(
  id: string,
  opts: {
    tokenId: string;
    typeCode: string;
    accountId: string;
    balance: string;
    isActive?: boolean;
  }
) {
  return {
    holding: { id, balance: opts.balance, isActive: opts.isActive ?? true },
    token: {
      id: opts.tokenId,
      symbol: opts.tokenId.toUpperCase(),
      name: opts.tokenId,
      typeId: `type-${opts.typeCode}`,
      typeCode: opts.typeCode,
      typeName: opts.typeCode,
    },
    account: {
      id: opts.accountId,
      name: opts.accountId,
      typeCode: 'brokerage',
      typeName: 'Brokerage',
    },
    institution: { id: 'ibkr', name: 'IBKR', typeCode: 'broker', typeName: 'Broker' },
  };
}

const prices = new Map([
  ['aapl', '100'],
  ['usd', '1'],
  ['btc', '50000'],
]);

const stocks = holding('h-stock', {
  tokenId: 'aapl',
  typeCode: 'stock',
  accountId: 'margin',
  balance: '100',
});
const usdDebt = holding('h-usd', {
  tokenId: 'usd',
  typeCode: 'fiat',
  accountId: 'margin',
  balance: '-2500',
});
const btc = holding('h-btc', {
  tokenId: 'btc',
  typeCode: 'crypto',
  accountId: 'wallet',
  balance: '0.1',
});

describe('aggregateAllocation', () => {
  test('negative cash is debt beside the slices, never a slice', () => {
    const { items, marginDebt } = aggregateAllocation([stocks, usdDebt], prices, 'token_type');
    expect(items).toEqual([
      { id: 'type-stock', code: 'stock', name: 'stock', value: '10000', percentage: '100.00' },
    ]);
    expect(marginDebt.toString()).toBe('-2500');
  });

  test('the account cut shows the account at its assets, not its net', () => {
    const { items, marginDebt } = aggregateAllocation([stocks, usdDebt], prices, 'account');
    expect(items.map((item) => [item.id, item.value])).toEqual([['margin', '10000']]);
    expect(marginDebt.toString()).toBe('-2500');
  });

  test('an inactive negative holding is neither slice nor debt', () => {
    const inactive = { ...usdDebt, holding: { ...usdDebt.holding, isActive: false } };
    const { items, marginDebt } = aggregateAllocation([stocks, inactive], prices, 'token_type');
    expect(items.map((item) => item.value)).toEqual(['10000']);
    expect(marginDebt.isZero()).toBe(true);
  });

  test('an unpriced negative holding is neither slice nor debt', () => {
    const { items, marginDebt } = aggregateAllocation(
      [stocks, usdDebt],
      new Map([['aapl', '100']]),
      'token_type'
    );
    expect(items.map((item) => item.value)).toEqual(['10000']);
    expect(marginDebt.isZero()).toBe(true);
  });

  test('debt larger than the assets: no slices, the whole debt, no division by zero', () => {
    const second = holding('h-eur', {
      tokenId: 'usd',
      typeCode: 'fiat',
      accountId: 'other',
      balance: '-500',
    });
    const { items, marginDebt } = aggregateAllocation([usdDebt, second], prices, 'token_type');
    expect(items).toEqual([]);
    expect(marginDebt.toString()).toBe('-3000');
  });

  test('percentages are shares of gross assets and sum to 100', () => {
    const { items } = aggregateAllocation([stocks, usdDebt, btc], prices, 'token_type');
    expect(items.map((item) => [item.code, item.percentage])).toEqual([
      ['stock', '66.67'],
      ['crypto', '33.33'],
    ]);
  });

  test('slices plus debt is the net total, to the cent', () => {
    const all = [stocks, usdDebt, btc];
    const { items, marginDebt } = aggregateAllocation(all, prices, 'account');
    const net = all.reduce(
      (sum, { holding: h, token }) => sum.plus(new Decimal(h.balance).mul(prices.get(token.id)!)),
      new Decimal(0)
    );
    const slices = items.reduce((sum, item) => sum.plus(item.value), new Decimal(0));
    expect(slices.plus(marginDebt).toFixed(2)).toBe(net.toFixed(2));
    expect(net.toFixed(2)).toBe('12500.00');
  });
});

describe('splitDebt', () => {
  test('takes active priced negative holdings out and sums them', () => {
    const { assets, marginDebt } = splitDebt([stocks, usdDebt, btc], prices);
    expect(assets).toEqual([stocks, btc]);
    expect(marginDebt.toString()).toBe('-2500');
  });

  test('keeps inactive and unpriced holdings for the caller to judge', () => {
    const inactive = { ...usdDebt, holding: { ...usdDebt.holding, isActive: false } };
    const { assets, marginDebt } = splitDebt([inactive, usdDebt], new Map([['aapl', '100']]));
    expect(assets).toEqual([inactive, usdDebt]);
    expect(marginDebt.isZero()).toBe(true);
  });
});
