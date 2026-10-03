// HoldingsSyncHelper — one balance sync's answer for one account, written as a snapshot batch.

import type { DatabaseTransaction } from '@scani/db/transaction';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { Decimal, type HoldingArrivalAttribution, isValidDecimalString } from '@scani/shared';
import { Container, Service } from 'typedi';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { BaseService } from '../BaseService';
import type { AbsencePolicy } from '../feeds/blocks/absence-confirmer';
import { FeedIngestService, type IngestResult } from '../feeds/FeedIngestService';
import type { LegacyBatchOptions } from '../feeds/feed-batch';
import { type LegacySnapshot, legacySnapshotBatch } from '../feeds/legacy/snapshot-batch';
import {
  type IntegrationHolding,
  integrationTokenIdentity,
  projectSnapshotsToHoldings,
  projectSnapshotToTokenMapping,
} from './HoldingSnapshotProjection';

export interface ProcessSnapshotsForAccountInput {
  userId: string;
  accountId: string;
  /** The account's input these balances belong to (D-7): its provider's, or its chain's. */
  inputSource: string;
  /** The provider's answer, less any token the user rejected at a wallet review. */
  snapshots: HoldingSnapshot[];
  /** Positions a probe measured at zero (SC-852): each zeroes the holding it names and opens none. */
  exits: HoldingSnapshot[];
  /** When the provider was read: a balance with no usable as-of was true then, and so is an exit. */
  fetchedAt: Date;
  /** The token-type codes this path maps a snapshot's type to; any other reads as crypto. */
  typeCodes: ReadonlySet<string>;
  holdingMatch: Extract<
    LegacyBatchOptions['holdingMatch'],
    'token-id' | 'token-id-with-scam' | 'external-id-then-token-id'
  >;
  /** `zero`: a holding the answer leaves out is zeroed, unless the answer is empty (SC-236). */
  staleStrategy: 'preserve' | 'zero';
  /** A fiat holding zeroes once it has been missing from this many statement days (SC-1451). */
  absentFiatConfirmations?: number;
  sourceTag: string;
  // Wallet sync preserves user-hidden state across counts; exchange sync
  // counts every mutation regardless. Set true for wallet-style behaviour.
  respectHiddenForCounts: boolean;
  // Exchange sync skips updates when the balance hasn't changed; wallet
  // sync updates unconditionally to refresh the lastUpdated timestamp.
  skipUnchangedUpdates: boolean;
  // Only existing holdings are refreshed; the wallet refresh never opens one,
  // because chain discovery surfaces every airdropped scam-dust contract.
  updateOnly: boolean;
  // Stamped on rows this call CREATES; an update never revises how an
  // existing row arrived (SC-277).
  arrival: HoldingArrivalAttribution;
  tx: DatabaseTransaction;
}

export interface ProcessSnapshotsForAccountResult {
  updated: number;
  created: number;
  removed: number;
  // Token id of every holding created this run. NOTE: this is the
  // holding's token — which may be a pre-existing, shared token row
  // (the identity lookup returns the existing row when a wallet receives
  // an already-known token). Callers that scam-score or otherwise mutate
  // the token MUST re-check the token is genuinely new before writing —
  // see SyncWalletBalancesUseCase.scoreAndWarmNewTokens.
  createdTokenIds: string[];
}

/** A row of the answer the sync keeps, and the balance it becomes. */
interface KeptRow {
  holding: IntegrationHolding;
  snapshot: LegacySnapshot;
}

/** Contract address first, as the wallet sync has always keyed its holdings. */
function syncKey(holding: IntegrationHolding): string {
  return holding.contractAddress || holding.externalTokenId || holding.symbol;
}

/**
 * The balance syncs' write (A2 Task 16): the hourly exchange and wallet syncs
 * and the manual refresh each hand one account's answer here, which becomes
 * one snapshot batch through `FeedIngestService`, in the caller's transaction.
 * The rows the syncs have always skipped are skipped here, before the batch,
 * and the counts are the ones they have always reported.
 */
@Service()
export class HoldingsSyncHelper extends BaseService {
  private readonly feedIngest = Container.get(FeedIngestService);
  private readonly holdingRepository = Container.get(HoldingRepository);

  constructor() {
    super('HoldingsSyncHelper');
  }

  async processSnapshotsForAccount(
    input: ProcessSnapshotsForAccountInput
  ): Promise<ProcessSnapshotsForAccountResult> {
    const { snapshots, exits, fetchedAt } = input;
    // An exit is read beside the answer, as one list, so a row of either can
    // take its token from the other (`snapshotsByExternalId`).
    const byExternalId = new Map<string, HoldingSnapshot>();
    for (const s of [...snapshots, ...exits]) byExternalId.set(s.externalId, s);
    const kept = this.keep(snapshots, byExternalId, input);
    const exited = this.keep(exits, byExternalId, input);

    const batch = legacySnapshotBatch({
      userId: input.userId,
      input: {
        accountId: input.accountId,
        source: input.inputSource,
        credentialId: null,
        walletId: null,
      },
      returnedAt: snapshots.map((s) => s.capturedAt),
      snapshots: kept.map((row) => row.snapshot),
      absences: exited.map((row) => ({ asset: row.snapshot.asset, confirmedAt: fetchedAt })),
      fetchedAt,
      options: {
        holdingMatch: input.holdingMatch,
        holdingPolicy: input.updateOnly ? 'update-only' : 'create',
        holdingSource: input.sourceTag,
        arrival: input.arrival,
        holdingFailure: 'skip-entry',
        absence: input.staleStrategy === 'zero' ? this.zeroStale(input) : null,
        clearsAbsenceTally: true,
        unhideOnNonZero: false,
        unchangedCheckpoint: input.skipUnchangedUpdates ? 'skip' : 'append',
        zeroOpensHolding: false,
      },
    });
    const ingested = await this.feedIngest.ingest(batch, input.tx);
    return await this.count(input, kept, ingested);
  }

