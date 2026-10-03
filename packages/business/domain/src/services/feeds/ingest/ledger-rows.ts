import type { Holding, HoldingTransaction, NewHoldingTransaction } from '@scani/db/schema';
import { demoteSwapLeg } from '../../../lib/transactions/swap-groups';
import {
  ownFeeLegFor,
  settlementLegsFor,
  settlementRow,
  tradesWithReportedCashSide,
} from '../../../lib/transactions/trade-settlement';
import { deterministicUuid } from '../deterministic-id';
import type { FeedEntry } from '../feed-batch';
import type { BatchTokens } from './BatchTokens';
import type { Placement } from './HoldingPlacer';
import { holdingFailedNotice } from './notices';

/** A row to upsert and, for a leg, the external id of the row it settles. */
export interface LedgerRow {
  row: NewHoldingTransaction;
  settles: string | undefined;
}

export const parentKey = (source: string, externalId: string) =>
  JSON.stringify([source, externalId]);

/** Today's legacy columns as given, then every column a contract field or this write owns. */
function ledgerRow(entry: FeedEntry, holding: Holding, inputId: string): NewHoldingTransaction {
  return {
    ...entry.legacy,
    userId: holding.userId,
    holdingId: holding.id,
    tokenId: holding.tokenId,
    quantity: entry.amount,
    occurredAt: entry.occurredAt,
    externalId: entry.externalId,
    inputId,
    counterparty: entry.counterparty ?? null,
    description: entry.description ?? null,
  };
}

/**
 * Each landed entry's row on its holding, its amount counted on the placement.
 * A swap whose legs all landed takes one group id, derived from the input and
 * the group key; a lone leg goes back to the transfer it was (SC-332) and
 * keeps only its fee token, leaving no other token id behind (R33).
 */
export function entryRows(
  landed: ReadonlyArray<{ entry: FeedEntry; at: Placement }>,
  demoted: ReadonlySet<FeedEntry>,
  tokens: BatchTokens,
  inputId: string
): Array<{ entry: FeedEntry; row: NewHoldingTransaction }> {
  return landed.map(({ entry, at: placement }) => {
    placement.amounts.push(entry.amount);
    const row = ledgerRow(entry, placement.holding, inputId);
    const { counter, fee, priceQuote, counterPriceQuote } = entry.legacyAssets ?? {};
    row.feeTokenId = tokens.tokenOf(fee, 'create');
    if (demoted.has(entry)) {
      demoteSwapLeg(row);
      row.counterPriceNative = null;
    } else {
      if (entry.groupKey) row.swapGroupId = deterministicUuid(inputId, entry.groupKey);
      row.counterTokenId = tokens.tokenOf(counter, 'create');
      row.priceNativeTokenId = tokens.tokenOf(priceQuote, 'create');
      row.counterPriceNativeTokenId = tokens.tokenOf(counterPriceQuote, 'create');
    }
    return { entry, row };
  });
}

/**
 * Each landed trade's cash leg and own-token fee leg, by the rules the
 * transaction router applied (SC-1452, SC-1453, SC-1486), on the resolved
 * rows after the swaps settle: a lone swap leg is a transfer by then and
 * must not be read as a trade. A leg is placed by the batch's own matching
 * and policy; one with no holding (none under find-only, or one that failed,
 * R37) is skipped and counted, and its trade lands without it.
 */
export async function deriveTradeLegs(
  trades: readonly NewHoldingTransaction[],
  where: {
    placeLeg: (tokenId: string, at: Date) => Promise<Placement | null>;
    holdingFailureOf: (tokenId: string, key?: string) => string | undefined;
  },
  inputId: string
): Promise<{ rows: LedgerRow[]; unresolved: number; failures: string[] }> {
  const cashSideReported = tradesWithReportedCashSide(trades);
  const rows: LedgerRow[] = [];
  const failures: string[] = [];
  let unresolved = 0;
  for (const trade of trades) {
    const ownFee = ownFeeLegFor(trade);
    for (const leg of [
      ...settlementLegsFor(trade, cashSideReported.has(trade)),
      ...(ownFee ? [ownFee] : []),
    ]) {
      const placement = await where.placeLeg(leg.tokenId, trade.occurredAt);
      if (placement === null) {
        const failure = where.holdingFailureOf(leg.tokenId);
        if (failure !== undefined) failures.push(holdingFailedNotice(leg.tokenId, failure));
        unresolved += 1;
        continue;
      }
      placement.amounts.push(leg.quantity);
      rows.push({
        row: { ...settlementRow(trade, leg, placement.holding.id), inputId },
        settles: trade.externalId ?? undefined,
      });
    }
  }
  return { rows, unresolved, failures };
}

/**
 * Each leg with the row it settles, both written by this batch. A leg whose
 * external id two of the batch's rows answer to is left unlinked here.
 * `linkSettlements`, where a caller runs it, then links it to an arbitrary
 * one of the two: its `UPDATE … FROM` matches both and takes whichever row
 * Postgres reaches first.
 */
export function legLinks(
  rows: readonly LedgerRow[],
  written: readonly HoldingTransaction[]
): Array<{ legId: string; parentId: string }> {
  const rowKey = (r: { holdingId: string; source: string; externalId?: string | null }) =>
    JSON.stringify([r.holdingId, r.source, r.externalId ?? null]);
  const idOf = new Map(written.map((r) => [rowKey(r), r.id]));
  const parentIds = new Map<string, Set<string>>();
  for (const { row, settles } of rows) {
    const id = idOf.get(rowKey(row));
    if (settles !== undefined || id === undefined || !row.externalId) continue;
    const key = parentKey(row.source, row.externalId);
    const ids = parentIds.get(key);
    if (ids) ids.add(id);
    else parentIds.set(key, new Set([id]));
  }
  return rows.flatMap(({ row, settles }) => {
    if (settles === undefined) return [];
    const legId = idOf.get(rowKey(row));
    const parents = [...(parentIds.get(parentKey(row.source, settles)) ?? [])];
    return legId !== undefined && parents.length === 1 ? [{ legId, parentId: parents[0]! }] : [];
  });
}
