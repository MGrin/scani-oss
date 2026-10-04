import { type DatabaseTransaction, getDb } from '@scani/db';
import { type JobNotice, toJobNotice } from '@scani/providers/core/types';
import { Container, Service } from 'typedi';
import { RecordNotAccessibleError } from '../../lib/record-not-accessible';
import { orphanedSwapLegsNotice } from '../../lib/transactions/swap-groups';
import { AccountRepository } from '../../repositories/AccountRepository';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { FeedInputRepository } from '../../repositories/FeedInputRepository';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import {
  type BulkUpsertMerge,
  HoldingTransactionRepository,
} from '../../repositories/HoldingTransactionRepository';
import { classifyHoldingEvidence } from '../foundation/legacy-classification';
import { AbsenceWriter } from './AbsenceWriter';
import { AssetResolver } from './AssetResolver';
import { type BatchProblem, validateBatch } from './blocks/validate-batch';
import { FeedClassifier } from './classification/FeedClassifier';
import type { AssetRef, DecimalString, FeedBatch, LegacyBatchOptions } from './feed-batch';
import { type CacheWrite, HoldingCacheWriter } from './HoldingCacheWriter';
import { BatchTokens, tokenModeOf } from './ingest/BatchTokens';
import { HoldingPlacer, type Placement } from './ingest/HoldingPlacer';
import { LandingPlanner } from './ingest/LandingPlanner';
import { deriveTradeLegs, entryRows, type LedgerRow, legLinks } from './ingest/ledger-rows';
import {
  duplicatePlacementNotice,
  holdingFailedNotice,
  reviewSkipNotice,
  type SkippedAsset,
  skippedAssets,
  unheldCheckpointNotice,
  unresolvedLegsNotice,
} from './ingest/notices';
import type { IngestOutcome } from './ingest-outcome';
import { balanceWithoutClose } from './legacy/balance-without-close';

export interface IngestResult extends IngestOutcome {
  inputId: string;
  /** `notices`, index-aligned, each with the key it can be translated under (SC-434). */
  noticeDetails: JobNotice[];
  /** Whether each of `batch.entries`, in its order, reached the ledger. */
  entryOutcomes: Array<'landed' | 'skipped'>;
  /** Rows handed to the upsert, the derived trade legs included, before its own merges. */
  rowsSent: number;
  /** Ledger rows the upsert stored after the batch's own merges, a re-sent row included. */
  entriesWritten: number;
  merges: BulkUpsertMerge[];
  /** A checkpoint whose (holding, instant, source) is already held is not appended. */
  checkpointsWritten: number;
  /** False when this fetch's window was already recorded. */
  windowRecorded: boolean;
  /**
   * Each holding a mirror leg landed in. Not among `touchedHoldingIds`, whose
   * holdings the caller runs its feed's post-steps over: today's queue arrival
   * runs none of them on its destination.
   */
  mirrorHoldingIds: string[];
  /**
   * Each holding an absence zeroed. Not among `touchedHoldingIds`: today's
   * callers ran none of their post-steps on a zero, and counted it apart.
   */
  zeroedHoldingIds: string[];
  /** Each of the batch's own assets that did not resolve, once. */
  skippedAssets: SkippedAsset[];
  /**
   * Where each of `batch.checkpoints`, in its order, was placed: its token and
   * holding, whether the batch created that holding, and why it was not placed
   * when its token lookup or its holding failed.
   */
  checkpointOutcomes: Array<{
    tokenId: string | null;
    holdingId: string | null;
    created: boolean;
    failure: string | null;
  }>;
  /** Each holding the batch wrote into, in the order the batch first named it. */
  holdings: Array<{
    holdingId: string;
    tokenId: string;
    /** What its cache was set to; null when the batch left it as it was. */
    cacheBalance: DecimalString | null;
  }>;
}

export class FeedBatchRejected extends Error {
  override readonly name = 'FeedBatchRejected';
  readonly problems: readonly BatchProblem[];

