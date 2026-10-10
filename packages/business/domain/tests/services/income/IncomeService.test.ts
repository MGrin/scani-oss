import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { UserRepository } from '../../../src/repositories/UserRepository';
import { IncomeService } from '../../../src/services/income/IncomeService';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import {
  ReturnsScopeResolver,
  type WeightedHolding,
} from '../../../src/services/returns/ReturnsScopeResolver';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { priceReaderStub } from '../../../test/helpers/price-series';

/**
 * Received income per month and group, in the base currency (SC-1644).
 *
 * Every row is in USD on a USD cash holding and the base is EUR at 0.9, so a
 * figure that skipped the conversion reads 10 where 9 is expected rather than
 * passing by coincidence.
 */

restoreContainerAfterAll();

const EUR = 'token-EUR';
const USD = 'token-USD';
const UNPRICED = 'token-UNPRICED';
const HOLDING = 'h-cash';
const UNPRICED_HOLDING = 'h-unpriced';
const NOW = new Date('2026-10-09T00:00:00Z');
const WINDOW = {
  kind: 'custom' as const,
  from: new Date('2026-01-01'),
  to: new Date('2026-09-30'),
};

let seq = 0;
function row(p: {
  ledgerKind: string;
  kindSubtype?: string | null;
  kind?: string;
  quantity: string;
  at: string;
  feeOf?: string | null;
  tokenId?: string;
  paidBy?: { isin: string; symbol: string };
  id?: string;
  holdingId?: string;
}): HoldingTransaction {
  seq += 1;
  return {
    id: p.id ?? `tx-${seq}`,
    userId: 'u',
    holdingId: p.holdingId ?? HOLDING,
    tokenId: p.tokenId ?? USD,
    kind: p.kind ?? (p.ledgerKind === 'fee' ? 'fee' : 'reward'),
    quantity: p.quantity,
    priceNative: null,
    priceNativeTokenId: null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    occurredAt: new Date(p.at),
    externalId: `ext-${seq}`,
    swapGroupId: null,
    transferGroupId: null,
    settlesTransactionId: null,
    transferReview: null,
    transferReviewSplit: null,
    source: 'ibkr-api',
    sourceMetadata: p.paidBy ? { paidBy: p.paidBy } : {},
    rawPayload: null,
    ledgerKind: p.ledgerKind,
    kindSubtype: p.kindSubtype ?? null,
    feeOf: p.feeOf ?? null,
    groupId: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as HoldingTransaction;
}

function service(
  rows: HoldingTransaction[],
  opts: { holdings?: WeightedHolding[] | null; baseCurrencyId?: string | null } = {}
): IncomeService {
  const holdings =
    opts.holdings === undefined ? [{ holdingId: HOLDING, weight: new Decimal(1) }] : opts.holdings;
  Container.set(ReturnsScopeResolver, {
    resolve: async () => holdings,
  } as unknown as ReturnsScopeResolver);
  Container.set(UserRepository, {
    findById: async () => ({
      id: 'u',
      baseCurrencyId: opts.baseCurrencyId === undefined ? EUR : opts.baseCurrencyId,
    }),
  } as unknown as UserRepository);
  Container.set(HoldingTransactionRepository, {
    findForHoldingsInRange: async () => rows,
  } as unknown as HoldingTransactionRepository);
  Container.set(HoldingRepository, {
    findIdsIncludedInTotal: async (ids: readonly string[]) => new Set(ids),
    findByIds: async () => [
      { id: HOLDING, tokenId: USD },
      { id: UNPRICED_HOLDING, tokenId: UNPRICED },
    ],
  } as unknown as HoldingRepository);
  Container.set(
    PriceReader,
    priceReaderStub((amount: Decimal, tokenId: string) =>
      tokenId === USD ? { amount: amount.times('0.9'), stale: false } : null
    )
  );
  const instance = new IncomeService();
  Container.set(IncomeService, instance);
  return instance;
}

async function summary(rows: HoldingTransaction[], holdings?: WeightedHolding[]) {
  const outcome = await service(rows, { holdings }).compute({
    userId: 'u',
    scope: { kind: 'user' },
    window: WINDOW,
    now: NOW,
  });
  if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);
  return outcome.income;
}

