import type { HoldingTransaction } from '@scani/db/schema';
import { TRANSFER_REVIEW_SPLIT, type TransferReviewSplit } from '@scani/shared';
import Decimal from 'decimal.js';
import type {
  CostBasisAtTime,
  CostBasisMethod,
  CostBasisService,
  DisposalLotMatch,
} from '../../../../src/services/pricing/CostBasisService';

/**
 * A ledger that exercises every branch the fee change could reach — buys,
 * sells, a same-day and a 30-day repurchase, an unpriced deposit, a sale
 * priced in a non-base currency, a swap priced in its counter asset, a linked
 * transfer, a split withdrawal with a realized share and a fee share, and an
 * unanswered withdrawal — and carries NO trade fee anywhere (SC-1142).
 *
 * `zero-fee-golden.json` beside it is what this ledger produced on `main` at
 * b063ad2ee, BEFORE fees reached the walk. The test asserting the two are
 * equal is the proof that adding fees changed fees and nothing else: an
 * arithmetic test that a fee moves a figure by exactly the fee is compatible
 * with having moved every other figure too.
 */

export const USD = 'token-USD';
export const EUR = 'token-EUR';
export const BTC = 'token-BTC';
export const ETH = 'token-ETH';
export const BNB = 'token-BNB';
/** A token the price graph has no route for. */
export const OBSCURE = 'token-OBSCURE';

/** Spot rates to USD the price-graph stub answers with. */
export const RATES_TO_USD: Readonly<Record<string, string>> = {
  [BTC]: '110',
  [EUR]: '1.1',
  [ETH]: '2',
  [BNB]: '300',
};

export const HELD_TOKENS: ReadonlyMap<string, string> = new Map([
  ['A', BTC],
  ['B', BTC],
  ['C', BNB],
]);

export const FUTURE = new Date('2030-01-01T00:00:00Z');

export interface LedgerRow {
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  priceNative?: string;
  priceNativeTokenId?: string;
  feeQuantity?: string;
  feeTokenId?: string;
  transferGroupId?: string;
  transferReview?: string;
  transferReviewSplit?: TransferReviewSplit;
}

export function row(id: string, p: LedgerRow): HoldingTransaction {
  return {
    id,
    userId: 'u',
    holdingId: p.holdingId,
    tokenId: HELD_TOKENS.get(p.holdingId) ?? BTC,
    kind: p.kind,
    quantity: p.quantity,
    priceNative: p.priceNative ?? null,
    priceNativeTokenId: p.priceNative ? (p.priceNativeTokenId ?? USD) : null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: p.feeQuantity ?? null,
    feeTokenId: p.feeTokenId ?? null,
    occurredAt: new Date(p.occurredAt),
    externalId: `ext-${id}`,
    swapGroupId: null,
    transferGroupId: p.transferGroupId ?? null,
    transferReview: p.transferReview ?? null,
    transferReviewSplit: p.transferReviewSplit ?? null,
    transferReviewedAt: p.transferReview ? new Date('2024-12-01T00:00:00Z') : null,
    transferReviewSource: p.transferReview ? 'user' : null,
    transferReviewRuleId: null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date('2024-12-01T00:00:00Z'),
    updatedAt: new Date('2024-12-01T00:00:00Z'),
  } as unknown as HoldingTransaction;
}

const LEDGER: ReadonlyArray<[string, LedgerRow]> = [
  [
    'a01',
    {
      holdingId: 'A',
      kind: 'buy',
      quantity: '10',
      occurredAt: '2024-01-01T10:00:00Z',
      priceNative: '100',
    },
  ],
  [
    'a02',
    {
      holdingId: 'A',
      kind: 'buy',
      quantity: '5',
      occurredAt: '2024-01-10T10:00:00Z',
      priceNative: '120',
    },
  ],
  // No price recorded: valued from the held token's spot rate.
  ['a03', { holdingId: 'A', kind: 'deposit', quantity: '2', occurredAt: '2024-01-15T10:00:00Z' }],
  [
    'a04',
    {
      holdingId: 'A',
      kind: 'sell',
      quantity: '-4',
      occurredAt: '2024-02-01T10:00:00Z',
      priceNative: '150',
    },
  ],
  // Same tax day as a04 — Section 104's same-day rule claims it.
  [
    'a05',
    {
      holdingId: 'A',
      kind: 'buy',
      quantity: '3',
      occurredAt: '2024-02-01T15:00:00Z',
      priceNative: '140',
    },
  ],
  [
    'a06',
    {
      holdingId: 'A',
      kind: 'sell',
      quantity: '-2',
      occurredAt: '2024-03-01T10:00:00Z',
      priceNative: '160',
    },
  ],
  // Fourteen days after a06 — the bed-and-breakfast rule claims it.
  [
    'a07',
    {
      holdingId: 'A',
      kind: 'buy',
      quantity: '1',
      occurredAt: '2024-03-15T10:00:00Z',
      priceNative: '130',
    },
  ],
  [
    'a08',
    {
      holdingId: 'A',
      kind: 'transfer_out',
      quantity: '-5',
      occurredAt: '2024-04-01T10:00:00Z',
      transferGroupId: 'g1',
    },
  ],
  [
    'b01',
    {
      holdingId: 'B',
      kind: 'transfer_in',
      quantity: '4.9',
      occurredAt: '2024-04-01T10:00:00Z',
      transferGroupId: 'g1',
    },
  ],
  // Priced in EUR: the execution rate converts to base through the graph.
  [
    'b02',
    {
      holdingId: 'B',
      kind: 'sell',
      quantity: '-2',
      occurredAt: '2024-05-01T10:00:00Z',
      priceNative: '180',
      priceNativeTokenId: EUR,
    },
  ],
  [
    'a09',
    {
      holdingId: 'A',
      kind: 'withdraw',
      quantity: '-3',
      occurredAt: '2024-06-01T10:00:00Z',
      priceNative: '170',
      transferReview: TRANSFER_REVIEW_SPLIT,
      transferReviewSplit: [
        { decision: 'left_control', quantity: '2' },
        { decision: 'fee', quantity: '1' },
      ],
    },
  ],
  ['a10', { holdingId: 'A', kind: 'withdraw', quantity: '-1', occurredAt: '2024-06-05T10:00:00Z' }],
  // A swap priced in its counter asset, ETH.
  [
    'a11',
    {
      holdingId: 'A',
      kind: 'swap_out',
      quantity: '-1',
      occurredAt: '2024-07-01T10:00:00Z',
      priceNative: '60',
      priceNativeTokenId: ETH,
    },
  ],
  [
    'a12',
    {
      holdingId: 'A',
      kind: 'swap_in',
      quantity: '0.5',
      occurredAt: '2024-07-02T10:00:00Z',
      priceNative: '75',
      priceNativeTokenId: ETH,
    },
  ],
];

