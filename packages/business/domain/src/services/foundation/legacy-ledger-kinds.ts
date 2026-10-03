import type { HoldingTransaction } from '@scani/db/schema';
import { TRANSFER_REVIEW_CREATED_SOURCE } from '@scani/shared';
import type { KindOrigin, LedgerKind } from '../../engine/types';
import {
  MANUAL_EDIT_CORRECTION_SOURCE,
  MANUAL_EDIT_FLOW_SOURCE,
  USER_ENTERED_SOURCE,
} from '../../lib/person-authored-sources';
import {
  EVM_WALLET_SOURCE,
  NON_EVM_WALLET_SOURCES,
  STATEMENT_LEDGER_SOURCE_PREFIX,
} from '../transactions/transaction-source';
import { CEX_SOURCE_TO_INSTITUTION } from '../transactions/transaction-sources';
import type { Exclusion } from './classified-counts';
import {
  PROVIDER_INPUT_SOURCE_PREFIX,
  STATEMENT_INPUT_SOURCE,
  WALLET_FALLBACK_INPUT_SOURCE,
} from './plan-feed-inputs';

export type LegacyEntryFacts = Pick<
  HoldingTransaction,
  | 'id'
  | 'kind'
  | 'source'
  | 'transferGroupId'
  | 'swapGroupId'
  | 'settlesTransactionId'
  | 'priceNative'
  | 'priceNativeTokenId'
>;

type ExcludedEntry = Exclude<Exclusion, 'fabricated-observation'>;

export type LedgerMapping =
  | { excluded: ExcludedEntry }
  | {
      excluded: null;
      ledgerKind: LedgerKind | null;
      kindSubtype: string | null;
      groupId: string | null;
      feeOf: string | null;
      executionPrice: string | null;
      executionPriceTokenId: string | null;
      kindOrigin: KindOrigin | null;
      unmappedKind: string | null;
    };

export type InputSourceClass = 'provider' | 'statement' | 'wallet' | 'none';

export const APY_PAYOUT_SOURCE = 'apy-payout';

/**
 * The balance copy `updateHoldingBalance` wrote beside every balance write: its
 * `source`, and its `source_metadata.origin`. Rules O2 and O3 know a copy by the
 * pair, so a moved path that still writes one writes these.
 */
export const SYNC_CAPTURE_SOURCE = 'sync-capture';
export const BALANCE_COPY_ORIGIN = 'updateHoldingBalance';

/**
 * The `source_metadata` key on a balance copy a moved path keeps writing for
 * legacy history, naming the run it anchors. An APY run that books no row
 * leaves no payout row for rule O3 to find beside its copy (ruling R12), and a
 * statement uploaded a second time writes no statement row for rule O2 to find
 * beside its copy (ruling R21).
 */
export const LEGACY_ANCHOR_KEY = 'legacyAnchor';
export const APY_LEGACY_ANCHOR = APY_PAYOUT_SOURCE;
export const FILE_IMPORT_LEGACY_ANCHOR = 'file-import';

/**
 * Origins of a label that records a classification result rather than a
 * reading of the row, so the mapping below cannot re-derive it: a re-label
 * leaves it, and `stale-label` does not count it (A2 D-5).
 */
export const UNDERIVABLE_KIND_ORIGINS: readonly KindOrigin[] = ['rule', 'mirror', 'jev'];

// D-5: APY counts as person-authored because the person configured it.
const PERSON_SOURCES: ReadonlySet<string> = new Set([
  USER_ENTERED_SOURCE,
  MANUAL_EDIT_FLOW_SOURCE,
  MANUAL_EDIT_CORRECTION_SOURCE,
  TRANSFER_REVIEW_CREATED_SOURCE,
  APY_PAYOUT_SOURCE,
]);

function originOf(source: string): KindOrigin {
  return PERSON_SOURCES.has(source) ? 'person' : 'source';
}

