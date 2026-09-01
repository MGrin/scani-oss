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
  type HistoryCompleteness,
} from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * The per-disposal ledger (SC-152).
 *
 * The load-bearing assertion in this file is `gainTotal(...) === realizedPnl`:
 * the sum of the per-row gains must equal the scalar the same walk accumulates.
 * That scalar is what every PnL chart, every `portfolio_value_daily` row and
 * both exports already show, so a ledger whose rows do not add up to it is an
 * explanation that contradicts the figure it explains — and it would do so
 * silently, on the screen the reader opened to resolve a doubt.
 *
 * The second thing these tests pin is SC-150: only a person's `left_control`
 * answer books a gain. The ledger has to record the *absence* of a realization
 * as its own outcome, because "nothing happened" and "we are waiting on you"
 * are the same arithmetic and different answers.
 */

const USD = 'token-USD';
const BTC = 'token-BTC';

function makeService(): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(PriceGraphService, {
    convert: async () => {
      throw new Error('PriceGraphService.convert should not be called in these tests');
    },
  } as unknown as PriceGraphService);
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

/**
 * A service whose price graph answers for exactly one token (SC-397).
 *
 * The asymmetry is the point: production's two refusing legs are swaps where
 * one side has price history and the other has none, so the leg denominated
 * in the priceless side cannot be converted while the token in hand can.
 */
function makeServiceWithSpot(priceable: string, rate: string): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(PriceGraphService, {
    convert: async (amount: Decimal, from: string) =>
      from === priceable ? { amount: amount.mul(rate), stale: false } : null,
  } as unknown as PriceGraphService);
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