  constructor(problems: readonly BatchProblem[]) {
    super(`feed batch rejected: ${problems.map((p) => `${p.code} (${p.detail})`).join('; ')}`);
    this.problems = problems;
  }
}

const earliestOf = (dates: ReadonlyArray<Date | null>): Date | null =>
  dates.reduce<Date | null>((min, d) => (d !== null && (min === null || d < min) ? d : min), null);

/** The balance today's import gave a holding it created and had no close for (D-1). */
function createdBalance(
  rule: LegacyBatchOptions['createdWithoutCheckpoint'],
  amounts: readonly DecimalString[]
): DecimalString | null {
  if (rule === 'zero') return '0';
  const derived = balanceWithoutClose(amounts);
  return derived.kind === 'from-rows' ? derived.balance : null;
}

/**
 * The write path every feed import shares (D-8): one batch, one input, one
 * window, one transaction.
 */
@Service()
export class FeedIngestService {
  private readonly accounts = Container.get(AccountRepository);
  private readonly inputs = Container.get(FeedInputRepository);
  private readonly assets = Container.get(AssetResolver);
  private readonly planner = Container.get(LandingPlanner);
  private readonly placer = Container.get(HoldingPlacer);
  private readonly holdings = Container.get(HoldingRepository);
  private readonly ledger = Container.get(HoldingTransactionRepository);
  private readonly observations = Container.get(HoldingBalanceObservationRepository);
  private readonly cacheWriter = Container.get(HoldingCacheWriter);
  private readonly evidence = Container.get(EngineEvidenceRepository);
  private readonly classifier = Container.get(FeedClassifier);
  private readonly absences = Container.get(AbsenceWriter);

  /**
   * Writes the batch in the caller's transaction, or in its own, so a failure
   * anywhere writes nothing and records no window. A batch the validator
   * refuses throws `FeedBatchRejected` before anything is read.
   *
   * An entry lands when its asset resolves and its holding is found, or
   * created under `holdingPolicy: 'create'`; a checkpoint at zero creates none
   * unless `zeroOpensHolding` says it may. Otherwise it is skipped with the
   * legs that settle it, and so is a checkpoint; an asset that does not resolve
   * is reported, a find-only skip is counted in `notices`, and so is a
   * checkpoint a non-create batch has no holding for (T10 M6). The rest is
   * written: swap legs paired under one id derived from the input and the
   * group key, a lone one demoted to a transfer, under `derivesTradeLegs` each
   * trade's cash and own-fee legs, and each leg pointed at the row it settles.
   *
   * The cache is written where today's import wrote it (D-1): a checkpointed
   * holding takes its latest checkpoint, a holding the batch created takes the
   * batch's rule, and an existing holding with no checkpoint keeps its balance.
   * Under `unchangedCheckpoint: 'skip'` a checkpoint equal to its holding's
   * balance is neither appended nor written. Beside each cache write goes the
   * batch's `cacheObservation`, when it names one, and under `unhideOnNonZero`
   * a hidden holding reported nonzero is shown. Then the batch's absences are
   * written: its explicit ones, and under its `absence` policy the holdings it
   * did not mention (`AbsenceWriter`).
   */
  async ingest(batch: FeedBatch, tx?: DatabaseTransaction): Promise<IngestResult> {
    const problems = validateBatch(batch, new Date());
    if (problems.length > 0) throw new FeedBatchRejected(problems);
    // An input is the account's, so a batch naming another user's account
    // would create one there, and every later upload by its owner would fail.
    // Asked before anything resolves, so a refused batch creates no token.
    const { userId } = batch;
    const { accountId } = batch.input;
    if ((await this.accounts.findByIdAndUser(accountId, userId, tx)) === null) {
      throw new RecordNotAccessibleError(
        'account',
        `FeedIngestService: user ${userId} has no account ${accountId}`
      );
    }
    const tokens = new BatchTokens(this.assets);
    if (tx) return await this.write(batch, tx, tokens);
    // Creating a token can ask every identity provider over the network, so the
    // batch plans its landing once before its own transaction opens, against
    // the holdings as they are now, and finds or creates its tokens there. The
    // write takes the same plan and reads each answer back, asking again only
    // for an entry this pass did not land (R34, R34b). A token created here
    // outlives a batch that then fails, as it always has.
    await this.planner.plan(
      batch,
      tokens,
      (carried) => this.placer.locateBeforeWrite(batch, tokens, carried),
      undefined
    );
    return await getDb().transaction((own) => this.write(batch, own, tokens));
  }