type Classified = Pick<
  Extract<LedgerMapping, { excluded: null }>,
  'ledgerKind' | 'kindSubtype' | 'groupId' | 'feeOf' | 'executionPrice' | 'executionPriceTokenId'
>;

function classified(fields: Partial<Classified>): Classified {
  return {
    ledgerKind: null,
    kindSubtype: null,
    groupId: null,
    feeOf: null,
    executionPrice: null,
    executionPriceTokenId: null,
    ...fields,
  };
}

function classify(row: LegacyEntryFacts): Classified | null {
  switch (row.kind) {
    case 'buy':
    case 'sell':
    case 'swap_in':
    case 'swap_out':
      return classified({
        ledgerKind: 'trade_leg',
        groupId: row.swapGroupId ?? row.settlesTransactionId ?? row.id,
        executionPrice: row.priceNative,
        executionPriceTokenId: row.priceNativeTokenId,
      });
    case 'settle_in':
    case 'settle_out':
      return classified({ ledgerKind: 'trade_leg', groupId: row.settlesTransactionId });
    case 'fee':
      return classified({ ledgerKind: 'fee', feeOf: row.settlesTransactionId });
    case 'deposit':
      return row.transferGroupId === null
        ? classified({ ledgerKind: 'inflow' })
        : classified({ ledgerKind: 'transfer_in', groupId: row.transferGroupId });
    case 'withdraw':
      return row.transferGroupId === null
        ? classified({ ledgerKind: 'outflow' })
        : classified({ ledgerKind: 'transfer_out', groupId: row.transferGroupId });
    case 'transfer_in':
    case 'transfer_out':
      return classified({ ledgerKind: row.kind, groupId: row.transferGroupId });
    case 'interest':
      return classified({
        ledgerKind: 'income',
        kindSubtype: row.source === APY_PAYOUT_SOURCE ? 'apy' : 'interest',
      });
    case 'reward':
    case 'airdrop':
      return classified({ ledgerKind: 'income', kindSubtype: row.kind });
    case 'realized_pnl':
      return classified({ ledgerKind: 'derivative_pnl' });
    case 'unknown':
      return classified({});
    default:
      return null;
  }
}

/** The D-5 mapping table: the first matching row wins. */
export function mapLegacyEntry(row: LegacyEntryFacts): LedgerMapping {
  if (row.kind === 'opening_balance') return { excluded: 'opening-row' };
  if (row.kind === 'correction') return { excluded: 'legacy-correction-row' };
  const fields = classify(row);
  const ledger = fields ?? classified({});
  return {
    excluded: null,
    ...ledger,
    // An unclassified row has no kind, so no origin: labels are written once,
    // and a stored origin would outlive the kind a later rule or person applies.
    kindOrigin: ledger.ledgerKind === null ? null : originOf(row.source),
    unmappedKind: fields === null ? row.kind : null,
  };
}

/**
 * Which of an account's inputs a source belongs to (the D-5 `input_id` rule).
 *
 * `wallet` is named positively — the tags `sourceForChainId` produces — rather
 * than as the complement of the other two. As a complement, a screenshot or a
 * demo row would count as feed evidence and turn a manual holding into a feed
 * holding. The input sources `planFeedInputs` falls back to are classified too,
 * so one function reads both a ledger row and the input it belongs to.
 */
export function inputSourceClass(source: string): InputSourceClass {
  if (Object.hasOwn(CEX_SOURCE_TO_INSTITUTION, source)) return 'provider';
  if (source.startsWith(PROVIDER_INPUT_SOURCE_PREFIX)) return 'provider';
  if (source === STATEMENT_INPUT_SOURCE || source.startsWith(STATEMENT_LEDGER_SOURCE_PREFIX)) {
    return 'statement';
  }
  if (source === EVM_WALLET_SOURCE || NON_EVM_WALLET_SOURCES.has(source)) return 'wallet';
  if (source === WALLET_FALLBACK_INPUT_SOURCE) return 'wallet';
  return 'none';
}
