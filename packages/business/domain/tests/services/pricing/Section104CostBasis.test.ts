process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import {
  CostBasisService,
  type DisposalLotMatch,
} from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

/**
 * HMRC's identification rules, checked against HMRC's own published answers
 * (SC-462).
 *
 * Every scenario below is a worked example the department publishes with a
 * figure in it, transcribed rather than invented, and the assertion is that
 * figure. That is deliberate and it is the whole point of this file: a cost
 * basis is the one number in this product whose being wrong costs something
 * outside the app, and a test that agrees with the implementation proves only
 * that the implementation is consistent with itself.
 *
 *   - CRYPTO22251 — Victoria. Section 104 pool, two purchases at very
 *     different prices, one disposal.
 *   - CRYPTO22252 — Martyn. Same-day rule, two disposals and one acquisition
 *     on 23 June, TCGA92/S105(1) treating them as single transactions.
 *   - CRYPTO22253 — Rachel. The 30-day rule across three later acquisitions,
 *     which also fixes the far edge of the window: a 1 May purchase is NOT
 *     matched to a 31 March disposal.
 *   - CRYPTO22256 — Gulferaz. All three rules on one ledger, in order.
 *   - CG51560 Example 3 — Mrs C. A repurchase on day 31 falls through to the
 *     pool.
 *
 * HMRC states its money figures rounded to whole pounds. Where the exact
 * arithmetic has pence in it, both are asserted: the unrounded figure the walk
 * must produce, and the fact that rounding it to the pound gives HMRC's
 * published number.
 */

restoreContainerAfterAll();

const GBP = 'token-GBP';
const ASSET = 'token-ASSET';
const HOLDING = 'h';

function makeService(): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(PriceGraphService, {
    convert: async () => {
      throw new Error('every figure in these examples is priced in the base currency');
    },
  } as unknown as PriceGraphService);
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

let txSeq = 0;

/**
 * One ledger row, priced in the base currency so no price graph is consulted.
 *
 * `total` is what HMRC's example states — the consideration for the whole
 * transaction — and `priceNative` is per unit, which is what the valuation
 * reads. Writing the examples in their own terms is what keeps a transcription
 * error from looking like a matching error.
 */
