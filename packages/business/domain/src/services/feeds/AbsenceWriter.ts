import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { classifyHoldingEvidence } from '../foundation/legacy-classification';
import { PROVIDER_SYNC_ORIGIN, SYNC_CAPTURE_SOURCE } from '../foundation/legacy-ledger-kinds';
import { MANUAL_HOLDING_SOURCE } from '../holdings/balance-sync-sources';
import { confirmAbsences } from './blocks/absence-confirmer';
import type { AssetRef, FeedBatch } from './feed-batch';
import { HoldingCacheWriter } from './HoldingCacheWriter';
import { HoldingResolver } from './HoldingResolver';

/** A holding an absence zeroed, and the instant its zero is observed at. */
interface AbsenceZero {
  holdingId: string;
  at: Date;
}

interface AbsenceWrite {
  batch: FeedBatch;
  inputId: string;
  /** The tokens the batch's checkpoints resolved to: what a `confirmed` batch reported. */
  reportedTokenIds: ReadonlySet<string>;
  /** An explicit absence's token, found and never created; null when the catalog has none. */
  absenceTokenOf: (asset: AssetRef) => string | null;
  /** The holdings a checkpoint of the batch landed on. */
  checkpointed: readonly Holding[];
}

/**
 * A measured exit's instant, unless it is unreadable or not yet past: then now,
 * as a source's clock error has always been stamped (SC-1427).
 */
function exitObservedAt(confirmedAt: Date, now: Date): Date {
  const at = confirmedAt.getTime();
  return !Number.isNaN(at) && at < now.getTime() ? confirmedAt : now;
}

/**
 * Writes what a batch's absences decide, inside the batch's transaction (A2
 * Task 14). A zero is today's (R60): the cache at '0' and one observation with
 * the sync's source and origin, labelled as A1 labels that row, at now for a
 * silence and at its own instant for a measured exit. Each holding's writes
 * have their own savepoint, so one that fails is logged as the sync logs it and
 * costs only itself (R61).
 *
 * The candidates are today's scope, less any holding only another input owns:
 * another input has checkpointed it, this one has not, and this importer did
 * not set its key (R62). Ownership is read through A1's classifier, so an
 * unlabelled sync row counts as the input A1 gives it, and only on the
 * holdings about to be zeroed or tallied.
 */
@Service()
export class AbsenceWriter {
  private readonly holdings = Container.get(HoldingRepository);
  private readonly observations = Container.get(HoldingBalanceObservationRepository);
  private readonly cacheWriter = Container.get(HoldingCacheWriter);
  private readonly resolver = Container.get(HoldingResolver);
  private readonly evidence = Container.get(EngineEvidenceRepository);
  private readonly logger = createComponentLogger('service:AbsenceWriter');

  /**
   * In today's order: a reported holding's tally cleared, then the measured
   * exits, then the silence. Returns the holdings it zeroed.
   */
  async apply(write: AbsenceWrite, tx: DatabaseTransaction): Promise<AbsenceZero[]> {
    if (write.batch.legacy.clearsAbsenceTally) {
      for (const holding of write.checkpointed) {
        if (holding.absentFromStatements?.length) {
          await this.holdings.setAbsentFromStatements(holding.id, null, tx);
        }
      }
    }
    const exits = await this.zeroExits(write, tx);
    return [...exits, ...(await this.zeroSilence(write, tx))];
  }

  /** Each explicit absence's holding, by the batch's own matching; one that is not there is not created. */
  private async zeroExits(write: AbsenceWrite, tx: DatabaseTransaction): Promise<AbsenceZero[]> {
    const { batch } = write;
    const found: Array<{ holding: Holding; confirmedAt: Date }> = [];
    for (const { asset, confirmedAt } of batch.absences) {
      const tokenId = write.absenceTokenOf(asset);
      if (tokenId === null) continue;
      const holding = await this.resolver.findFeedHolding(
        {
          userId: batch.userId,
          accountId: batch.input.accountId,
          tokenId,
          key: asset.key ?? null,
          match: batch.legacy.holdingMatch,
        },
        tx
      );
      if (holding !== null && !found.some((f) => f.holding.id === holding.id)) {
        found.push({ holding, confirmedAt });
      }
    }
    const elsewhere = await this.ownedElsewhere(
      write,
      found.map((f) => f.holding.id),
      tx
    );
    const zeroed: AbsenceZero[] = [];
    for (const { holding, confirmedAt } of found) {
      if (elsewhere.has(holding.id)) continue;
      const at = exitObservedAt(confirmedAt, new Date());
      const clearTally =
        batch.legacy.clearsAbsenceTally && Boolean(holding.absentFromStatements?.length);
      if (await this.zero(write, holding.id, at, clearTally, tx)) {
        zeroed.push({ holdingId: holding.id, at });
      }
    }
    return zeroed;
  }