const amounts = (gross: string, withheld: string, net: string) => ({ gross, withheld, net });

describe('IncomeService (SC-1644)', () => {
  test('groups income by subtype and UTC month', async () => {
    const income = await summary([
      row({
        ledgerKind: 'income',
        kindSubtype: 'dividend',
        quantity: '10',
        at: '2026-03-05T12:00:00Z',
      }),
      row({
        ledgerKind: 'income',
        kindSubtype: 'interest',
        quantity: '2',
        at: '2026-03-31T23:30:00Z',
      }),
      row({ ledgerKind: 'income', kindSubtype: 'apy', quantity: '1', at: '2026-04-01T08:00:00Z' }),
    ]);
    expect(income.months).toEqual([
      {
        month: '2026-03',
        groups: { dividend: amounts('9', '0', '9'), interest: amounts('1.8', '0', '1.8') },
      },
      { month: '2026-04', groups: { interest: amounts('0.9', '0', '0.9') } },
    ]);
    expect(income.baseCurrencyId).toBe(EUR);
  });

  test("withholding lands in its dividend's month", async () => {
    const dividend = row({
      id: 'div-1',
      ledgerKind: 'income',
      kindSubtype: 'dividend',
      quantity: '10',
      at: '2026-03-05T12:00:00Z',
    });
    const income = await summary([
      dividend,
      row({ ledgerKind: 'fee', quantity: '-1.5', at: '2026-04-02T12:00:00Z', feeOf: 'div-1' }),
    ]);
    expect(income.months).toEqual([
      { month: '2026-03', groups: { dividend: amounts('9', '1.35', '7.65') } },
    ]);
    expect(income.totals.dividend).toEqual(amounts('9', '1.35', '7.65'));
  });

  test('a fee on a trade is not withholding', async () => {
    const income = await summary([
      row({
        id: 'trade-1',
        ledgerKind: 'trade_leg',
        kind: 'buy',
        quantity: '5',
        at: '2026-03-01T00:00:00Z',
      }),
      row({
        ledgerKind: 'income',
        kindSubtype: 'interest',
        quantity: '2',
        at: '2026-03-02T00:00:00Z',
      }),
      row({ ledgerKind: 'fee', quantity: '-1', at: '2026-03-01T00:00:00Z', feeOf: 'trade-1' }),
    ]);
    expect(income.totals).toEqual({ interest: amounts('1.8', '0', '1.8') });
  });

  test('vault weight scales gross and withheld alike', async () => {
    const income = await summary(
      [
        row({
          id: 'div-2',
          ledgerKind: 'income',
          kindSubtype: 'dividend',
          quantity: '10',
          at: '2026-03-05T00:00:00Z',
        }),
        row({ ledgerKind: 'fee', quantity: '-1.5', at: '2026-03-05T00:00:00Z', feeOf: 'div-2' }),
      ],
      [{ holdingId: HOLDING, weight: new Decimal('0.5') }]
    );
    expect(income.totals.dividend).toEqual(amounts('4.5', '0.675', '3.825'));
  });

  test('an unlabelled dividend counts as rewards', async () => {
    const income = await summary([
      row({
        ledgerKind: 'income',
        kindSubtype: 'reward',
        quantity: '10',
        at: '2026-03-05T00:00:00Z',
      }),
      row({ ledgerKind: 'income', kindSubtype: null, quantity: '10', at: '2026-03-06T00:00:00Z' }),
      row({
        ledgerKind: 'income',
        kindSubtype: 'airdrop',
        quantity: '10',
        at: '2026-03-07T00:00:00Z',
      }),
    ]);
    expect(income.totals).toEqual({ rewards: amounts('27', '0', '27') });
    expect(income.dividendsBySecurity).toEqual([]);
  });

  test('lists dividends by paying security', async () => {
    const acme = { isin: 'ZZ0000000017', symbol: 'ACME' };
    const globex = { isin: 'ZZ0000000025', symbol: 'GLOBEX' };
    const income = await summary([
      row({
        ledgerKind: 'income',
        kindSubtype: 'dividend',
        quantity: '10',
        at: '2026-03-05T00:00:00Z',
        paidBy: acme,
      }),
      row({
        ledgerKind: 'income',
        kindSubtype: 'dividend',
        quantity: '10',
        at: '2026-06-05T00:00:00Z',
        paidBy: acme,
      }),
      row({
        ledgerKind: 'income',
        kindSubtype: 'dividend',
        quantity: '5',
        at: '2026-03-20T00:00:00Z',
        paidBy: globex,
      }),
    ]);
    expect(income.dividendsBySecurity).toEqual([
      { isin: acme.isin, symbol: 'ACME', payments: 2, amounts: amounts('18', '0', '18') },
      { isin: globex.isin, symbol: 'GLOBEX', payments: 1, amounts: amounts('4.5', '0', '4.5') },
    ]);
  });

  test('an unpriced row is counted, not zeroed', async () => {
    const income = await summary(
      [
        row({
          ledgerKind: 'income',
          kindSubtype: 'staking',
          quantity: '3',
          at: '2026-03-05T00:00:00Z',
          tokenId: UNPRICED,
          holdingId: UNPRICED_HOLDING,
        }),
        row({
          ledgerKind: 'income',
          kindSubtype: 'interest',
          quantity: '2',
          at: '2026-03-05T00:00:00Z',
        }),
      ],
      [
        { holdingId: HOLDING, weight: new Decimal(1) },
        { holdingId: UNPRICED_HOLDING, weight: new Decimal(1) },
      ]
    );
    expect(income.unpricedCount).toBe(1);
    expect(income.totals).toEqual({ interest: amounts('1.8', '0', '1.8') });
  });

  test('counts withholding that names a security but links to nothing', async () => {
    const income = await summary([
      row({
        ledgerKind: 'fee',
        quantity: '-1',
        at: '2026-03-05T00:00:00Z',
        paidBy: { isin: 'ZZ0000000017', symbol: 'ACME' },
      }),
      // The control: a plain fee with no security is not withholding at all.
      row({ ledgerKind: 'fee', quantity: '-1', at: '2026-03-05T00:00:00Z' }),
    ]);
    expect(income.unmatchedWithholdingCount).toBe(1);
    expect(income.totals).toEqual({});
  });

  test('a reversed dividend reduces gross, and a refunded tax reduces withheld', async () => {
    // The ledger's sign is the direction: a negative income row takes income
    // back, and a positive fee on a dividend returns tax. Valued as magnitudes
    // both would ADD, overstating the figure they correct.
    const income = await summary([
      row({
        id: 'div-r',
        ledgerKind: 'income',
        kindSubtype: 'dividend',
        quantity: '10',
        at: '2026-03-05T00:00:00Z',
      }),
      row({
        ledgerKind: 'income',
        kindSubtype: 'dividend',
        quantity: '-4',
        at: '2026-03-06T00:00:00Z',
      }),
      row({ ledgerKind: 'fee', quantity: '-1.5', at: '2026-03-05T00:00:00Z', feeOf: 'div-r' }),
      row({ ledgerKind: 'fee', quantity: '0.5', at: '2026-03-07T00:00:00Z', feeOf: 'div-r' }),
    ]);
    expect(income.totals.dividend).toEqual(amounts('5.4', '0.9', '4.5'));
  });

  test('outcomes', async () => {
    const request = { userId: 'u', scope: { kind: 'user' as const }, window: WINDOW, now: NOW };
    expect((await service([], { holdings: null }).compute(request)).status).toBe('scope-not-found');
    expect((await service([], { baseCurrencyId: null }).compute(request)).status).toBe(
      'no-base-currency'
    );
  });
});
