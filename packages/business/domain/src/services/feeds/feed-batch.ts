import type { NewHoldingTransaction, NewToken, TokenType } from '@scani/db/schema';
import type { HoldingArrival } from '@scani/shared';
import type { AbsencePolicy } from './blocks/absence-confirmer';

export type DecimalString = string;

export type TokenIdentity = Pick<
  NewToken,
  'name' | 'decimals' | 'iconUrl' | 'marketSegment' | 'providerMetadata'
> & { symbol: string };

export interface AssetRef {
  key?: string;
  identity: TokenIdentity;
  typeCode: TokenType['code'];
  lookup?: 'identity' | 'catalog-symbol' | 'catalog-symbol-of-type';
}

export interface FeedWindow {
  from: Date | null;
  to: Date;
  complete: boolean;
  uploadRef?: string;
}

export interface FeedCheckpoint {
  asset: AssetRef;
  at: Date;
  amount: DecimalString;
  authority: 'provider' | 'statement';
  legacySource: string;
  legacyMeta?: Record<string, unknown>;
}

/**
 * Every column a FeedEntry field, an ingest step or a label owns is left out;
 * the rest are today's legacy columns, written as given and deleted with the adapter.
 */
export type LegacyEntryColumns = Omit<
  NewHoldingTransaction,
  | 'id'
  | 'userId'
  | 'holdingId'
  | 'tokenId'
  | 'quantity'
  | 'occurredAt'
  | 'externalId'
  | 'inputId'
  | 'counterparty'
  | 'description'
  | 'swapGroupId'
  | 'settlesTransactionId'
  | 'counterTokenId'
  | 'counterPriceNativeTokenId'
  | 'feeTokenId'
  | 'priceNativeTokenId'
  | 'ledgerKind'
  | 'kindSubtype'
  | 'groupId'
  | 'feeOf'
  | 'executionPrice'
  | 'executionPriceTokenId'
  | 'kindOrigin'
  | 'decisionId'
  | 'createdAt'
  | 'updatedAt'
>;

export interface FeedEntry {
  externalId: string;
  asset: AssetRef;
  amount: DecimalString;
  occurredAt: Date;
  /** Becomes `swap_group_id = deterministicUuid(inputId, groupKey)`. */
  groupKey?: string;
  /**
   * The external id of the entry, in this batch and of this source, that this
   * fee or settle leg belongs to. Its row id becomes `settles_transaction_id`.
   */
  settlesExternalId?: string;
  counterparty?: string;
  description?: string;
  /**
   * Tokens a legacy row references besides its own, each created when the
   * catalog has none. Resolved only for an entry that reached a holding, and a
   * swap leg demoted to a transfer resolves no counter or quote (R32, R33).
   */
  legacyAssets?: {
    counter?: AssetRef;
    counterPriceQuote?: AssetRef;
    fee?: AssetRef;
    priceQuote?: AssetRef;
  };
  legacy: LegacyEntryColumns;
}

/** A position the source measured as gone (a probe's exit): its holding is zeroed, never created. */
export interface FeedAbsence {
  asset: AssetRef;
  confirmedAt: Date;
}