  private async write(
    batch: FeedBatch,
    tx: DatabaseTransaction,
    tokens: BatchTokens
  ): Promise<IngestResult> {
    const { userId } = batch;
    const input = await this.inputs.findOrCreate({ ...batch.input, userId }, tx);
    const mode = tokenModeOf(batch.legacy.holdingPolicy);
    const tokenOf = (asset: AssetRef) => tokens.tokenOf(asset, mode);
    const { carried, landed, demoted, where } = await this.planner.plan(
      batch,
      tokens,
      async (carried) => {
        const placed = await this.placer.place(batch, carried, tokenOf, tx);
        return { ...placed, landingOf: placed.placementOf };
      },
      tx
    );
    const { placementOf, placeLeg, holdingFailureOf, placementsByHolding } = where;
    /** The router's line for an asset whose holding failed (R37), or null. */
    const failedHolding = (asset: AssetRef) => {
      const tokenId = tokenOf(asset);
      const message = tokenId === null ? undefined : holdingFailureOf(tokenId, asset.key);
      return tokenId === null || message === undefined
        ? null
        : holdingFailedNotice(tokenId, message);
    };
    const entryHoldingFailures = carried.flatMap((entry) => failedHolding(entry.asset) ?? []);

    const rows = entryRows(landed, demoted, tokens, input.id);
    const legs = batch.legacy.derivesTradeLegs
      ? await deriveTradeLegs(
          rows.map(({ row }) => row),
          { placeLeg, holdingFailureOf },
          input.id
        )
      : { rows: [], unresolved: 0, failures: [] };
    const sent: LedgerRow[] = [
      ...rows.map(({ entry, row }) => ({ row, settles: entry.settlesExternalId })),
      ...legs.rows,
    ];
    const placements = [...placementsByHolding.values()];
    // Before anything is written into them (R78). An edit takes its holding's
    // row, then the advisory lock an observation insert takes (SC-1319); the
    // checkpoints below append before the cache write, the opposite order, so
    // without this a sync and an edit of one holding deadlock. A holding the
    // ledger rows go into is taken at the upsert's own FOR UPDATE, so that
    // lock upgrades nothing. A holding the batch created is invisible to every
    // other transaction until it commits.
    await this.holdings.lockInIdOrder(
      userId,
      placements.filter((p) => !p.created).map((p) => p.holding.id),
      new Set(sent.map(({ row }) => row.holdingId)),
      tx
    );
    // Labelled by the upsert itself, and the legs again once linked (D-5).
    // Keyed by the input, so a re-sent event updates its one row, wherever
    // it is now placed (D-7).
    const written = await this.ledger.bulkUpsert(
      sent.map(({ row }) => row),
      tx,
      { arbiter: 'input' }
    );
    await this.ledger.linkLegs(userId, legLinks(sent, written.rows), tx);
    const classified = await this.classifier.classify(
      {
        userId,
        inputId: input.id,
        accountId: batch.input.accountId,
        // An event written onto an old copy is classified as the input's own
        // row, which the write left where it is (R59).
        rowIds: [...written.rows.map((row) => row.id), ...written.duplicatePlacements],
      },
      tx
    );
    /**
     * Under `unchangedCheckpoint: 'skip'`, an amount equal, as text, to the
     * balance its found holding held: today's sync compared the strings.
     */
    const unchanged = (placement: Placement, amount: DecimalString) =>
      batch.legacy.unchangedCheckpoint === 'skip' &&
      !placement.created &&
      amount === placement.holding.balance;

    let checkpointsWritten = 0;
    const appendedAt: Date[] = [];
    const opened = new Set<Placement>();
    for (const checkpoint of batch.checkpoints) {
      const placement = placementOf(checkpoint.asset);
      if (placement === null) continue;
      if (placement.close === null || checkpoint.at >= placement.close.at) {
        placement.close = checkpoint;
      }
      // Dropped after placement, so the holding still counts as reported (R62 Q2).
      if (unchanged(placement, checkpoint.amount)) continue;
      const createdMeta = batch.legacy.createdCheckpointMeta;
      const opens = placement.created && createdMeta !== null && !opened.has(placement);
      if (opens) opened.add(placement);
      const appended = await this.observations.append(
        {
          userId,
          holdingId: placement.holding.id,
          balance: checkpoint.amount,
          observedAt: checkpoint.at,
          source: checkpoint.legacySource,
          sourceMetadata: opens ? createdMeta : (checkpoint.legacyMeta ?? {}),
          role: 'checkpoint',
          authority: checkpoint.authority,
          inputId: input.id,
          cause: null,
        },
        tx
      );
      if (appended !== null) {
        checkpointsWritten += 1;
        appendedAt.push(checkpoint.at);
      }
    }

    const windowRecorded = await this.inputs.recordWindow(
      input.id,
      batch.window,
      batch.fetchedAt,
      tx
    );

    const writes: CacheWrite[] = [];
    if (batch.legacy.writesCache) {
      for (const placement of placements) {
        const balance =
          placement.close?.amount ??
          (placement.created
            ? createdBalance(batch.legacy.createdWithoutCheckpoint, placement.amounts)
            : null);
        if (balance !== null && !unchanged(placement, balance)) {
          writes.push({ holdingId: placement.holding.id, balance });
        }
      }
      await this.cacheWriter.apply(userId, writes, tx);
      const copy = batch.legacy.cacheObservation;
      if (copy !== null) {
        // Unlabelled and stamped now, as `updateHoldingBalance` wrote it: A1
        // reads it as a copy (O2) and excludes it.
        for (const write of writes) {
          await this.observations.append(
            {
              userId,
              holdingId: write.holdingId,
              balance: write.balance,
              observedAt: new Date(),
              source: copy.source,
              sourceMetadata: copy.meta,
            },
            tx
          );
        }
      }
    }
    if (batch.legacy.unhideOnNonZero) {
      // The import's own zero test, which reads an underflowing exponent as zero.
      await this.holdings.markShown(
        userId,
        placements
          .filter(
            (p) =>
              !p.created &&
              p.holding.isHidden &&
              p.close !== null &&
              Number.parseFloat(p.close.amount) !== 0
          )
          .map((p) => p.holding.id),
        tx
      );
    }

    const zeroed = await this.absences.apply(
      {
        batch,
        inputId: input.id,
        reportedTokenIds: new Set(batch.checkpoints.flatMap((c) => tokenOf(c.asset) ?? [])),
        absenceTokenOf: (asset) => tokens.tokenOf(asset, 'find-only'),
        checkpointed: placements.filter((p) => p.close !== null).map((p) => p.holding),
      },
      tx
    );

    for (const placement of placements) {
      await this.holdings.lowerStartsAt(userId, placement.holding.id, placement.earliest, tx);
    }
    // A zero is the provider's checkpoint (A1 rule O4), so its holding is a feed one.
    const flipped = await this.holdings.markFeed(
      userId,
      [
        ...new Set([
          ...placements.filter((p) => !p.created).map((p) => p.holding.id),
          ...zeroed.map((z) => z.holdingId),
        ]),
      ],
      tx
    );
    await this.relabelPersonValues(userId, flipped, tx);

    const created = placements.filter((p) => p.created);
    const noticeDetails: JobNotice[] = [
      ...batch.notices.map(toJobNotice),
      ...tokens.failureNotices(),
      ...entryHoldingFailures.map(toJobNotice),
      ...(demoted.size > 0 ? [toJobNotice(orphanedSwapLegsNotice(demoted.size))] : []),
      ...legs.failures.map(toJobNotice),
      ...(legs.unresolved > 0 ? [toJobNotice(unresolvedLegsNotice(legs.unresolved))] : []),
      ...(written.duplicatePlacements.length > 0
        ? [toJobNotice(duplicatePlacementNotice(written.duplicatePlacements.length))]
        : []),
      ...reviewSkipNotice(
        batch,
        tokens,
        carried,
        (asset) => placementOf(asset) === null && failedHolding(asset) === null
      ).map(toJobNotice),
      ...unheldCheckpointNotice(batch, tokenOf, placementOf, holdingFailureOf).map(toJobNotice),
      ...classified.notices.map(toJobNotice),
    ];
    const landedEntries = new Set(rows.map(({ entry }) => entry));
    return {
      userId,
      touchedHoldingIds: placements.map((p) => p.holding.id),
      createdHoldingIds: created.map((p) => p.holding.id),
      earliestChangedAt: earliestOf([
        written.earliestChangedAt,
        ...appendedAt,
        ...created.map((p) => p.earliest),
        ...classified.mirrorLegs.map((leg) => leg.at),
        ...zeroed.map((z) => z.at),
      ]),
      notices: noticeDetails.map((notice) => notice.text),
      noticeDetails,
      entryOutcomes: batch.entries.map((entry) =>
        landedEntries.has(entry) ? 'landed' : 'skipped'
      ),
      rowsSent: sent.length,
      inputId: input.id,
      entriesWritten: written.rows.length,
      merges: written.merges,
      checkpointsWritten,
      windowRecorded,
      mirrorHoldingIds: [...new Set(classified.mirrorLegs.map((leg) => leg.holdingId))],
      zeroedHoldingIds: zeroed.map((z) => z.holdingId),
      skippedAssets: skippedAssets(batch, tokens),
      checkpointOutcomes: batch.checkpoints.map(({ asset }) => {
        const tokenId = tokenOf(asset);
        const placement = placementOf(asset);
        const answer = tokens.answerOf(asset, mode);
        return {
          tokenId,
          holdingId: placement?.holding.id ?? null,
          created: placement?.created ?? false,
          failure:
            answer !== null && 'failed' in answer
              ? answer.failed
              : tokenId === null
                ? null
                : (holdingFailureOf(tokenId, asset.key) ?? null),
        };
      }),
      holdings: placements.map(({ holding }) => ({
        holdingId: holding.id,
        tokenId: holding.tokenId,
        cacheBalance: writes.find((write) => write.holdingId === holding.id)?.balance ?? null,
      })),
    };
  }

  /**
   * A1's Rule P, persisted on the holdings this batch made feed: a person value
   * at or after the holding's first feed evidence is a verification, and one
   * before it stays a snapshot. The rule is read off the classifier rather than
   * restated, so the role written is the one the backfill derives. Labels
   * only: no value, instant or balance moves.
   */
  private async relabelPersonValues(
    userId: string,
    holdingIds: readonly string[],
    tx: DatabaseTransaction
  ): Promise<void> {
    if (holdingIds.length === 0) return;
    const raws = await this.evidence.findHoldingEvidence({ userId, holdingIds }, tx);
    const ids = raws.flatMap((raw) => {
      const snapshots = new Set(
        raw.observations.filter((o) => o.role === 'snapshot').map((o) => o.id)
      );
      return classifyHoldingEvidence(raw)
        .evidence.observations.filter((o) => o.role === 'verification' && snapshots.has(o.id))
        .map((o) => o.id);
    });
    await this.observations.markVerifications(userId, ids, tx);
  }
}
