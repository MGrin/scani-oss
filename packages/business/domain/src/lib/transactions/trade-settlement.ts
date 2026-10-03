import type { NewHoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import {
  GROSS_OF_OWN_FEE_SOURCES,
  SETTLEMENT_DERIVED_SOURCES,
} from '../../services/transactions/transaction-sources';

type SettlementTrade = Pick<
  NewHoldingTransaction,
  | 'kind'
  | 'tokenId'
  | 'counterQuantity'
  | 'counterTokenId'
  | 'feeQuantity'
  | 'feeTokenId'
  | 'externalId'
  | 'source'
>;

export interface SettlementLeg {
  tokenId: string;
  kind: 'settle_in' | 'settle_out' | 'fee';
  quantity: string;
  externalId: string;
}

type MirrorableTrade = Pick<
  NewHoldingTransaction,
  'tokenId' | 'quantity' | 'counterTokenId' | 'counterQuantity' | 'occurredAt' | 'source'
>;

const TRADE_KINDS: ReadonlySet<string> = new Set(['buy', 'sell']);

/** The `source_metadata` a settlement leg carries: its trade's external id. */
export function settlementMetadata(tradeExternalId: string): { settles: string } {
  return { settles: tradeExternalId };
}

/**
 * The ledger row a leg becomes. It carries no counter, price or fee: the
 * settlement is worth exactly its own quantity of cash, and anything more would
 * let a reader revalue it away from the trade it has to cancel.
 */
export function settlementRow(
  trade: Pick<NewHoldingTransaction, 'userId' | 'occurredAt' | 'source' | 'externalId'>,
  leg: SettlementLeg,
  holdingId: string
): NewHoldingTransaction {
  return {
    userId: trade.userId,
    holdingId,
    tokenId: leg.tokenId,
    kind: leg.kind,
    quantity: leg.quantity,
    occurredAt: trade.occurredAt,
    externalId: leg.externalId,
    source: trade.source,
    sourceMetadata: settlementMetadata(trade.externalId),
  };
}

export function isSettlementLeg(row: { sourceMetadata?: unknown }): boolean {
  const metadata = row.sourceMetadata;
  return typeof metadata === 'object' && metadata !== null && 'settles' in metadata;
}

function mirrorKey(
  tokenId: string,
  quantity: string,
  counterTokenId: string,
  counterQuantity: string,
  trade: MirrorableTrade
): string {
  return [
    trade.source,
    new Date(trade.occurredAt).getTime(),
    tokenId,
    new Decimal(quantity).toFixed(),
    counterTokenId,
    new Decimal(counterQuantity).toFixed(),
  ].join('|');
}

/**
 * Trades whose cash side the source already reported as a row of its own: two
 * rows in the batch that are each other's counter. IBKR writes a currency
 * conversion that way (SC-1452), and a settlement on either leg would move the
 * money a second time.
 */
export function tradesWithReportedCashSide<T extends MirrorableTrade>(rows: readonly T[]): Set<T> {
  const keyOf = (row: T) =>
    row.counterTokenId && row.counterQuantity
      ? mirrorKey(row.tokenId, row.quantity, row.counterTokenId, row.counterQuantity, row)
      : null;
  const mirrorOf = (row: T) =>
    row.counterTokenId && row.counterQuantity
      ? mirrorKey(row.counterTokenId, row.counterQuantity, row.tokenId, row.quantity, row)
      : null;
  const present = new Set(rows.map(keyOf).filter((key) => key !== null));
  return new Set(
    rows.filter((row) => {
      const mirror = mirrorOf(row);
      return mirror !== null && present.has(mirror);
    })
  );
}

/**
 * The cash side of a trade that its source reported as one row (SC-1453): the
 * counter amount as a settlement on the counter currency, and a commission
 * charged in another currency as its own `fee` row. A commission in the traded
 * asset stays only on the trade's `fee_quantity`, as the design scopes it.
 *
 * `cashSideReported` drops the settlement and keeps the commission: a source
 * that writes both sides of a conversion still writes its commission only on
 * the trade row. There the traded asset IS cash, so a commission in it leaves
 * the holding like any other and gets its row too (SC-1464).
 */
export function settlementLegsFor(
  trade: SettlementTrade,
  cashSideReported = false
): SettlementLeg[] {
  if (!SETTLEMENT_DERIVED_SOURCES.has(trade.source)) return [];
  if (!TRADE_KINDS.has(trade.kind) || !trade.externalId) return [];
  if (!trade.counterTokenId || !trade.counterQuantity) return [];
  const counter = new Decimal(trade.counterQuantity);
  if (counter.isZero()) return [];

  const legs: SettlementLeg[] = cashSideReported
    ? []
    : [
        {
          tokenId: trade.counterTokenId,
          kind: counter.isNegative() ? 'settle_out' : 'settle_in',
          quantity: trade.counterQuantity,
          externalId: `${trade.externalId}:settle`,
        },
      ];

  const feeLeavesCash = trade.feeTokenId !== trade.tokenId || cashSideReported;
  if (trade.feeTokenId && feeLeavesCash && trade.feeQuantity) {
    const fee = new Decimal(trade.feeQuantity);
    if (!fee.isZero()) {
      legs.push({
        tokenId: trade.feeTokenId,
        kind: 'fee',
        quantity: fee.abs().neg().toFixed(),
        externalId: `${trade.externalId}:fee`,
      });
    }
  }
  return legs;
}

type OwnFeeRow = Pick<
  NewHoldingTransaction,
  'kind' | 'tokenId' | 'feeQuantity' | 'feeTokenId' | 'externalId' | 'source'
>;

const LEG_KINDS: ReadonlySet<string> = new Set(['settle_in', 'settle_out', 'fee']);

/**
 * The fee a gross-reporting source took from the row's own token, as its own
 * `fee` row on the same holding (SC-1486), the shape an IBKR conversion's
 * commission already takes (SC-1464). Any kind: Kraken charges one on rewards,
 * deposits and withdrawals as well as trades.
 */
export function ownFeeLegFor(row: OwnFeeRow): SettlementLeg | null {
  if (!GROSS_OF_OWN_FEE_SOURCES.has(row.source) || LEG_KINDS.has(row.kind)) return null;
  if (!row.externalId || !row.feeQuantity || row.feeTokenId !== row.tokenId) return null;
  const fee = new Decimal(row.feeQuantity);
  if (fee.isZero()) return null;
  return {
    tokenId: row.tokenId,
    kind: 'fee',
    quantity: fee.abs().neg().toFixed(),
    externalId: `${row.externalId}:fee`,
  };
}