/**
 * The ledger's rows, each passed through `patch` — the identity by default.
 * The fee tests hand in a patch that attaches a fee to one row; the control
 * hands in one that attaches a ZERO fee to every row.
 */
export function ledger(
  patch: (id: string, p: LedgerRow) => LedgerRow = (_id, p) => p
): HoldingTransaction[] {
  return LEDGER.map(([id, p]) => row(id, patch(id, p)));
}

export function byHolding(rows: HoldingTransaction[]): Map<string, HoldingTransaction[]> {
  const out = new Map<string, HoldingTransaction[]>();
  for (const r of rows) {
    const list = out.get(r.holdingId);
    if (list) list.push(r);
    else out.set(r.holdingId, [r]);
  }
  return out;
}

/** Every figure a walk produces, flattened to strings so equality is exact. */
function serializeBasis(r: CostBasisAtTime | undefined): unknown {
  if (!r) return null;
  return {
    openQty: r.openQty.toString(),
    costBasis: r.costBasis.toString(),
    realizedPnl: r.realizedPnl.toString(),
    lots: r.lots.map((l) => ({
      qty: l.qty.toString(),
      cost: l.cost.toString(),
      date: l.date.toISOString(),
      stale: l.stale ?? null,
      unpriced: l.unpriced ?? null,
    })),
    hasTransactions: r.hasTransactions,
    basisQuality: r.basisQuality,
    transfersUnreviewed: r.transfersUnreviewed,
  };
}

function serializeLedger(rows: DisposalLotMatch[]): unknown {
  return rows.map((m) => ({
    transactionId: m.transactionId,
    holdingId: m.holdingId,
    kind: m.kind,
    disposedAt: m.disposedAt.toISOString(),
    acquiredAt: m.acquiredAt?.toISOString() ?? null,
    quantity: m.quantity.toString(),
    proceeds: m.proceeds?.toString() ?? null,
    costBasis: m.costBasis.toString(),
    gain: m.gain?.toString() ?? null,
    holdingDays: m.holdingDays,
    portionIndex: m.portionIndex,
    portionCount: m.portionCount,
    basisQuality: m.basisQuality,
    outcome: m.outcome,
    valuationBasis: m.valuationBasis,
    answerSource: m.answerSource,
  }));
}

/**
 * Both entry points under both regimes: `walkLots` over holding A alone (its
 * transfer's partner absent) and `walkComponent` over A and B together.
 */
export async function walkEverything(
  svc: CostBasisService,
  rows: HoldingTransaction[]
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const methods: CostBasisMethod[] = ['fifo', 'uk_section_104'];
  for (const method of methods) {
    const aOnly = rows.filter((r) => r.holdingId === 'A');
    const singleLedger: DisposalLotMatch[] = [];
    const single = await svc.walkLots(
      undefined,
      aOnly,
      USD,
      BTC,
      undefined,
      'complete',
      singleLedger,
      method
    );
    const componentLedger: DisposalLotMatch[] = [];
    const component = await svc.walkComponent(
      undefined,
      ['A', 'B'],
      byHolding(rows),
      FUTURE,
      USD,
      HELD_TOKENS,
      undefined,
      new Map([
        ['A', 'complete'],
        ['B', 'complete'],
      ]),
      componentLedger,
      method
    );
    out[method] = {
      walkLots: { A: serializeBasis(single), ledger: serializeLedger(singleLedger) },
      walkComponent: {
        A: serializeBasis(component.get('A')),
        B: serializeBasis(component.get('B')),
        ledger: serializeLedger(componentLedger),
      },
    };
  }
  return out;
}

/** The price-graph stub: a fixed spot rate per token, never stale. */
export const priceGraphStub = {
  convert: async (amount: Decimal | string, from: string, to: string) => {
    const amt = new Decimal(amount);
    if (from === to) return { amount: amt, stale: false };
    if (to !== USD) return null;
    const rate = RATES_TO_USD[from];
    return rate === undefined ? null : { amount: amt.mul(rate), stale: false };
  },
};