/** Today's per-path behaviour that one rule would change; each move that needs an option adds it. */
export interface LegacyBatchOptions {
  /**
   * `account-token` is the statement import's: the account's oldest visible
   * holding of the token. `ingest-order` is the transaction import's
   * (`HoldingRepository.findForIngest`): a row an import created, then the
   * oldest, hidden ones included, a person's row as the fallback (D-4).
   * `external-id` is the integration import's: the account's holding of the
   * token at the asset's key, hidden ones included, so a person's row, which
   * has no key, is never it (F3).
   *
   * The balance syncs read the account's holdings other than a person's,
   * hidden ones included, and kept the last one read of each token (F4).
   * `token-id` is the exchange cron's, whose read left out a token its owner
   * holds as scam; `token-id-with-scam` the exchange refresh's, whose read kept
   * it. `external-id-then-token-id` is the wallet syncs': the holding at the
   * asset's key, else the token's, scam ones included.
   */
  holdingMatch:
    | 'account-token'
    | 'ingest-order'
    | 'external-id'
    | 'token-id'
    | 'token-id-with-scam'
    | 'external-id-then-token-id';
  /**
   * `find-only` is a review-gated wallet's: an entry whose primary asset the
   * catalog lacks, or whose holding the account lacks, is skipped and counted,
   * and nothing is created for it (SC-343). `update-only` is a balance refresh's:
   * a token is found or created, a holding never, and a balance the account
   * holds no position for is dropped and named.
   */
  holdingPolicy: 'create' | 'find-only' | 'update-only';
  /** `holdings.source` on create. */
  holdingSource: string;
  arrival: HoldingArrival | null;
  writesCache: boolean;
  /** `sum-of-entries` is what `balanceWithoutClose` computes today. */
  createdWithoutCheckpoint: 'zero' | 'sum-of-entries';
  /**
   * The unlabelled copy of the balance today's path writes beside each cache
   * write, which legacy history anchors on until A5 (rulings R11, R19). It is
   * not a checkpoint: never held to the window, never evidence. Null writes none.
   */
  cacheObservation: { source: string; meta: Record<string, unknown> } | null;
  /**
   * Derive each landed trade's cash leg and own-token fee leg as the
   * transaction router did (`lib/transactions/trade-settlement.ts`, SC-1453,
   * SC-1486). Ingest does it after resolution, because whether a leg exists
   * turns on token ids no adapter has: is the fee in the traded token, and did
   * the source report the cash side as a row of its own.
   */
  derivesTradeLegs: boolean;
  /**
   * What a holding that cannot be found or created does. `skip-entry` is the
   * transaction router's: it tried each holding on its own, warned, and
   * dropped the event or leg (ruling R37), so here each holding is tried
   * inside a savepoint. `fail-batch` is the file import's, which never caught
   * one and failed the upload.
   */
  holdingFailure: 'skip-entry' | 'fail-batch';
  /**
   * Which holdings the batch's silence zeroes, and how: `confirmed` is the
   * exchange sync's, `immediate` an import's. Null: an asset the batch does not
   * mention is not absent. An explicit `absences` entry zeroes either way.
   */
  absence: AbsencePolicy | null;
  /**
   * A holding the batch reports again forgets the statement days it was
   * missing from, as the balance syncs and refresh do today; the imports do not.
   */
  clearsAbsenceTally: boolean;
  /**
   * The `source_metadata` of the first checkpoint on a holding the batch
   * creates, in place of the checkpoint's own: today's balance writers stamp a
   * create apart from an update, and A1's rule O4 reads both. Null: every
   * checkpoint keeps its own.
   */
  createdCheckpointMeta: Record<string, unknown> | null;
  /**
   * A hidden holding the batch reports at a nonzero balance is shown again, as
   * the integration import does: `is_hidden` and `last_updated`, and nothing else.
   */
  unhideOnNonZero: boolean;
  /**
   * `skip` is the exchange sync's: a checkpoint equal to the balance its holding
   * held when the batch found it is neither appended nor written to the cache.
   * It is dropped after placement, so the holding still counts as reported
   * (R62 Q2).
   */
  unchangedCheckpoint: 'append' | 'skip';
  /**
   * Whether a checkpoint at zero opens a holding under `holdingPolicy: 'create'`.
   * The balance syncs never opened one for a zero: the checkpoint is dropped
   * where the account holds no position, its token still found or created. An
   * exited position kept at wallet review does open one (SC-398).
   */
  zeroOpensHolding: boolean;
}

export interface FeedBatch {
  userId: string;
  input: {
    accountId: string;
    source: string;
    credentialId: string | null;
    walletId: string | null;
  };
  fetchedAt: Date;
  window: FeedWindow;
  checkpoints: FeedCheckpoint[];
  entries: FeedEntry[];
  absences: FeedAbsence[];
  legacy: LegacyBatchOptions;
  notices: string[];
}