let txSeq = 0;
function tx(p: {
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  priceNative?: string;
  priceNativeTokenId?: string;
  transferGroupId?: string;
  transferReview?: string;
  transferReviewSplit?: unknown;
  /** Defaults to a stamp whenever an answer is present — which is what every
   *  application write path does. Pass `null` for the state that only a raw
   *  `UPDATE` produces, and that most production rows are in (SC-324).
   *
   *  **It no longer decides provenance** (SC-673). It used to, and the fixture
   *  set no source at all — so every answered row here was `user` by default,
   *  from a date. Provenance is `transferReviewSource` and only that. */
  transferReviewedAt?: Date | null;
  /** WHO answered. Absent means the database does not record it. */
  transferReviewSource?: string | null;
}): HoldingTransaction {
  txSeq += 1;
  return {
    id: `tx-${txSeq}`,
    userId: 'u',
    holdingId: p.holdingId,
    tokenId: BTC,
    kind: p.kind,
    quantity: p.quantity,
    priceNative: p.priceNative ?? null,
    priceNativeTokenId: p.priceNativeTokenId ?? (p.priceNative ? USD : null),
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    occurredAt: new Date(p.occurredAt),
    externalId: `ext-${txSeq}`,
    swapGroupId: null,
    transferGroupId: p.transferGroupId ?? null,
    transferReview: p.transferReview ?? null,
    transferReviewSplit: p.transferReviewSplit ?? null,
    transferReviewedAt:
      p.transferReviewedAt !== undefined
        ? p.transferReviewedAt
        : p.transferReview
          ? new Date()
          : null,
    transferReviewSource: p.transferReviewSource ?? null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as HoldingTransaction;
}

/** The invariant, in one place: rows that booked nothing carry a null gain and
 *  contribute nothing, and everything else must add up to the scalar. */
function gainTotal(rows: readonly DisposalLotMatch[]): Decimal {
  return rows.reduce((sum, d) => (d.gain ? sum.add(d.gain) : sum), new Decimal(0));
}

const componentInputs = (txs: HoldingTransaction[]): Map<string, HoldingTransaction[]> => {
  const byHolding = new Map<string, HoldingTransaction[]>();
  for (const t of txs) {
    const list = byHolding.get(t.holdingId);
    if (list) list.push(t);
    else byHolding.set(t.holdingId, [t]);
  }
  return byHolding;
};

describe('walkLots disposal ledger', () => {
  test('one row per matched lot, each with its own acquisition date', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '4',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '6',
          occurredAt: '2024-06-01',
          priceNative: '200',
        }),
        tx({
          holdingId: 'h',
          kind: 'sell',
          quantity: '-8',
          occurredAt: '2025-03-01',
          priceNative: '300',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(ledger).toHaveLength(2);
    const [first, second] = ledger as [DisposalLotMatch, DisposalLotMatch];

    // FIFO: the whole January lot, then 4 of the 6 bought in June.
    expect(first.quantity.toString()).toBe('4');
    expect(first.acquiredAt?.toISOString().slice(0, 10)).toBe('2024-01-01');
    expect(first.costBasis.toString()).toBe('400');
    // Proceeds split pro-rata by quantity: 2400 total × 4/8.
    expect(first.proceeds?.toString()).toBe('1200');
    expect(first.gain?.toString()).toBe('800');
    expect(first.holdingDays).toBe(425);
    expect(first.outcome).toBe('realized');
    expect(first.basisQuality).toBe('known');

    expect(second.quantity.toString()).toBe('4');
    expect(second.acquiredAt?.toISOString().slice(0, 10)).toBe('2024-06-01');
    expect(second.costBasis.toString()).toBe('800');
    expect(second.proceeds?.toString()).toBe('1200');
    expect(second.gain?.toString()).toBe('400');
    expect(second.holdingDays).toBe(273);

    // The invariant. 2400 proceeds − 1200 basis = 1200 realized.
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
    expect(r.realizedPnl.toString()).toBe('1200');
  });

  test('a disposal with no acquisition record gets its own row, graded unknown', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '4',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'sell',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '200',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(ledger).toHaveLength(2);
    const matched = ledger[0] as DisposalLotMatch;
    const orphan = ledger[1] as DisposalLotMatch;

    expect(matched.quantity.toString()).toBe('4');
    expect(matched.acquiredAt).not.toBeNull();
    expect(matched.basisQuality).toBe('known');

    // The 6 units nothing acquired: reported with a blank basis and no date,
    // rather than folded into the matched row as free gain.
    expect(orphan.quantity.toString()).toBe('6');
    expect(orphan.acquiredAt).toBeNull();
    expect(orphan.holdingDays).toBeNull();
    expect(orphan.costBasis.toString()).toBe('0');
    expect(orphan.proceeds?.toString()).toBe('1200');
    expect(orphan.gain?.toString()).toBe('1200');
    // The grade is the point: this gain is the whole of its proceeds because
    // we have no acquisition, which is most often our own truncated import.
    expect(orphan.basisQuality).toBe('unknown');

    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('a swap_out whose counter has no price is valued from the held token, and says so (SC-397)', async () => {
    const svc = makeServiceWithSpot(BTC, '130');
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({ holdingId: 'h', kind: 'swap_out', quantity: '-10', occurredAt: '2024-02-01' }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(ledger).toHaveLength(1);
    const row = ledger[0] as DisposalLotMatch;
    expect(row.outcome).toBe('realized');
    expect(row.proceeds?.toString()).toBe('1300');
    expect(row.gain?.toString()).toBe('300');
    // The load-bearing half. The arithmetic above is right either way a
    // reader might guess it was produced, and the two guesses differ by up to
    // 2.44% on this ledger's own swaps — so the row names the price it used.
    expect(row.valuationBasis).toBe('held_token');
    expect(r.realizedPnl.toString()).toBe('300');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('a swap leg carrying a stale answer is not stamped unattributed (SC-402)', async () => {
    // The state, and it needs no migration to reach: an outflow answered
    // `left_control` while it was a `transfer_out` is re-imported and
    // recognised as a swap leg. `bulkUpsert` carries `kind` through
    // `ON CONFLICT` and deliberately does NOT carry `transfer_review`, so the
    // answer survives a change of the question it was given about.
    //
    // `transferReviewedAt: null` is the shape that made it visible — no stamp,
    // so `answerSourceOf` reads `unattributed` and the ledger rendered
    // "Recorded as having left your portfolio, so this gain was booked. There
    // is no record of anyone answering it." on a DEX swap.
    const svc = makeServiceWithSpot(BTC, '130');
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'swap_out',
          quantity: '-10',
          occurredAt: '2024-02-01',
          transferReview: 'left_control',
          transferReviewedAt: null,
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    const row = ledger[0] as DisposalLotMatch;
    // Not a cent moves. The gain was already booked on the kind — the sell
    // branch never read the answer — so this changes what the row SAYS and
    // nothing about what it is worth.
    expect(row.outcome).toBe('realized');
    expect(row.gain?.toString()).toBe('300');
    expect(r.realizedPnl.toString()).toBe('300');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());

    expect(row.answerSource).toBe('none');
  });

  test('a stamped answer on a swap leg is still not provenance for the swap (SC-402)', async () => {
    // The row SC-338's repair refuses to touch: a person really did answer it,
    // back when it was an answerable outflow. `user` on the ledger would be a
    // truer sentence than `unattributed` and still the wrong one — it would
    // attribute a swap's gain to a decision that did not produce it. The kind
    // gate is on the question, not on the quality of the answer.
    const svc = makeServiceWithSpot(BTC, '130');
    const ledger: DisposalLotMatch[] = [];
    await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'swap_out',
          quantity: '-10',
          occurredAt: '2024-02-01',
          transferReview: 'left_control',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect((ledger[0] as DisposalLotMatch).answerSource).toBe('none');
  });

  test('an answerable outflow still reports whose answer it rests on (SC-402)', async () => {
    // The gate must not be a blanket silence: `withdraw` is exactly the kind
    // the question IS asked about, and SC-324's whole point is that the row
    // books money on an answer nobody is recorded as giving.
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '130',
          transferReview: 'left_control',
          transferReviewedAt: null,
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect((ledger[0] as DisposalLotMatch).answerSource).toBe('unattributed');
  });

  test('a swap_out priced from its counter leg is marked execution_rate, not the fallback', async () => {
    const svc = makeServiceWithSpot(BTC, '130');
    const ledger: DisposalLotMatch[] = [];
    await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        // priceNative denominated in the base currency, so the execution rate
        // converts and is preferred: 10 × 140 rather than 10 × 130. The exact
        // rate from the venue beats a spot price we looked up, always.
        tx({
          holdingId: 'h',
          kind: 'swap_out',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '140',
          priceNativeTokenId: USD,
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    const row = ledger[0] as DisposalLotMatch;
    expect(row.proceeds?.toString()).toBe('1400');
    expect(row.valuationBasis).toBe('execution_rate');
  });

  test('an unpriceable swap_out reports null proceeds, never a zero', async () => {
    // Neither route resolves: no counter price AND no held token. This is the
    // residue SC-397 could not remove, and it is the one that still has to be
    // legible — `outcome` is what the ledger renders a sentence from.
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({ holdingId: 'h', kind: 'swap_out', quantity: '-10', occurredAt: '2024-02-01' }),
      ],
      USD,
      null,
      undefined,
      'complete',
      ledger
    );

    expect(ledger).toHaveLength(1);
    const row = ledger[0] as DisposalLotMatch;
    expect(row.outcome).toBe('unpriced');
    expect(row.proceeds).toBeNull();
    expect(row.gain).toBeNull();
    expect(row.valuationBasis).toBeNull();
    // Basis is known even when proceeds are not — shown, and never netted
    // against a figure that does not exist.
    expect(row.costBasis.toString()).toBe('1000');
    expect(r.realizedPnl.toString()).toBe('0');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('an unanswered withdrawal books nothing and says so (SC-150)', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '150',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(ledger).toHaveLength(1);
    const row = ledger[0] as DisposalLotMatch;
    // Before SC-150 this booked a 500 gain nobody made. The row exists so the
    // reader can see the lots left and the gain did not follow, and where the
    // answer lives.
    expect(row.outcome).toBe('unreviewed');
    expect(row.gain).toBeNull();
    expect(row.proceeds).toBeNull();
    expect(row.costBasis.toString()).toBe('1000');
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.transfersUnreviewed).toBe(1);
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('a left_control withdrawal realizes, tagged with its raw kind', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '150',
          transferReview: 'left_control',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(ledger).toHaveLength(1);
    const row = ledger[0] as DisposalLotMatch;
    expect(row.outcome).toBe('realized');
    // `withdraw`, not `sell`: an exit somebody confirmed is still not a stated
    // sale, and the ledger reports what the ledger recorded.
    expect(row.kind).toBe('withdraw');
    expect(row.gain?.toString()).toBe('500');
    expect(r.realizedPnl.toString()).toBe('500');
    expect(r.transfersUnreviewed).toBe(0);
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('an untracked withdrawal is answered, not queued', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'transfer_out',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '150',
          transferReview: 'untracked',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    // The same arithmetic as `unreviewed` and a different answer: the reader
    // said this is still their money, so nothing is owed and nothing is asked.
    expect((ledger[0] as DisposalLotMatch).outcome).toBe('retained');
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.transfersUnreviewed).toBe(0);
  });

  test('an unattributed left_control still realizes, and says so (SC-324)', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '150',
          transferReview: 'left_control',
          transferReviewedAt: null,
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    // The arithmetic is UNCHANGED and that is the assertion, not an oversight.
    // Making `isConfirmedDisposal` require the stamp would un-realize hundreds
    // of production rows at once and move the realized total by the full
    // amount; whether it should is SC-302, a question about what those rows
    // are. This
    // test exists so that change is a deliberate one — it must be edited to be
    // made, rather than merely not noticed.
    const row = ledger[0] as DisposalLotMatch;
    expect(row.outcome).toBe('realized');
    expect(row.gain?.toString()).toBe('500');
    expect(r.realizedPnl.toString()).toBe('500');

    // What DID change: the row no longer claims a person decided it.
    expect(row.answerSource).toBe('unattributed');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('answerSource separates an answer given from an answer recorded (SC-324)', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '30',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        // Answered in the queue, and provably the caller's — because the
        // SOURCE says so. This row carried only a timestamp until SC-673, and
        // "stamped" was read as "provably the caller's": true of every row when
        // the fixture was written, and false once rows could be stamped by
        // something that recorded no source.
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '150',
          transferReview: 'left_control',
          transferReviewSource: 'user',
        }),
        // Answered by something that left no trace of itself.
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-10',
          occurredAt: '2024-03-01',
          priceNative: '150',
          transferReview: 'untracked',
          transferReviewedAt: null,
        }),
        // Nobody answered anything: the question was never asked of a sale.
        tx({
          holdingId: 'h',
          kind: 'sell',
          quantity: '-10',
          occurredAt: '2024-04-01',
          priceNative: '150',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(ledger.map((row) => [row.outcome, row.answerSource])).toEqual([
      ['realized', 'user'],
      // `retained` from a value nobody is recorded as having chosen — the copy
      // above this row used to read "You said this never left your control".
      ['retained', 'unattributed'],
      ['realized', 'none'],
    ]);
  });

  test('a truncated history grades every row it produced as partial (SC-149)', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const history: HistoryCompleteness = 'incomplete';
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '4',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'sell',
          quantity: '-4',
          occurredAt: '2024-02-01',
          priceNative: '200',
        }),
      ],
      USD,
      BTC,
      undefined,
      history,
      ledger
    );

    // The figure is unchanged and the claim about it is not. A gain derived
    // from an import that reported itself truncated must not read as settled
    // wherever the lots are shown.
    expect((ledger[0] as DisposalLotMatch).basisQuality).toBe('partial');
    expect(r.basisQuality).toBe('partial');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('a swap_in whose counter has no price opens a priced lot, not a zero-cost one (SC-397)', async () => {
    // Production's live instance of this bug, and it is on the ACQUISITION
    // side: `swap_in SAND` on 2022-05-10 is denominated in MATIC, whose first
    // price row is 2023-10-25. The lot opened at zero, so the SAND sold two
    // minutes later booked its entire proceeds as gain.
    const svc = makeServiceWithSpot(BTC, '50');
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({ holdingId: 'h', kind: 'swap_in', quantity: '10', occurredAt: '2024-01-01' }),
        tx({
          holdingId: 'h',
          kind: 'sell',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '100',
          priceNativeTokenId: USD,
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    const row = ledger[0] as DisposalLotMatch;
    // Acquired at 10 × 50 = 500, sold for 1,000. Before SC-397 the basis was
    // 0 and the whole 1,000 read as gain — the acquisition was not free, we
    // just declined to price it.
    expect(row.costBasis.toString()).toBe('500');
    expect(row.gain?.toString()).toBe('500');
    expect(row.basisQuality).toBe('known');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });

  test('an inflow nothing could value grades its disposal partial, not known', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    // No priceNative and no held token, so neither route resolves and the
    // stub is never asked. Nothing values this inflow, so the lot opens at
    // zero cost — and the grade is what says the zero was a choice.
    const r = await svc.walkLots(
      undefined,
      [
        tx({ holdingId: 'h', kind: 'swap_in', quantity: '10', occurredAt: '2024-01-01' }),
        tx({
          holdingId: 'h',
          kind: 'sell',
          quantity: '-10',
          occurredAt: '2024-02-01',
          priceNative: '100',
        }),
      ],
      USD,
      null,
      undefined,
      'complete',
      ledger
    );

    const row = ledger[0] as DisposalLotMatch;
    expect(row.costBasis.toString()).toBe('0');
    expect(row.gain?.toString()).toBe('1000');
    // A zero basis we chose because we could not price the acquisition, not
    // because the acquisition was free. Same shape as the orphan row above.
    expect(row.basisQuality).toBe('partial');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());
  });
});