  /** The candidates the batch did not mention, by its policy. */
  private async zeroSilence(write: AbsenceWrite, tx: DatabaseTransaction): Promise<AbsenceZero[]> {
    const { batch } = write;
    const policy = batch.legacy.absence;
    if (policy === null) return [];
    const { userId } = batch;
    const { accountId } = batch.input;
    const confirmed = policy.mode === 'confirmed';
    const rows = await this.holdings.findAbsenceCandidates(
      userId,
      accountId,
      confirmed
        ? { exceptSource: MANUAL_HOLDING_SOURCE, scamFree: true }
        : { source: batch.legacy.holdingSource, scamFree: false },
      tx
    );
    // The sync keyed its holdings by token: one candidate per token, the last
    // one read, in the place the first one held.
    const candidates = confirmed ? [...new Map(rows.map((r) => [r.tokenId, r])).values()] : rows;

    const decision = confirmAbsences({
      policy,
      reportedKeys: confirmed ? write.reportedTokenIds : new Set(policy.reportedKeys),
      owned: candidates.map((c) => ({
        holdingId: c.id,
        key: confirmed ? c.tokenId : c.externalId,
        typeCode: c.typeCode,
        balance: c.balance,
        absentFromStatements: c.absentFromStatements,
      })),
    });
    if (decision.guardTripped) {
      // Declining to act in silence would look like "nothing to do" (SC-236).
      const preserved = candidates.filter((c) => c.balance !== '0').length;
      if (preserved > 0) {
        this.logger.warn(
          {
            accountId,
            userId,
            sourceTag: batch.legacy.holdingSource,
            preservedHoldings: preserved,
          },
          'Empty snapshot under staleStrategy=zero — refusing to zero holdings; balances left stale'
        );
      }
      return [];
    }

    const failed = new Map(decision.failed.map((f) => [f.holdingId, f.error]));
    const acted = new Set([...decision.zero, ...decision.tally.keys(), ...failed.keys()]);
    const elsewhere = await this.ownedElsewhere(write, [...acted], tx);
    const cleared = new Set(decision.cleared);
    const zeroed: AbsenceZero[] = [];
    for (const { id } of candidates) {
      if (!acted.has(id) || elsewhere.has(id)) continue;
      const error = failed.get(id);
      const dates = decision.tally.get(id);
      if (error !== undefined) {
        this.logFailure(id, error);
      } else if (dates !== undefined) {
        await this.attempt(id, (sp) => this.holdings.setAbsentFromStatements(id, dates, sp), tx);
      } else {
        const at = new Date();
        if (await this.zero(write, id, at, cleared.has(id), tx)) zeroed.push({ holdingId: id, at });
      }
    }
    return zeroed;
  }

  private async zero(
    write: AbsenceWrite,
    holdingId: string,
    at: Date,
    clearTally: boolean,
    tx: DatabaseTransaction
  ): Promise<boolean> {
    const { userId } = write.batch;
    return await this.attempt(
      holdingId,
      async (sp) => {
        if (clearTally) await this.holdings.setAbsentFromStatements(holdingId, null, sp);
        await this.cacheWriter.apply(userId, [{ holdingId, balance: '0' }], sp);
        await this.observations.append(
          {
            userId,
            holdingId,
            balance: '0',
            observedAt: at,
            source: SYNC_CAPTURE_SOURCE,
            sourceMetadata: { origin: PROVIDER_SYNC_ORIGIN },
            role: 'checkpoint',
            authority: 'provider',
            inputId: write.inputId,
            cause: null,
          },
          sp
        );
      },
      tx
    );
  }

  /** One holding's writes in a savepoint; a failure is logged and the batch goes on (R61). */
  private async attempt(
    holdingId: string,
    run: (sp: DatabaseTransaction) => Promise<unknown>,
    tx: DatabaseTransaction
  ): Promise<boolean> {
    try {
      await tx.transaction(run);
      return true;
    } catch (error) {
      this.logFailure(holdingId, error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private logFailure(holdingId: string, error: string): void {
    this.logger.error({ holdingId, error }, 'Failed to zero out stale holding');
  }

  /** Of `holdingIds`, those only another input owns. */
  private async ownedElsewhere(
    write: AbsenceWrite,
    holdingIds: readonly string[],
    tx: DatabaseTransaction
  ): Promise<Set<string>> {
    const { batch, inputId } = write;
    const raws = await this.evidence.findHoldingEvidence({ userId: batch.userId, holdingIds }, tx);
    const elsewhere = new Set<string>();
    for (const raw of raws) {
      const owners = new Set(
        classifyHoldingEvidence(raw).evidence.observations.flatMap((o) =>
          o.role === 'checkpoint' && o.inputId !== null ? [o.inputId] : []
        )
      );
      const keyedHere =
        raw.holding.externalId !== null && raw.holding.source === batch.legacy.holdingSource;
      if (owners.size > 0 && !owners.has(inputId) && !keyedHere) elsewhere.add(raw.holding.id);
    }
    return elsewhere;
  }
}