  /**
   * The rows of an answer the sync writes, in its order, each with its token
   * identified. A row with no symbol or an unreadable balance, a negative one
   * that is not cash, or one that matches no snapshot is skipped and logged.
   */
  private keep(
    snapshots: HoldingSnapshot[],
    byExternalId: ReadonlyMap<string, HoldingSnapshot>,
    input: ProcessSnapshotsForAccountInput
  ): KeptRow[] {
    const { accountId } = input;
    const keyed = input.holdingMatch === 'external-id-then-token-id';
    const kept: KeptRow[] = [];
    for (const holding of projectSnapshotsToHoldings(snapshots, accountId).holdings) {
      if (!holding.symbol || !holding.balance) {
        this.logger.warn(
          { accountId, holding },
          'Skipping integration holding with missing symbol or balance'
        );
        continue;
      }
      if (!isValidDecimalString(holding.balance)) {
        this.logger.warn(
          { accountId, holding },
          'Skipping integration holding with invalid balance format'
        );
        continue;
      }
      // Only cash may go negative: margin debt, which subtracts from net
      // worth as the broker shows it (SC-1462). A negative position in
      // anything else is a short, which has no representation here, so it
      // is skipped and the stale-zeroing pass settles any existing row to 0.
      if (new Decimal(holding.balance).isNegative() && holding.tokenType !== 'fiat') {
        this.logger.warn(
          { accountId, holding },
          'Skipping integration holding with negative balance'
        );
        continue;
      }
      const key = syncKey(holding);
      const snapshot = byExternalId.get(key) ?? byExternalId.get(holding.symbol);
      if (!snapshot) {
        this.logger.warn(
          { accountId, holding },
          'No matching snapshot for holding — skipping (provider returned inconsistent shape)'
        );
        continue;
      }
      try {
        kept.push({
          holding,
          snapshot: {
            asset: {
              ...(keyed ? { key } : {}),
              identity: integrationTokenIdentity(projectSnapshotToTokenMapping(snapshot).token),
              typeCode:
                holding.tokenType !== undefined && input.typeCodes.has(holding.tokenType)
                  ? holding.tokenType
                  : 'crypto',
              lookup: 'identity',
            },
            balance: holding.balance,
            capturedAt: holding.capturedAt,
          },
        });
      } catch (error) {
        this.failed(accountId, holding.symbol, error);
      }
    }
    return kept;
  }

  /**
   * The exchange sync's silence rule: one row is evidence the provider looked,
   * and a fiat holding waits for its statement days (R62 Q2: the raw answer).
   */
  private zeroStale(input: ProcessSnapshotsForAccountInput): AbsencePolicy {
    const { snapshots, absentFiatConfirmations } = input;
    return {
      mode: 'confirmed',
      guardEmptySnapshot: true,
      confirmations: absentFiatConfirmations
        ? { typeCode: 'fiat', statements: absentFiatConfirmations }
        : null,
      providerRows: snapshots.length,
      statementAsOf: new Date(Math.max(...snapshots.map((s) => +new Date(s.capturedAt)))),
    };
  }

  /**
   * Today's counts: an update per row that wrote, a creation per holding
   * opened, and a removal per row that wrote zero and per holding an absence
   * zeroed. A hidden holding counts nothing where the caller says so.
   */
  private async count(
    input: ProcessSnapshotsForAccountInput,
    kept: readonly KeptRow[],
    ingested: IngestResult
  ): Promise<ProcessSnapshotsForAccountResult> {
    const result: ProcessSnapshotsForAccountResult = {
      updated: 0,
      created: 0,
      removed: 0,
      createdTokenIds: [],
    };
    const outcomes = ingested.checkpointOutcomes;
    const hidden = input.respectHiddenForCounts
      ? await this.hiddenAmong(
          [...outcomes.flatMap((o) => o.holdingId ?? []), ...ingested.zeroedHoldingIds],
          input.tx
        )
      : new Set<string>();
    const cacheOf = new Map(ingested.holdings.map((h) => [h.holdingId, h.cacheBalance]));
    const opened = new Set<string>();
    for (const [index, { holding }] of kept.entries()) {
      const outcome = outcomes[index];
      if (outcome === undefined) continue;
      if (outcome.failure !== null) {
        this.failed(input.accountId, holding.symbol, outcome.failure);
        continue;
      }
      const { holdingId, tokenId } = outcome;
      if (holdingId === null || tokenId === null) continue;
      if (outcome.created) {
        if (opened.has(holdingId)) continue;
        opened.add(holdingId);
        result.created++;
        result.createdTokenIds.push(tokenId);
        continue;
      }
      // An unchanged balance the batch skipped wrote nothing.
      if (cacheOf.get(holdingId) === null || hidden.has(holdingId)) continue;
      if (new Decimal(holding.balance).isZero()) result.removed++;
      else result.updated++;
    }
    for (const holdingId of ingested.zeroedHoldingIds) {
      if (!hidden.has(holdingId)) result.removed++;
    }
    return result;
  }

  private async hiddenAmong(
    holdingIds: readonly string[],
    tx: DatabaseTransaction
  ): Promise<Set<string>> {
    const rows = await this.holdingRepository.findByIds([...new Set(holdingIds)], tx);
    return new Set(rows.filter((h) => h.isHidden).map((h) => h.id));
  }

  private failed(accountId: string, symbol: string, error: unknown): void {
    this.logger.error(
      {
        accountId,
        symbol,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to process integration holding'
    );
  }
}