describe('walkComponent disposal ledger', () => {
  test('a linked transfer is not a disposal and does not restart the holding period', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const txs = [
      tx({
        holdingId: 'kraken',
        kind: 'buy',
        quantity: '10',
        occurredAt: '2023-01-01',
        priceNative: '100',
      }),
      tx({
        holdingId: 'kraken',
        kind: 'transfer_out',
        quantity: '-10',
        occurredAt: '2024-06-01',
        transferGroupId: 'g1',
      }),
      tx({
        holdingId: 'ledger',
        kind: 'transfer_in',
        quantity: '10',
        occurredAt: '2024-06-01',
        transferGroupId: 'g1',
      }),
      tx({
        holdingId: 'ledger',
        kind: 'sell',
        quantity: '-10',
        occurredAt: '2025-01-01',
        priceNative: '300',
      }),
    ];

    const result = await svc.walkComponent(
      undefined,
      ['kraken', 'ledger'],
      componentInputs(txs),
      new Date('2026-01-01'),
      USD,
      new Map([
        ['kraken', BTC],
        ['ledger', BTC],
      ]),
      undefined,
      new Map<string, HistoryCompleteness>([
        ['kraken', 'complete'],
        ['ledger', 'complete'],
      ]),
      ledger
    );

    // One row only — the sale. The transfer produced none, because a move
    // between the reader's own accounts is not an event.
    expect(ledger).toHaveLength(1);
    const row = ledger[0] as DisposalLotMatch;
    expect(row.kind).toBe('sell');
    expect(row.holdingId).toBe('ledger');
    // Acquisition date survived the transfer: bought Jan 2023, not moved Jun 2024.
    expect(row.acquiredAt?.toISOString().slice(0, 10)).toBe('2023-01-01');
    expect(row.costBasis.toString()).toBe('1000');
    expect(row.proceeds?.toString()).toBe('3000');
    expect(row.holdingDays).toBe(731);

    const scalar = [...result.values()].reduce((sum, c) => sum.add(c.realizedPnl), new Decimal(0));
    expect(gainTotal(ledger).toString()).toBe(scalar.toString());
  });

  test('a transfer_out whose pair never arrives books nothing and is not queued', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const txs = [
      tx({
        holdingId: 'kraken',
        kind: 'buy',
        quantity: '10',
        occurredAt: '2023-01-01',
        priceNative: '100',
      }),
      tx({
        holdingId: 'kraken',
        kind: 'transfer_out',
        quantity: '-10',
        occurredAt: '2024-06-01',
        priceNative: '250',
        transferGroupId: 'orphan',
      }),
      // A second holding shares the component so walkComponent is the right walker.
      tx({
        holdingId: 'ledger',
        kind: 'buy',
        quantity: '1',
        occurredAt: '2023-01-01',
        priceNative: '100',
      }),
      tx({
        holdingId: 'ledger',
        kind: 'transfer_out',
        quantity: '-1',
        occurredAt: '2023-02-01',
        transferGroupId: 'g2',
      }),
      tx({
        holdingId: 'kraken',
        kind: 'transfer_in',
        quantity: '1',
        occurredAt: '2023-02-01',
        transferGroupId: 'g2',
      }),
    ];

    const result = await svc.walkComponent(
      undefined,
      ['kraken', 'ledger'],
      componentInputs(txs),
      new Date('2026-01-01'),
      USD,
      new Map([
        ['kraken', BTC],
        ['ledger', BTC],
      ]),
      undefined,
      new Map<string, HistoryCompleteness>([
        ['kraken', 'complete'],
        ['ledger', 'complete'],
      ]),
      ledger
    );

    expect(ledger).toHaveLength(1);
    const row = ledger[0] as DisposalLotMatch;
    expect(row.kind).toBe('transfer_out');
    expect(row.holdingId).toBe('kraken');
    // A group id with one leg is no more evidence of a sale than no group id
    // at all — it is evidence of an import that fetched one side. Nothing is
    // realized, and it is distinct from `unreviewed` because the review queue
    // does not hold it: there is nothing here a reader could go and answer.
    expect(row.outcome).toBe('awaiting_pair');
    expect(row.gain).toBeNull();
    expect(row.costBasis.toString()).toBe('1000');

    const scalar = [...result.values()].reduce((sum, c) => sum.add(c.realizedPnl), new Decimal(0));
    expect(scalar.toString()).toBe('0');
    expect(gainTotal(ledger).toString()).toBe(scalar.toString());
    expect(result.get('kraken')?.transfersUnreviewed).toBe(0);
  });

  test('two linked outflows in one group do not pool their lots (SC-90)', async () => {
    // Found by the generated property in `CostBasisWalkerAgreement.test.ts`,
    // not by anyone reading the code. The group's buffered-lot bucket used to
    // BE the first outflow's own popped-lot array rather than a copy, so the
    // second outflow appending to the bucket also appended to the first
    // outflow's cost basis. The answered leg then booked six units of cost
    // against three units of proceeds — realized 240 became -60 — and the
    // ledger emitted the leg twice, once per lot now sitting in the array,
    // each row taking the whole proceeds because `recordDisposal` divides by
    // the transaction's quantity and not by what the slices happen to sum to.
    //
    // Both walkers folded the same private walk, so both were wrong in
    // exactly the same way and agreed with each other throughout. Production
    // carries no group with two outflow legs today, so no figure ever shown
    // was affected; this pins the arithmetic before one appears.
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const txs = [
      tx({
        holdingId: 'kraken',
        kind: 'buy',
        quantity: '10',
        occurredAt: '2023-01-01',
        priceNative: '100',
      }),
      tx({
        holdingId: 'kraken',
        kind: 'transfer_out',
        quantity: '-3',
        occurredAt: '2024-01-01',
        priceNative: '180',
        transferGroupId: 'g-multi',
        transferReview: 'left_control',
      }),
      tx({
        holdingId: 'kraken',
        kind: 'transfer_out',
        quantity: '-3',
        occurredAt: '2024-02-01',
        transferGroupId: 'g-multi',
      }),
      // A second holding so walkComponent is genuinely the walker under test.
      tx({
        holdingId: 'ledger',
        kind: 'buy',
        quantity: '1',
        occurredAt: '2023-01-01',
        priceNative: '100',
      }),
    ];

    const result = await svc.walkComponent(
      undefined,
      ['kraken', 'ledger'],
      componentInputs(txs),
      new Date('2026-01-01'),
      USD,
      new Map([
        ['kraken', BTC],
        ['ledger', BTC],
      ]),
      undefined,
      new Map<string, HistoryCompleteness>([
        ['kraken', 'complete'],
        ['ledger', 'complete'],
      ]),
      ledger
    );

    // One row per leg. Two rows for the answered leg is the duplicate.
    expect(ledger).toHaveLength(2);

    const answered = ledger.filter((r) => r.outcome === 'realized');
    expect(answered).toHaveLength(1);
    // Its own three units at 100, not its own three plus its neighbour's.
    expect((answered[0] as DisposalLotMatch).costBasis.toString()).toBe('300');
    expect((answered[0] as DisposalLotMatch).proceeds?.toString()).toBe('540');
    expect((answered[0] as DisposalLotMatch).gain?.toString()).toBe('240');

    const unpaired = ledger.filter((r) => r.outcome === 'awaiting_pair');
    expect(unpaired).toHaveLength(1);
    expect((unpaired[0] as DisposalLotMatch).gain).toBeNull();
    expect((unpaired[0] as DisposalLotMatch).costBasis.toString()).toBe('300');

    const scalar = [...result.values()].reduce((sum, c) => sum.add(c.realizedPnl), new Decimal(0));
    expect(scalar.toString()).toBe('240');
    expect(gainTotal(ledger).toString()).toBe(scalar.toString());
    // Four of ten units left the holding; the rest keeps its cost intact.
    expect(result.get('kraken')?.costBasis.toString()).toBe('400');
  });

  test('a sale spanning lots from two accounts splits into one row per lot', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const txs = [
      tx({
        holdingId: 'a',
        kind: 'buy',
        quantity: '5',
        occurredAt: '2023-01-01',
        priceNative: '100',
      }),
      tx({
        holdingId: 'b',
        kind: 'buy',
        quantity: '5',
        occurredAt: '2023-06-01',
        priceNative: '200',
      }),
      tx({
        holdingId: 'b',
        kind: 'transfer_out',
        quantity: '-5',
        occurredAt: '2024-01-01',
        transferGroupId: 'g',
      }),
      tx({
        holdingId: 'a',
        kind: 'transfer_in',
        quantity: '5',
        occurredAt: '2024-01-01',
        transferGroupId: 'g',
      }),
      tx({
        holdingId: 'a',
        kind: 'sell',
        quantity: '-10',
        occurredAt: '2024-07-01',
        priceNative: '400',
      }),
    ];

    const result = await svc.walkComponent(
      undefined,
      ['a', 'b'],
      componentInputs(txs),
      new Date('2026-01-01'),
      USD,
      new Map([
        ['a', BTC],
        ['b', BTC],
      ]),
      undefined,
      new Map<string, HistoryCompleteness>([
        ['a', 'complete'],
        ['b', 'complete'],
      ]),
      ledger
    );

    expect(ledger).toHaveLength(2);
    expect(ledger.map((d) => d.acquiredAt?.toISOString().slice(0, 10))).toEqual([
      '2023-01-01',
      '2023-06-01',
    ]);
    expect(ledger.map((d) => d.costBasis.toString())).toEqual(['500', '1000']);
    expect(ledger.map((d) => d.proceeds?.toString())).toEqual(['2000', '2000']);

    const scalar = [...result.values()].reduce((sum, c) => sum.add(c.realizedPnl), new Decimal(0));
    expect(gainTotal(ledger).toString()).toBe(scalar.toString());
    expect(scalar.toString()).toBe('2500');
  });

  test('an unanswered exit out of a component is graded against its own holding', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const txs = [
      // `kraken` is the truncated one. `ledger` is complete, and its own sale
      // must not inherit kraken's doubt just because a transfer connects them.
      tx({
        holdingId: 'kraken',
        kind: 'buy',
        quantity: '10',
        occurredAt: '2023-01-01',
        priceNative: '100',
      }),
      tx({ holdingId: 'kraken', kind: 'withdraw', quantity: '-4', occurredAt: '2024-03-01' }),
      tx({
        holdingId: 'kraken',
        kind: 'transfer_out',
        quantity: '-6',
        occurredAt: '2024-06-01',
        transferGroupId: 'g1',
      }),
      tx({
        holdingId: 'ledger',
        kind: 'transfer_in',
        quantity: '6',
        occurredAt: '2024-06-01',
        transferGroupId: 'g1',
      }),
      tx({
        holdingId: 'ledger',
        kind: 'sell',
        quantity: '-6',
        occurredAt: '2025-01-01',
        priceNative: '300',
      }),
    ];

    const result = await svc.walkComponent(
      undefined,
      ['kraken', 'ledger'],
      componentInputs(txs),
      new Date('2026-01-01'),
      USD,
      new Map([
        ['kraken', BTC],
        ['ledger', BTC],
      ]),
      undefined,
      new Map<string, HistoryCompleteness>([
        ['kraken', 'incomplete'],
        ['ledger', 'complete'],
      ]),
      ledger
    );

    const unanswered = ledger.find((d) => d.holdingId === 'kraken') as DisposalLotMatch;
    const sale = ledger.find((d) => d.holdingId === 'ledger') as DisposalLotMatch;

    expect(unanswered.outcome).toBe('unreviewed');
    expect(unanswered.basisQuality).toBe('partial');
    // The sale happened out of a holding whose own history is complete, and
    // the lot carried its cost across intact. Grading it against kraken's
    // truncation would put a caveat on a figure that does not rest on it.
    expect(sale.outcome).toBe('realized');
    expect(sale.basisQuality).toBe('known');
    expect(result.get('kraken')?.transfersUnreviewed).toBe(1);

    const scalar = [...result.values()].reduce((sum, c) => sum.add(c.realizedPnl), new Decimal(0));
    expect(gainTotal(ledger).toString()).toBe(scalar.toString());
  });
});