function row(p: {
  kind: string;
  quantity: string;
  total: string;
  occurredAt: string;
  holdingId?: string;
}): HoldingTransaction {
  txSeq += 1;
  const unit = new Decimal(p.total).div(new Decimal(p.quantity)).toString();
  return {
    id: `tx-${txSeq}`,
    userId: 'u',
    holdingId: p.holdingId ?? HOLDING,
    tokenId: ASSET,
    kind: p.kind,
    quantity: p.quantity,
    priceNative: unit,
    priceNativeTokenId: GBP,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    occurredAt: new Date(p.occurredAt),
    externalId: `ext-${txSeq}`,
    swapGroupId: null,
    transferGroupId: null,
    transferReview: null,
    transferReviewSplit: null,
    transferReviewedAt: null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as HoldingTransaction;
}

interface Walked {
  realizedPnl: Decimal;
  openQty: Decimal;
  costBasis: Decimal;
  ledger: DisposalLotMatch[];
}

async function walkUk(txs: HoldingTransaction[]): Promise<Walked> {
  const ledger: DisposalLotMatch[] = [];
  const result = await makeService().walkLots(
    undefined,
    txs,
    GBP,
    null,
    undefined,
    'complete',
    ledger,
    'uk_section_104'
  );
  return {
    realizedPnl: result.realizedPnl,
    openQty: result.openQty,
    costBasis: result.costBasis,
    ledger,
  };
}

async function walkFifo(txs: HoldingTransaction[]): Promise<Walked> {
  const ledger: DisposalLotMatch[] = [];
  const result = await makeService().walkLots(
    undefined,
    txs,
    GBP,
    null,
    undefined,
    'complete',
    ledger
  );
  return {
    realizedPnl: result.realizedPnl,
    openQty: result.openQty,
    costBasis: result.costBasis,
    ledger,
  };
}

/** The gain the walk booked for one transaction, summed over its lot matches. */
function gainOf(ledger: readonly DisposalLotMatch[], transactionId: string): Decimal {
  return ledger
    .filter((r) => r.transactionId === transactionId)
    .reduce((sum, r) => (r.gain ? sum.add(r.gain) : sum), new Decimal(0));
}

/** The cost side of one transaction's matches — what HMRC calls allowable costs. */
function costOf(ledger: readonly DisposalLotMatch[], transactionId: string): Decimal {
  return ledger
    .filter((r) => r.transactionId === transactionId)
    .reduce((sum, r) => sum.add(r.costBasis), new Decimal(0));
}

/** Which acquisition dates a disposal was identified against, ISO, deduped. */
function matchedDates(ledger: readonly DisposalLotMatch[], transactionId: string): string[] {
  return [
    ...new Set(
      ledger
        .filter((r) => r.transactionId === transactionId)
        .map((r) => r.acquiredAt?.toISOString().slice(0, 10) ?? 'unmatched')
    ),
  ].sort();
}

/**
 * HMRC's published figures, from ours.
 *
 * The department rounds an allowable cost UP to the whole pound and derives
 * the gain from the rounded figure — 1,500/1,600 x £1,000 is £937.50 and the
 * example says £938, then £1,400 - £938 = £462; £345,000 x 100,000/110,000 is
 * £313,636.36 and the example says £313,637, then £150,000 - £313,637 =
 * -£163,637. Rounding the gain directly gives £463 and -£163,636, which is
 * neither example's answer.
 *
 * The walk keeps full precision and is right to: this is a convention for
 * filling in a return, applied once at the end, not the arithmetic. So the
 * tests assert the exact figure AND that HMRC's own rounding turns it into
 * HMRC's own published number. Anything else would be reading the examples
 * loosely enough to hide a real disagreement.
 */
const allowableCostInPounds = (d: Decimal): string =>
  d.toDecimalPlaces(0, Decimal.ROUND_CEIL).toString();

describe('Section 104 — the pool (HMRC CRYPTO22251, Victoria)', () => {
  // Victoria bought 100 token A for £1,000 and later 50 more for £125,000,
  // giving one pool of 150 tokens and £126,000 of allowable cost. She sells 50
  // for £300,000. HMRC: allowable cost £126,000 x (50/150) = £42,000, gain
  // £258,000, and £84,000 of pooled cost left against the remaining 100.
  const ledger = () => [
    row({ kind: 'buy', quantity: '100', total: '1000', occurredAt: '2023-01-10T10:00:00Z' }),
    row({ kind: 'buy', quantity: '50', total: '125000', occurredAt: '2023-09-18T10:00:00Z' }),
    row({ kind: 'sell', quantity: '50', total: '300000', occurredAt: '2023-12-01T10:00:00Z' }),
  ];

  test('the disposal takes the pooled average cost, not the oldest lot', async () => {
    const txs = ledger();
    const sale = txs[2] as HoldingTransaction;
    const uk = await walkUk(txs);

    expect(costOf(uk.ledger, sale.id).toString()).toBe('42000');
    expect(gainOf(uk.ledger, sale.id).toString()).toBe('258000');
    expect(uk.realizedPnl.toString()).toBe('258000');
  });

  test('what is left in the pool is what HMRC says is left', async () => {
    const uk = await walkUk(ledger());
    expect(uk.openQty.toString()).toBe('100');
    expect(uk.costBasis.toString()).toBe('84000');
  });

  test('FIFO on the same ledger answers differently, and is left alone', async () => {
    const txs = ledger();
    const sale = txs[2] as HoldingTransaction;
    const fifo = await walkFifo(txs);

    // Oldest first: the whole 100-token lot at £1,000 is too big to be the
    // match, so 50 of it goes at £500. Nothing about that is wrong under a
    // FIFO regime, and it is not HMRC's answer.
    expect(costOf(fifo.ledger, sale.id).toString()).toBe('500');
    expect(fifo.realizedPnl.toString()).toBe('299500');
  });
});

describe('Same-day rule — TCGA92/S105(1) (HMRC CRYPTO22252, Martyn)', () => {
  // Martyn holds 5,000 token B with £500 of pooled cost. On 23 June he sells
  // 1,000 for £800 in the morning, buys 1,600 for £1,000 in the afternoon, and
  // sells 500 for £600 in the evening. HMRC treats the two disposals as a
  // single disposal of 1,500 for £1,400 matched to that day's acquisition:
  // allowable cost 1,500/1,600 x £1,000 = £938, gain £462. The unmatched 100
  // tokens and their £62 of cost go to the pool, making it 5,100 and £562.
  const ledger = () => [
    row({
      kind: 'opening_balance',
      quantity: '5000',
      total: '500',
      occurredAt: '2023-01-02T10:00:00Z',
    }),
    row({ kind: 'sell', quantity: '1000', total: '800', occurredAt: '2023-06-23T09:00:00Z' }),
    row({ kind: 'buy', quantity: '1600', total: '1000', occurredAt: '2023-06-23T14:00:00Z' }),
    row({ kind: 'sell', quantity: '500', total: '600', occurredAt: '2023-06-23T19:00:00Z' }),
  ];

  test('both disposals match the same-day acquisition, including the one made before it', async () => {
    const txs = ledger();
    const morning = txs[1] as HoldingTransaction;
    const evening = txs[3] as HoldingTransaction;
    const uk = await walkUk(txs);

    expect(matchedDates(uk.ledger, morning.id)).toEqual(['2023-06-23']);
    expect(matchedDates(uk.ledger, evening.id)).toEqual(['2023-06-23']);
    // 1,000/1,600 and 500/1,600 of £1,000 — the same unit cost for both, which
    // is what treating the day as one transaction means.
    expect(costOf(uk.ledger, morning.id).toString()).toBe('625');
    expect(costOf(uk.ledger, evening.id).toString()).toBe('312.5');
  });

  test("the day's total allowable cost and gain are HMRC's £938 and £462", async () => {
    const uk = await walkUk(ledger());
    const cost = uk.ledger.reduce((s, r) => s.add(r.costBasis), new Decimal(0));

    expect(cost.toString()).toBe('937.5');
    expect(allowableCostInPounds(cost)).toBe('938');
    expect(uk.realizedPnl.toString()).toBe('462.5');
    // £1,400 of proceeds less HMRC's rounded £938.
    expect(new Decimal(1400).minus(allowableCostInPounds(cost)).toString()).toBe('462');
  });

  test('the 100 unmatched tokens and their £62 of cost join the pool', async () => {
    const uk = await walkUk(ledger());
    expect(uk.openQty.toString()).toBe('5100');
    expect(uk.costBasis.toString()).toBe('562.5');
    // HMRC's £562 is £500 of opening pool plus the £62 the day's acquisition
    // did not spend — £1,000 less the rounded £938.
    expect(new Decimal(500).plus(new Decimal(1000).minus(938)).toString()).toBe('562');
  });
});

describe('Bed and breakfast — TCGA92/S106A(5) (HMRC CRYPTO22253, Rachel)', () => {
  // Rachel sells 1,000 token C on 31 March for £400 and 500 on 20 April for
  // £150, then buys 700 on 21 April for £175, 500 on 28 April for £100 and 500
  // on 1 May for £150. HMRC matches the earliest acquisition to the earliest
  // disposal: the 31 March sale takes all 700 of 21 April (£175) and 300 of 28
  // April (£60) for a gain of £165; the 20 April sale takes the remaining 200
  // of 28 April (£40) and 300 of 1 May (£90) for a gain of £20. 200 tokens
  // costing £60 are left for the pool.
  //
  // 1 May is 31 days after 31 March, which is why the earlier disposal cannot
  // reach it — the far edge of the window, fixed by HMRC's own answer.
  const ledger = () => [
    row({
      kind: 'opening_balance',
      quantity: '5000',
      total: '2500',
      occurredAt: '2023-01-02T10:00:00Z',
    }),
    row({ kind: 'sell', quantity: '1000', total: '400', occurredAt: '2023-03-31T10:00:00Z' }),
    row({ kind: 'sell', quantity: '500', total: '150', occurredAt: '2023-04-20T10:00:00Z' }),
    row({ kind: 'buy', quantity: '700', total: '175', occurredAt: '2023-04-21T10:00:00Z' }),
    row({ kind: 'buy', quantity: '500', total: '100', occurredAt: '2023-04-28T10:00:00Z' }),
    row({ kind: 'buy', quantity: '500', total: '150', occurredAt: '2023-05-01T10:00:00Z' }),
  ];

  test('the earlier disposal takes the earlier acquisitions, and cannot reach day 31', async () => {
    const txs = ledger();
    const march = txs[1] as HoldingTransaction;
    const april = txs[2] as HoldingTransaction;
    const uk = await walkUk(txs);

    expect(matchedDates(uk.ledger, march.id)).toEqual(['2023-04-21', '2023-04-28']);
    expect(matchedDates(uk.ledger, april.id)).toEqual(['2023-04-28', '2023-05-01']);
    expect(costOf(uk.ledger, march.id).toString()).toBe('235');
    expect(costOf(uk.ledger, april.id).toString()).toBe('130');
  });

  test("both gains are HMRC's £165 and £20", async () => {
    const txs = ledger();
    const uk = await walkUk(txs);
    expect(gainOf(uk.ledger, (txs[1] as HoldingTransaction).id).toString()).toBe('165');
    expect(gainOf(uk.ledger, (txs[2] as HoldingTransaction).id).toString()).toBe('20');
    expect(uk.realizedPnl.toString()).toBe('185');
  });

  test('the 200 unmatched tokens reach the pool at £60, and the pool paid for none of it', async () => {
    const uk = await walkUk(ledger());
    // 5,000 opening, less 1,500 sold, plus 1,700 bought.
    expect(uk.openQty.toString()).toBe('5200');
    expect(uk.costBasis.toString()).toBe('2560');
  });
});

describe('Day 31 falls through to the pool (HMRC CG51560, Example 3)', () => {
  // Mrs C held 10,000 shares, sold 2,000 on 28 February 2009 and bought 3,000
  // on 31 March 2009. HMRC: that is more than 30 days after, so the bed and
  // breakfast rule does not apply and the disposal is identified with the
  // Section 104 holding instead.
  const ledgerWith = (repurchase: string) => [
    row({
      kind: 'opening_balance',
      quantity: '10000',
      total: '10000',
      occurredAt: '2008-06-02T10:00:00Z',
    }),
    row({ kind: 'sell', quantity: '2000', total: '6000', occurredAt: '2009-02-28T10:00:00Z' }),
    row({ kind: 'buy', quantity: '3000', total: '18000', occurredAt: repurchase }),
  ];

  test('a repurchase on day 31 is not matched — the pool pays', async () => {
    const txs = ledgerWith('2009-03-31T10:00:00Z');
    const sale = txs[1] as HoldingTransaction;
    const uk = await walkUk(txs);

    expect(matchedDates(uk.ledger, sale.id)).toEqual(['2008-06-02']);
    // 10,000 pooled cost over 10,000 units; 2,000 units cost £2,000.
    expect(costOf(uk.ledger, sale.id).toString()).toBe('2000');
    expect(gainOf(uk.ledger, sale.id).toString()).toBe('4000');
  });

  test('the same repurchase one day earlier IS matched — day 30 is inside', async () => {
    const txs = ledgerWith('2009-03-30T10:00:00Z');
    const sale = txs[1] as HoldingTransaction;
    const uk = await walkUk(txs);

    expect(matchedDates(uk.ledger, sale.id)).toEqual(['2009-03-30']);
    // 2,000/3,000 of £18,000.
    expect(costOf(uk.ledger, sale.id).toString()).toBe('12000');
    expect(gainOf(uk.ledger, sale.id).toString()).toBe('-6000');
  });
});

describe('All three rules on one ledger (HMRC CRYPTO22256, Gulferaz)', () => {
  // Gulferaz holds 100,000 token F pooled at £300,000. He acquires 10,000 for
  // £45,000 on 31 July and disposes of 30,000 for £150,000 the same day;
  // disposes of 20,000 for £100,000 on 5 August; acquires 50,000 for £225,000
  // on 6 August; disposes of 100,000 for £150,000 on 7 August.
  //
  // HMRC: the 31 July disposal takes 10,000 same-day (£45,000) and 20,000 from
  // 6 August (£90,000) for a gain of £15,000. The 5 August disposal takes
  // 20,000 more from 6 August (£90,000) for a gain of £10,000. The 10,000 left
  // over enters the pool at £45,000, making it 110,000 and £345,000. The 7
  // August disposal then takes £313,637 of pooled cost for a loss of £163,637.
  const ledger = () => [
    row({
      kind: 'opening_balance',
      quantity: '100000',
      total: '300000',
      occurredAt: '2023-01-02T10:00:00Z',
    }),
    row({ kind: 'buy', quantity: '10000', total: '45000', occurredAt: '2023-07-31T09:00:00Z' }),
    row({ kind: 'sell', quantity: '30000', total: '150000', occurredAt: '2023-07-31T15:00:00Z' }),
    row({ kind: 'sell', quantity: '20000', total: '100000', occurredAt: '2023-08-05T10:00:00Z' }),
    row({ kind: 'buy', quantity: '50000', total: '225000', occurredAt: '2023-08-06T10:00:00Z' }),
    row({ kind: 'sell', quantity: '100000', total: '150000', occurredAt: '2023-08-07T10:00:00Z' }),
  ];

  test('the 31 July disposal draws same-day first, then the 30-day window', async () => {
    const txs = ledger();
    const july = txs[2] as HoldingTransaction;
    const uk = await walkUk(txs);

    expect(matchedDates(uk.ledger, july.id)).toEqual(['2023-07-31', '2023-08-06']);
    expect(costOf(uk.ledger, july.id).toString()).toBe('135000');
    expect(gainOf(uk.ledger, july.id).toString()).toBe('15000');
  });

  test('the 5 August disposal takes what the earlier one left of 6 August', async () => {
    const txs = ledger();
    const august = txs[3] as HoldingTransaction;
    const uk = await walkUk(txs);

    expect(matchedDates(uk.ledger, august.id)).toEqual(['2023-08-06']);
    expect(costOf(uk.ledger, august.id).toString()).toBe('90000');
    expect(gainOf(uk.ledger, august.id).toString()).toBe('10000');
  });

  test('the 7 August disposal reaches the pool, at £313,637 for a £163,637 loss', async () => {
    const txs = ledger();
    const final = txs[5] as HoldingTransaction;
    const uk = await walkUk(txs);

    // £345,000 x 100,000/110,000. HMRC states the rounded pound.
    const cost = costOf(uk.ledger, final.id);
    expect(cost.toDecimalPlaces(4).toString()).toBe('313636.3636');
    expect(allowableCostInPounds(cost)).toBe('313637');
    expect(new Decimal(150000).minus(allowableCostInPounds(cost)).toString()).toBe('-163637');
    expect(gainOf(uk.ledger, final.id).toDecimalPlaces(4).toString()).toBe('-163636.3636');
  });

  test('the pool is 110,000 at £345,000 before the last disposal draws on it', async () => {
    const txs = ledger();
    // Cut the walk before 7 August: the pool state HMRC states explicitly.
    const uk = await walkUk(txs.slice(0, 5));
    expect(uk.openQty.toString()).toBe('110000');
    expect(uk.costBasis.toString()).toBe('345000');
  });

  test('every per-row gain still sums to the scalar the walk reports', async () => {
    const uk = await walkUk(ledger());
    const summed = uk.ledger.reduce((s, r) => (r.gain ? s.add(r.gain) : s), new Decimal(0));
    expect(summed.toString()).toBe(uk.realizedPnl.toString());
  });
});

describe('The default is untouched', () => {
  test('a walk that asks for nothing is FIFO, byte for byte', async () => {
    const txs = [
      row({ kind: 'buy', quantity: '10', total: '100', occurredAt: '2023-01-02T10:00:00Z' }),
      row({ kind: 'buy', quantity: '10', total: '300', occurredAt: '2023-02-02T10:00:00Z' }),
      row({ kind: 'sell', quantity: '15', total: '600', occurredAt: '2023-03-02T10:00:00Z' }),
    ];
    const implicit = await walkFifo(txs.map((t) => ({ ...t })));
    const explicit = await makeService().walkLots(
      undefined,
      txs.map((t) => ({ ...t })),
      GBP,
      null,
      undefined,
      'complete',
      undefined,
      'fifo'
    );
    // Oldest first: all 10 at £100 plus 5 of the second lot at £150 = £250.
    expect(implicit.realizedPnl.toString()).toBe('350');
    expect(explicit.realizedPnl.toString()).toBe(implicit.realizedPnl.toString());
    expect(explicit.costBasis.toString()).toBe(implicit.costBasis.toString());
  });
});

describe("The tax day is London's, not UTC's", () => {
  test('a purchase at 23:00 UTC on 30 June is same-day with a 1 July sale', async () => {
    // 23:00 UTC is 00:00 on 1 July under British Summer Time. On the UTC
    // calendar the purchase is the day BEFORE the sale, which puts it outside
    // the bed-and-breakfast window (that looks forward only) and hands the
    // disposal the pool instead — a different number, from an hour.
    const txs = [
      row({
        kind: 'opening_balance',
        quantity: '1000',
        total: '1000',
        occurredAt: '2023-01-02T10:00:00Z',
      }),
      row({ kind: 'buy', quantity: '100', total: '500', occurredAt: '2023-06-30T23:00:00Z' }),
      row({ kind: 'sell', quantity: '100', total: '600', occurredAt: '2023-07-01T10:00:00Z' }),
    ];
    const sale = txs[2] as HoldingTransaction;
    const uk = await walkUk(txs);

    expect(matchedDates(uk.ledger, sale.id)).toEqual(['2023-06-30']);
    expect(costOf(uk.ledger, sale.id).toString()).toBe('500');
    expect(gainOf(uk.ledger, sale.id).toString()).toBe('100');
  });
});

describe("A transfer between the reader's own accounts is not an acquisition", () => {
  test('the pooled cost moves with the coins and nothing is identified against them', async () => {
    const group = 'grp-1';
    const out = row({
      kind: 'transfer_out',
      quantity: '40',
      total: '400',
      occurredAt: '2023-06-01T10:00:00Z',
    });
    const inn = row({
      kind: 'transfer_in',
      quantity: '40',
      total: '400',
      occurredAt: '2023-06-01T12:00:00Z',
      holdingId: 'h2',
    });
    const txs: HoldingTransaction[] = [
      row({ kind: 'buy', quantity: '100', total: '100', occurredAt: '2023-01-02T10:00:00Z' }),
      { ...out, transferGroupId: group },
      { ...inn, transferGroupId: group },
      row({
        kind: 'sell',
        quantity: '20',
        total: '200',
        occurredAt: '2023-06-15T10:00:00Z',
        holdingId: 'h2',
      }),
    ];
    const byHolding = new Map<string, HoldingTransaction[]>([
      [HOLDING, txs.filter((t) => t.holdingId === HOLDING)],
      ['h2', txs.filter((t) => t.holdingId === 'h2')],
    ]);
    const ledger: DisposalLotMatch[] = [];
    const walked = await makeService().walkComponent(
      undefined,
      [HOLDING, 'h2'],
      byHolding,
      new Date('2023-12-31T00:00:00Z'),
      GBP,
      new Map(),
      undefined,
      new Map(),
      ledger,
      'uk_section_104'
    );

    const sale = txs[3] as HoldingTransaction;
    // The transfer_in is on the same day as the transfer_out and would be a
    // textbook same-day match if it were an acquisition. It is not one: no
    // beneficial ownership changed, and the arriving lot is the departing lot.
    expect(matchedDates(ledger, sale.id)).toEqual(['2023-01-02']);
    // 40 units left the source at £1 each, so the destination sells 20 at £1.
    expect(costOf(ledger, sale.id).toString()).toBe('20');
    expect(walked.get(HOLDING)?.realizedPnl.toString()).toBe('0');
    expect(walked.get('h2')?.realizedPnl.toString()).toBe('180');
    expect(walked.get(HOLDING)?.costBasis.toString()).toBe('60');
    expect(walked.get('h2')?.costBasis.toString()).toBe('20');
  });
});