/**
 * An answer that applies to PART of an outflow (SC-181).
 *
 * The reported case: a 4,000 withdrawal of which 3,500 moved to an untracked
 * account and 500 genuinely left. Before this, `left_control` realized all
 * 4,000 (overstating by 3,500) and `untracked` realized nothing (understating
 * by 500) — the same one-directional-error family as SC-149/150/151/166,
 * arriving through the answer model rather than the data.
 *
 * The load-bearing assertions are the same two as everywhere in this file: the
 * lots popped for one transaction still sum to its quantity, and the per-row
 * gains still sum to the scalar the walk accumulates.
 */
describe('a divided answer', () => {
  // A `paired` part carries its deposit's id — `transferReviewSplitSchema`
  // refuses one without it, and a split the walk cannot parse is treated as
  // unanswered rather than as settled. So a fixture that omits it is not
  // testing a paired share; it is testing the fallback.
  const MATCH_ID = '11111111-2222-4333-8444-555555555555';

  const SPLIT_3500_500 = [
    { decision: 'untracked', quantity: '3500' },
    { decision: 'left_control', quantity: '500' },
  ];

  test('realizes only the disposed share, against the lots that share consumed', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'deposit',
          quantity: '4000',
          occurredAt: '2024-01-01',
          priceNative: '1',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-4000',
          occurredAt: '2025-01-01',
          priceNative: '2',
          transferReview: 'split',
          transferReviewSplit: SPLIT_3500_500,
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    // 500 realized at 2 = 1000 proceeds, against 500 of basis at 1.
    expect(r.realizedPnl.toString()).toBe('500');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());

    expect(ledger).toHaveLength(2);
    const [untracked, disposed] = ledger as [DisposalLotMatch, DisposalLotMatch];
    expect(untracked.quantity.toString()).toBe('3500');
    expect(untracked.outcome).toBe('retained');
    expect(untracked.gain).toBeNull();
    expect(untracked.portionIndex).toBe(0);
    expect(untracked.portionCount).toBe(2);

    expect(disposed.quantity.toString()).toBe('500');
    expect(disposed.outcome).toBe('realized');
    expect(disposed.proceeds?.toString()).toBe('1000');
    expect(disposed.costBasis.toString()).toBe('500');
    expect(disposed.gain?.toString()).toBe('500');
    expect(disposed.portionIndex).toBe(1);
    expect(disposed.portionCount).toBe(2);

    // The whole 4,000 left the holding either way — the shares divide what
    // happened to it, not whether it went.
    expect(r.openQty.toString()).toBe('0');
  });

  test('is bounded by the two whole answers it sits between', async () => {
    const history = (review: string, split?: unknown) => [
      tx({
        holdingId: 'h',
        kind: 'deposit',
        quantity: '4000',
        occurredAt: '2024-01-01',
        priceNative: '1',
      }),
      tx({
        holdingId: 'h',
        kind: 'withdraw',
        quantity: '-4000',
        occurredAt: '2025-01-01',
        priceNative: '2',
        transferReview: review,
        ...(split ? { transferReviewSplit: split } : {}),
      }),
    ];

    const whole = await makeService().walkLots(undefined, history('left_control'), USD, BTC);
    const none = await makeService().walkLots(undefined, history('untracked'), USD, BTC);
    const split = await makeService().walkLots(
      undefined,
      history('split', SPLIT_3500_500),
      USD,
      BTC
    );

    expect(whole.realizedPnl.toString()).toBe('4000');
    expect(none.realizedPnl.toString()).toBe('0');
    // Strictly between the two wrong answers, which is the whole point.
    expect(split.realizedPnl.toString()).toBe('500');
  });

  test('walks three shares, and each pops the lots FIFO in the order written', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '600',
          occurredAt: '2024-01-01',
          priceNative: '1',
        }),
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '400',
          occurredAt: '2024-06-01',
          priceNative: '3',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-1000',
          occurredAt: '2025-01-01',
          priceNative: '5',
          transferReview: 'split',
          transferReviewSplit: [
            { decision: 'untracked', quantity: '500' },
            { decision: 'left_control', quantity: '300' },
            { decision: 'paired', quantity: '200', matchTransactionId: MATCH_ID },
          ],
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    // The untracked 500 takes the January lot's first 500 at cost 1. The
    // disposed 300 then takes January's remaining 100 (cost 100) and 200 of
    // June (cost 600) — 700 of basis against 1500 of proceeds.
    expect(r.realizedPnl.toString()).toBe('800');
    expect(gainTotal(ledger).toString()).toBe(r.realizedPnl.toString());

    const byPortion: Record<number, DisposalLotMatch[]> = {};
    for (const row of ledger) {
      const bucket = byPortion[row.portionIndex] ?? [];
      bucket.push(row);
      byPortion[row.portionIndex] = bucket;
    }
    expect(Object.keys(byPortion)).toEqual(['0', '1', '2']);
    expect(byPortion[0]?.every((row) => row.outcome === 'retained')).toBe(true);
    expect(byPortion[1]?.every((row) => row.outcome === 'realized')).toBe(true);
    expect(ledger.every((row) => row.portionCount === 3)).toBe(true);

    // Every share's lots sum back to the share, and the shares to the row.
    const walked = ledger.reduce((sum, row) => sum.add(row.quantity), new Decimal(0));
    expect(walked.toString()).toBe('1000');
  });

  test('a paired share carries its lots across and the rest is answered here', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const group = 'grp-split';
    const txs = [
      tx({
        holdingId: 'src',
        kind: 'buy',
        quantity: '4000',
        occurredAt: '2024-01-01',
        priceNative: '1',
      }),
      tx({
        holdingId: 'src',
        kind: 'withdraw',
        quantity: '-4000',
        occurredAt: '2025-01-01',
        priceNative: '2',
        transferGroupId: group,
        transferReview: 'split',
        transferReviewSplit: [
          { decision: 'paired', quantity: '3500', matchTransactionId: MATCH_ID },
          { decision: 'left_control', quantity: '500' },
        ],
      }),
      tx({
        holdingId: 'dst',
        kind: 'transfer_in',
        quantity: '3500',
        occurredAt: '2025-01-01',
        transferGroupId: group,
      }),
    ];

    const out = await svc.walkComponent(
      undefined,
      ['src', 'dst'],
      componentInputs(txs),
      new Date('2025-06-01'),
      USD,
      new Map([
        ['src', BTC],
        ['dst', BTC],
      ]),
      undefined,
      new Map(),
      ledger
    );

    // The destination inherits the 3,500 at its ORIGINAL cost of 1 — not
    // re-opened at the market value of 2, which is what an unsplit answer of
    // `left_control` would have implied for all 4,000.
    const dst = out.get('dst');
    expect(dst?.openQty.toString()).toBe('3500');
    expect(dst?.costBasis.toString()).toBe('3500');

    // Only the 500 that left books a gain: 1000 proceeds − 500 basis.
    const src = out.get('src');
    expect(src?.realizedPnl.toString()).toBe('500');
    expect(gainTotal(ledger).toString()).toBe('500');

    // The carried share is deliberately absent from the ledger — it is not a
    // disposal and never was one.
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.quantity.toString()).toBe('500');
    expect(ledger[0]?.outcome).toBe('realized');
    expect(ledger[0]?.portionCount).toBe(2);
  });

  test('a paired share whose partner never arrives books nothing and says why', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const txs = [
      tx({
        holdingId: 'src',
        kind: 'buy',
        quantity: '4000',
        occurredAt: '2024-01-01',
        priceNative: '1',
      }),
      tx({
        holdingId: 'src',
        kind: 'withdraw',
        quantity: '-4000',
        occurredAt: '2025-01-01',
        priceNative: '2',
        transferGroupId: 'grp-orphan',
        transferReview: 'split',
        transferReviewSplit: [
          { decision: 'paired', quantity: '3500', matchTransactionId: MATCH_ID },
          { decision: 'untracked', quantity: '500' },
        ],
      }),
    ];

    const out = await svc.walkComponent(
      undefined,
      ['src'],
      componentInputs(txs),
      new Date('2025-06-01'),
      USD,
      new Map([['src', BTC]]),
      undefined,
      new Map(),
      ledger
    );

    expect(out.get('src')?.realizedPnl.toString()).toBe('0');
    expect(ledger.map((row) => row.outcome).sort()).toEqual(['awaiting_pair', 'retained']);
    expect(gainTotal(ledger).toString()).toBe('0');
  });

  test('parts that no longer cover the row leave the remainder unanswered', async () => {
    // A re-import can correct a quantity after the answer was written; the
    // transaction stays the authority on how much left. The walk must never
    // pop more or less than the row, and drift shows as an open question
    // rather than being repaired into a number nobody chose.
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '5000',
          occurredAt: '2024-01-01',
          priceNative: '1',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-5000',
          occurredAt: '2025-01-01',
          priceNative: '2',
          transferReview: 'split',
          transferReviewSplit: SPLIT_3500_500,
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    const walked = ledger.reduce((sum, row) => sum.add(row.quantity), new Decimal(0));
    expect(walked.toString()).toBe('5000');
    expect(r.openQty.toString()).toBe('0');
    expect(ledger.at(-1)?.quantity.toString()).toBe('1000');
    expect(ledger.at(-1)?.outcome).toBe('unreviewed');
    expect(ledger.every((row) => row.portionCount === 3)).toBe(true);
  });

  test('a division that will not parse is an open question, not a settled one', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '100',
          occurredAt: '2024-01-01',
          priceNative: '1',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-100',
          occurredAt: '2025-01-01',
          priceNative: '2',
          transferReview: 'split',
          transferReviewSplit: { nonsense: true },
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(r.realizedPnl.toString()).toBe('0');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.outcome).toBe('unreviewed');
  });

  test('an undivided outflow is unchanged — one share, one row, index 0 of 1', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        tx({
          holdingId: 'h',
          kind: 'buy',
          quantity: '10',
          occurredAt: '2024-01-01',
          priceNative: '100',
        }),
        tx({
          holdingId: 'h',
          kind: 'withdraw',
          quantity: '-10',
          occurredAt: '2025-01-01',
          priceNative: '150',
          transferReview: 'left_control',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    expect(r.realizedPnl.toString()).toBe('500');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.portionIndex).toBe(0);
    expect(ledger[0]?.portionCount).toBe(1);
  });
});

/**
 * The fourth answer, in the walk (SC-187).
 *
 * `internal` is `paired` reached the other way: the destination is a holding
 * nobody imports for, so the counterpart deposit does not exist and
 * `TransferReviewService` writes it. By the time the walk sees it there is
 * nothing left to distinguish the two — one `transfer_group_id`, one
 * `transfer_in` carrying it — which is exactly the property these tests are
 * here to pin down. If a future change gives `internal` its own branch, the
 * `carry` assertions below are what should stop it.
 */
describe('a share moved to a holding Scani tracks', () => {
  const DESTINATION = {
    accountId: '11111111-2222-4333-8444-555555555555',
    holdingId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  };

  test('carries its lots across at original cost, exactly as a paired share does', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const group = 'grp-internal';
    const txs = [
      tx({
        holdingId: 'src',
        kind: 'buy',
        quantity: '4000',
        occurredAt: '2024-01-01',
        priceNative: '1',
      }),
      tx({
        holdingId: 'src',
        kind: 'withdraw',
        quantity: '-4000',
        occurredAt: '2025-01-01',
        priceNative: '2',
        transferGroupId: group,
        transferReview: 'split',
        transferReviewSplit: [
          { decision: 'internal', quantity: '3500', destination: DESTINATION },
          { decision: 'left_control', quantity: '500' },
        ],
      }),
      // The row `resolveSplit` writes: same group id, the PORTION's quantity.
      tx({
        holdingId: 'dst',
        kind: 'transfer_in',
        quantity: '3500',
        occurredAt: '2025-01-01',
        transferGroupId: group,
      }),
    ];

    const out = await svc.walkComponent(
      undefined,
      ['src', 'dst'],
      componentInputs(txs),
      new Date('2025-06-01'),
      USD,
      new Map([
        ['src', BTC],
        ['dst', BTC],
      ]),
      undefined,
      new Map(),
      ledger
    );

    // Original cost of 1, not the market value of 2. This is the whole point:
    // answering `left_control` on the row would have booked 4,000 of proceeds
    // against 4,000 of basis at a price the money never fetched.
    const dst = out.get('dst');
    expect(dst?.openQty.toString()).toBe('3500');
    expect(dst?.costBasis.toString()).toBe('3500');

    expect(out.get('src')?.realizedPnl.toString()).toBe('500');
    expect(gainTotal(ledger).toString()).toBe('500');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.quantity.toString()).toBe('500');
  });

  test('works when the destination is a second holding in the SAME account', async () => {
    // Production shape: one Airwallex account, two USD holdings, and money
    // moved between them. Nothing in the component walk cares that both legs
    // share an account — the ledger is keyed on holdings — and this is here so
    // that stays true.
    const svc = makeService();
    const group = 'grp-same-account';
    const txs = [
      tx({
        holdingId: 'airwallex-manual',
        kind: 'buy',
        quantity: '700',
        occurredAt: '2024-01-01',
        priceNative: '1',
      }),
      tx({
        holdingId: 'airwallex-manual',
        kind: 'withdraw',
        quantity: '-700',
        occurredAt: '2025-01-01',
        priceNative: '3',
        transferGroupId: group,
        transferReview: 'internal',
      }),
      tx({
        holdingId: 'airwallex-imported',
        kind: 'transfer_in',
        quantity: '700',
        occurredAt: '2025-01-01',
        transferGroupId: group,
      }),
    ];

    const out = await svc.walkComponent(
      undefined,
      ['airwallex-manual', 'airwallex-imported'],
      componentInputs(txs),
      new Date('2025-06-01'),
      USD,
      new Map([
        ['airwallex-manual', BTC],
        ['airwallex-imported', BTC],
      ]),
      undefined,
      new Map(),
      []
    );

    expect(out.get('airwallex-manual')?.openQty.toString()).toBe('0');
    expect(out.get('airwallex-manual')?.realizedPnl.toString()).toBe('0');
    expect(out.get('airwallex-imported')?.openQty.toString()).toBe('700');
    expect(out.get('airwallex-imported')?.costBasis.toString()).toBe('700');
  });

  test('books nothing when its written deposit is missing, rather than a gain', async () => {
    // The deposit is written inside the same transaction as the answer, so
    // this should not happen — but "should not happen" is how the invented
    // gain got in the first time. A half-linked move is an open question, not
    // a disposal.
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const txs = [
      tx({
        holdingId: 'src',
        kind: 'buy',
        quantity: '4000',
        occurredAt: '2024-01-01',
        priceNative: '1',
      }),
      tx({
        holdingId: 'src',
        kind: 'withdraw',
        quantity: '-4000',
        occurredAt: '2025-01-01',
        priceNative: '2',
        transferGroupId: 'grp-internal-orphan',
        transferReview: 'internal',
      }),
    ];

    const out = await svc.walkComponent(
      undefined,
      ['src'],
      componentInputs(txs),
      new Date('2025-06-01'),
      USD,
      new Map([['src', BTC]]),
      undefined,
      new Map(),
      ledger
    );

    expect(out.get('src')?.realizedPnl.toString()).toBe('0');
    expect(ledger.map((row) => row.outcome)).toEqual(['awaiting_pair']);
  });
});
