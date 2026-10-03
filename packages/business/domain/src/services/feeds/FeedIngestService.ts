import { type DatabaseTransaction, getDb } from '@scani/db';
import type { Holding, HoldingTransaction, NewHoldingTransaction } from '@scani/db/schema';
import { type JobNotice, toJobNotice } from '@scani/providers/core/types';
import { Container, Service } from 'typedi';
import {
  orphanedSwapLegsNotice,
  type SwapLeg,
  settleSwapGroups,
} from '../../lib/transactions/swap-groups';
import { identityCacheKey } from '../../lib/transactions/token-identity-key';
import {
  ownFeeLegFor,
  settlementLegsFor,
  settlementRow,
  tradesWithReportedCashSide,
} from '../../lib/transactions/trade-settlement';
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
import { walletReviewSkipNotice } from '../transactions/transaction-sources';
import { type AssetResolution, AssetResolver, assetKey } from './AssetResolver';
import { type BatchProblem, validateBatch } from './blocks/validate-batch';
import { FeedClassifier } from './classification/FeedClassifier';
import { deterministicUuid } from './deterministic-id';
import type {
  AssetRef,
  DecimalString,
  FeedBatch,
  FeedCheckpoint,
  FeedEntry,
  LegacyBatchOptions,
} from './feed-batch';
import { type CacheWrite, HoldingCacheWriter } from './HoldingCacheWriter';
import { HoldingResolver } from './HoldingResolver';
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
  skippedAssets: Array<{ symbol: string; reason: string }>;
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

/** One holding's share of a batch. */
interface Placement {
  holding: Holding;
  created: boolean;
  /** The earliest instant the batch carries for the holding. */
  earliest: Date;
  /** Its entries' amounts, as the batch sent them. */
  amounts: DecimalString[];
  /** Its latest checkpoint; at one instant, the last the batch sent. */
  close: FeedCheckpoint | null;
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

type HoldingPolicy = LegacyBatchOptions['holdingPolicy'];

/**
 * One batch's tokens, each asset resolved once per mode: a find-only miss
 * must not answer a create-on-miss lookup of the same token.
 */
class BatchTokens {
  private readonly answers = new Map<string, { asset: AssetRef; answer: AssetResolution }>();

  constructor(private readonly resolver: AssetResolver) {}

  async resolve(asset: AssetRef, mode: HoldingPolicy, tx: DatabaseTransaction | undefined) {
    const key = JSON.stringify([mode, assetKey(asset)]);
    if (!this.answers.has(key)) {
      this.answers.set(key, { asset, answer: await this.resolver.resolve(asset, mode, tx) });
    }
  }

  answerOf(asset: AssetRef, mode: HoldingPolicy): AssetResolution | null {
    return this.answers.get(JSON.stringify([mode, assetKey(asset)]))?.answer ?? null;
  }

  tokenOf(asset: AssetRef | undefined, mode: HoldingPolicy): string | null {
    const answer = asset === undefined ? null : this.answerOf(asset, mode);
    return answer !== null && 'tokenId' in answer ? answer.tokenId : null;
  }

  /**
   * One line per asset whose lookup threw, however many entries name it (R35).
   * The frame is keyed and the upstream message rides in it verbatim (SC-434).
   */
  failureNotices(): JobNotice[] {
    const lines = new Map<string, JobNotice>();
    for (const { asset, answer } of this.answers.values()) {
      if ('failed' in answer && !lines.has(assetKey(asset))) {
        const identity = asset.identity.symbol;
        lines.set(assetKey(asset), {
          key: 'v3.jobs.notices.tokenIdentityFailed',
          params: { identity, error: answer.failed },
          text: `Failed to resolve token identity ${identity}: ${answer.failed}`,
        });
      }
    }
    return [...lines.values()];
  }
}

/** A row to upsert and, for a leg, the external id of the row it settles. */
interface LedgerRow {
  row: NewHoldingTransaction;
  settles: string | undefined;
}

/** The router's line for a holding it could not find or create, once per event or leg it dropped. */
const holdingFailedNotice = (tokenId: string, message: string) =>
  `Failed to resolve holding for token ${tokenId}: ${message}`;

const unresolvedLegsNotice = (count: number) =>
  `Skipped ${count} settlement leg(s): the holding for their currency could not be resolved, so those trades are recorded without their cash side and that cash balance will not reconcile.`;

const parentKey = (source: string, externalId: string) => JSON.stringify([source, externalId]);

/** Drops a leg whose row is not among `entries`: a leg exists only beside the row it settles. */
function withParents(entries: readonly FeedEntry[]): FeedEntry[] {
  const parents = new Set(
    entries
      .filter((entry) => entry.settlesExternalId === undefined)
      .map((entry) => parentKey(entry.legacy.source, entry.externalId))
  );
  return entries.filter(
    (entry) =>
      entry.settlesExternalId === undefined ||
      parents.has(parentKey(entry.legacy.source, entry.settlesExternalId))
  );
}

/**
 * Gives each swap whose legs all landed one group id, and turns a lone leg back
 * into the transfer it was, by the router's rule (`settleSwapGroups`, SC-332).
 * Returns the entries it demoted.
 */
function settleSwaps<T extends SwapLeg>(
  legs: ReadonlyArray<{ entry: FeedEntry; row: T }>,
  groupIdOf: (key: string) => string
): Set<FeedEntry> {
  const groups = new Map<string, T[]>();
  for (const { entry, row } of legs) {
    if (!entry.groupKey) continue;
    const siblings = groups.get(entry.groupKey);
    if (siblings) siblings.push(row);
    else groups.set(entry.groupKey, [row]);
  }
  const demoted = new Set<SwapLeg>(settleSwapGroups(groups, groupIdOf));
  return new Set(legs.filter(({ row }) => demoted.has(row)).map(({ entry }) => entry));
}

/**
 * The tokens a landed entry's row references besides its own, created on miss
 * (SC-332). Demotion nulls a leg's counter and both its quotes, so a demoted
 * leg resolves only its fee and leaves no other token row behind (R33).
 */
function legacyAssetsOf(entry: FeedEntry, demoted: boolean): AssetRef[] {
  const { counter, fee, priceQuote, counterPriceQuote } = entry.legacyAssets ?? {};
  return (demoted ? [fee] : [counter, fee, priceQuote, counterPriceQuote]).filter(
    (asset): asset is AssetRef => asset !== undefined
  );
}

/** An entry as `settleSwapGroups` reads it, settled and thrown away to learn which legs it demotes. */
function swapDraft(entry: FeedEntry): SwapLeg {
  return {
    kind: entry.legacy.kind,
    quantity: entry.amount,
    swapGroupId: null,
    counterTokenId: null,
    counterQuantity: entry.legacy.counterQuantity ?? null,
    priceNative: entry.legacy.priceNative ?? null,
    priceNativeTokenId: null,
  };
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
  private readonly resolver = Container.get(HoldingResolver);
  private readonly holdings = Container.get(HoldingRepository);
  private readonly ledger = Container.get(HoldingTransactionRepository);
  private readonly observations = Container.get(HoldingBalanceObservationRepository);
  private readonly cacheWriter = Container.get(HoldingCacheWriter);
  private readonly evidence = Container.get(EngineEvidenceRepository);
  private readonly classifier = Container.get(FeedClassifier);

  /**
   * Writes the batch in the caller's transaction, or in its own, so a failure
   * anywhere writes nothing and records no window. A batch the validator
   * refuses throws `FeedBatchRejected` before anything is read.
   *
   * An entry lands when its asset resolves and its holding is found, or
   * created under `holdingPolicy: 'create'`. Otherwise it is skipped with the
   * legs that settle it, and so is a checkpoint; an asset that does not resolve
   * is reported, and a find-only skip is counted in `notices`. The rest is
   * written: swap legs paired under one id derived from the input and the
   * group key, a lone one demoted to a transfer, under `derivesTradeLegs` each
   * trade's cash and own-fee legs, and each leg pointed at the row it settles.
   *
   * The cache is written where today's import wrote it (D-1): a checkpointed
   * holding takes its latest checkpoint, a holding the batch created takes the
   * batch's rule, and an existing holding with no checkpoint keeps its balance.
   * Beside each cache write goes the batch's `cacheObservation`, when it names
   * one.
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
      throw new Error(`FeedIngestService: user ${userId} has no account ${accountId}`);
    }
    const tokens = new BatchTokens(this.assets);
    if (tx) return await this.write(batch, tx, tokens);
    // Creating a token can ask every identity provider over the network, so the
    // batch plans its landing once before its own transaction opens, against
    // the holdings as they are now, and finds or creates its tokens there. The
    // write takes the same plan and reads each answer back, asking again only
    // for an entry this pass did not land (R34, R34b). A token created here
    // outlives a batch that then fails, as it always has.
    await this.planLanding(
      batch,
      tokens,
      (carried) => this.locateBeforeWrite(batch, tokens, carried),
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
    const tokenOf = (asset: AssetRef) => tokens.tokenOf(asset, batch.legacy.holdingPolicy);
    const { carried, landed, where } = await this.planLanding(
      batch,
      tokens,
      async (carried) => {
        const placed = await this.place(batch, carried, tokenOf, tx);
        return { ...placed, lands: (asset: AssetRef) => placed.placementOf(asset) !== null };
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

    const rows = landed.flatMap((entry) => {
      const placement = placementOf(entry.asset);
      if (placement === null) return [];
      placement.amounts.push(entry.amount);
      return [{ entry, row: this.ledgerRow(entry, placement.holding, input.id) }];
    });
    const demoted = settleSwaps(rows, (key) => deterministicUuid(input.id, key));
    for (const { entry, row } of rows) {
      const { counter, fee, priceQuote, counterPriceQuote } = entry.legacyAssets ?? {};
      row.feeTokenId = tokens.tokenOf(fee, 'create');
      if (demoted.has(entry)) {
        row.counterPriceNative = null;
      } else {
        row.counterTokenId = tokens.tokenOf(counter, 'create');
        row.priceNativeTokenId = tokens.tokenOf(priceQuote, 'create');
        row.counterPriceNativeTokenId = tokens.tokenOf(counterPriceQuote, 'create');
      }
    }
    const legs = batch.legacy.derivesTradeLegs
      ? await this.deriveTradeLegs(
          rows.map(({ row }) => row),
          { placeLeg, holdingFailureOf },
          input.id
        )
      : { rows: [], unresolved: 0, failures: [] };
    const sent: LedgerRow[] = [
      ...rows.map(({ entry, row }) => ({ row, settles: entry.settlesExternalId })),
      ...legs.rows,
    ];
    // Labelled by the upsert itself, and the legs again once linked (D-5).
    const written = await this.ledger.bulkUpsert(
      sent.map(({ row }) => row),
      tx
    );
    await this.linkLegs(userId, sent, written.rows, tx);
    const classified = await this.classifier.classify(
      {
        userId,
        inputId: input.id,
        accountId: batch.input.accountId,
        rowIds: written.rows.map((row) => row.id),
      },
      tx
    );
    const placements = [...placementsByHolding.values()];

    let checkpointsWritten = 0;
    const appendedAt: Date[] = [];
    for (const checkpoint of batch.checkpoints) {
      const placement = placementOf(checkpoint.asset);
      if (placement === null) continue;
      if (placement.close === null || checkpoint.at >= placement.close.at) {
        placement.close = checkpoint;
      }
      const appended = await this.observations.append(
        {
          userId,
          holdingId: placement.holding.id,
          balance: checkpoint.amount,
          observedAt: checkpoint.at,
          source: checkpoint.legacySource,
          sourceMetadata: checkpoint.legacyMeta ?? {},
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
        if (balance !== null) writes.push({ holdingId: placement.holding.id, balance });
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

    for (const placement of placements) {
      await this.holdings.lowerStartsAt(userId, placement.holding.id, placement.earliest, tx);
    }
    const flipped = await this.holdings.markFeed(
      userId,
      placements.filter((p) => !p.created).map((p) => p.holding.id),
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
      ...this.reviewSkipNotice(
        batch,
        tokens,
        carried,
        (asset) => placementOf(asset) === null && failedHolding(asset) === null
      ).map(toJobNotice),
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
      skippedAssets: this.skippedAssets(batch, tokens),
      holdings: placements.map(({ holding }) => ({
        holdingId: holding.id,
        tokenId: holding.tokenId,
        cacheBalance: writes.find((write) => write.holdingId === holding.id)?.balance ?? null,
      })),
    };
  }

  /**
   * The one decision of which entries land (R34b), taken before ingest's own
   * transaction opens and again inside it. The batch's own assets resolve under
   * its policy; an entry lands when its asset resolved and `locate` gives it a
   * holding, and a leg lands only beside the row it settles. Then the tokens
   * the landed rows reference besides their own are found or created, a
   * demoted leg's counter and quotes excepted (R32, R33). Every answer stays in
   * `tokens`, so a second pass asks again only where the first did not.
   */
  private async planLanding<Where extends { lands(asset: AssetRef): boolean }>(
    batch: FeedBatch,
    tokens: BatchTokens,
    locate: (carried: readonly FeedEntry[]) => Promise<Where>,
    tx: DatabaseTransaction | undefined
  ): Promise<{ carried: FeedEntry[]; landed: FeedEntry[]; where: Where }> {
    const policy = batch.legacy.holdingPolicy;
    const assets = [...batch.entries.map((e) => e.asset), ...batch.checkpoints.map((c) => c.asset)];
    for (const asset of assets) await tokens.resolve(asset, policy, tx);
    const carried = withParents(
      batch.entries.filter((entry) => tokens.tokenOf(entry.asset, policy) !== null)
    );
    const where = await locate(carried);
    const landed = withParents(carried.filter((entry) => where.lands(entry.asset)));
    const demoted = settleSwaps(
      landed.map((entry) => ({ entry, row: swapDraft(entry) })),
      () => ''
    );
    for (const entry of landed) {
      for (const asset of legacyAssetsOf(entry, demoted.has(entry))) {
        await tokens.resolve(asset, 'create', tx);
      }
    }
    return { carried, landed, where };
  }

  /**
   * Where the plan taken before the transaction lands an entry: under 'create'
   * wherever its asset resolved, since the write finds or creates the holding;
   * under find-only where the holding is there now, by the path's own matching.
   */
  private async locateBeforeWrite(
    batch: FeedBatch,
    tokens: BatchTokens,
    carried: readonly FeedEntry[]
  ): Promise<{ lands(asset: AssetRef): boolean }> {
    const policy = batch.legacy.holdingPolicy;
    if (policy === 'create') return { lands: () => true };
    const held = new Map<string, boolean>();
    for (const { asset } of carried) {
      const tokenId = tokens.tokenOf(asset, policy);
      if (tokenId === null || held.has(tokenId)) continue;
      const find = this.resolver.findFeedHolding(
        {
          userId: batch.userId,
          accountId: batch.input.accountId,
          tokenId,
          match: batch.legacy.holdingMatch,
        },
        undefined
      );
      // A find that throws under skip-entry is tried again by the write, in
      // its savepoint, which skips and reports it there (R37).
      const holding =
        batch.legacy.holdingFailure === 'skip-entry' ? await find.catch(() => null) : await find;
      held.set(tokenId, holding !== null);
    }
    return {
      lands: (asset) => {
        const tokenId = tokens.tokenOf(asset, policy);
        return tokenId !== null && held.get(tokenId) === true;
      },
    };
  }

  /** Each of the batch's own assets that did not resolve, once. */
  private skippedAssets(batch: FeedBatch, tokens: BatchTokens): IngestResult['skippedAssets'] {
    const skipped = new Map<string, IngestResult['skippedAssets'][number]>();
    const assets = [...batch.entries.map((e) => e.asset), ...batch.checkpoints.map((c) => c.asset)];
    for (const asset of assets) {
      const answer = tokens.answerOf(asset, batch.legacy.holdingPolicy);
      if (answer === null || 'tokenId' in answer || skipped.has(assetKey(asset))) continue;
      skipped.set(assetKey(asset), {
        symbol: asset.identity.symbol,
        reason: 'skipped' in answer ? answer.skipped : answer.failed,
      });
    }
    return [...skipped.values()];
  }

  /**
   * Under find-only, the entries skipped because the catalog lacks their token
   * or the account lacks its holding, counted as the router counts them: per
   * entry, over the tokens they name, an unknown token by the router's own
   * identity key and an unheld one by its id (R36). A leg skipped with its row
   * is not one of them, and neither is an entry whose token lookup or holding
   * failed: each has its own line.
   */
  private reviewSkipNotice(
    batch: FeedBatch,
    tokens: BatchTokens,
    carried: readonly FeedEntry[],
    unheld: (asset: AssetRef) => boolean
  ): string[] {
    if (batch.legacy.holdingPolicy !== 'find-only') return [];
    const carriedSet = new Set(carried);
    const byToken = new Set<string>();
    let events = 0;
    for (const entry of batch.entries) {
      const answer = tokens.answerOf(entry.asset, 'find-only');
      if (answer === null || 'failed' in answer) continue;
      const token =
        'skipped' in answer
          ? identityCacheKey(entry.asset.identity)
          : carriedSet.has(entry) && unheld(entry.asset)
            ? answer.tokenId
            : null;
      if (token === null) continue;
      events += 1;
      byToken.add(token);
    }
    return events > 0 ? [walletReviewSkipNotice(events, byToken.size)] : [];
  }

  /**
   * Each landed trade's cash leg and own-token fee leg, by the rules the
   * transaction router applied (SC-1452, SC-1453, SC-1486), on the resolved
   * rows after the swaps settle: a lone swap leg is a transfer by then and
   * must not be read as a trade. A leg is placed by the batch's own matching
   * and policy; one with no holding (none under find-only, or one that failed,
   * R37) is skipped and counted, and its trade lands without it.
   */
  private async deriveTradeLegs(
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
   * Points each leg at the row it settles, both written by this batch. A leg
   * whose external id two of the batch's rows answer to is left unlinked here.
   * `linkSettlements`, where a caller runs it, then links it to an arbitrary
   * one of the two: its `UPDATE … FROM` matches both and takes whichever row
   * Postgres reaches first.
   */
  private async linkLegs(
    userId: string,
    rows: readonly LedgerRow[],
    written: readonly HoldingTransaction[],
    tx: DatabaseTransaction
  ): Promise<void> {
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
    const links = rows.flatMap(({ row, settles }) => {
      if (settles === undefined) return [];
      const legId = idOf.get(rowKey(row));
      const parents = [...(parentIds.get(parentKey(row.source, settles)) ?? [])];
      return legId !== undefined && parents.length === 1 ? [{ legId, parentId: parents[0]! }] : [];
    });
    await this.ledger.linkLegs(userId, links, tx);
  }

  /**
   * The holding each resolved asset writes into, found or created once, at the
   * earliest instant the batch carries for it. Two refs the path's matching
   * puts on one holding share its placement. `placeLeg` places a derived leg
   * the same way, on its token's placement when the batch already has one.
   *
   * Under `holdingFailure: 'skip-entry'` each holding is found or created in
   * a savepoint, so a database error there aborts only that holding: its
   * entries and legs are skipped, the error is kept for the notice, and the
   * holding is not tried again in this batch (R37).
   */
  private async place(
    batch: FeedBatch,
    entries: readonly FeedEntry[],
    tokenOf: (asset: AssetRef) => string | null,
    tx: DatabaseTransaction
  ) {
    const groupOf = (tokenId: string, key: string | null) => JSON.stringify([tokenId, key]);
    const groups = new Map<string, { tokenId: string; key: string | null; earliest: Date }>();
    const instants: Array<{ asset: AssetRef; at: Date }> = [
      ...entries.map((e) => ({ asset: e.asset, at: e.occurredAt })),
      ...batch.checkpoints.map((c) => ({ asset: c.asset, at: c.at })),
    ];
    for (const { asset, at } of instants) {
      const tokenId = tokenOf(asset);
      if (tokenId === null) continue;
      const key = asset.key ?? null;
      const seen = groups.get(groupOf(tokenId, key));
      if (seen === undefined) groups.set(groupOf(tokenId, key), { tokenId, key, earliest: at });
      else if (at < seen.earliest) seen.earliest = at;
    }

    const create =
      batch.legacy.holdingPolicy === 'find-only'
        ? null
        : { source: batch.legacy.holdingSource, arrival: batch.legacy.arrival };
    const holdingOfGroup = new Map<string, string>();
    const byHolding = new Map<string, Placement>();
    const failures = new Map<string, string>();
    const resolveGroup = async (
      tokenId: string,
      key: string | null,
      earliest: Date
    ): Promise<Placement | null> => {
      if (failures.has(groupOf(tokenId, key))) return null;
      const resolve = (within: DatabaseTransaction) =>
        this.resolver.resolveFeedHolding(
          {
            userId: batch.userId,
            accountId: batch.input.accountId,
            tokenId,
            key,
            match: batch.legacy.holdingMatch,
            create,
            at: earliest,
          },
          within
        );
      let resolved: Awaited<ReturnType<typeof resolve>>;
      if (batch.legacy.holdingFailure === 'fail-batch') {
        resolved = await resolve(tx);
      } else {
        try {
          resolved = await tx.transaction(resolve);
        } catch (error) {
          failures.set(
            groupOf(tokenId, key),
            error instanceof Error ? error.message : String(error)
          );
          return null;
        }
      }
      if (resolved === null) {
        if (create === null) return null;
        throw new Error(`FeedIngestService: no holding was found or created for token ${tokenId}`);
      }
      holdingOfGroup.set(groupOf(tokenId, key), resolved.holding.id);
      const shared = byHolding.get(resolved.holding.id);
      if (shared === undefined) {
        const placement = { ...resolved, earliest, amounts: [], close: null };
        byHolding.set(resolved.holding.id, placement);
        return placement;
      }
      if (earliest < shared.earliest) shared.earliest = earliest;
      return shared;
    };
    for (const { tokenId, key, earliest } of groups.values()) {
      await resolveGroup(tokenId, key, earliest);
    }

    const placed = (tokenId: string, key: string | null): Placement | null => {
      const holdingId = holdingOfGroup.get(groupOf(tokenId, key));
      return holdingId === undefined ? null : (byHolding.get(holdingId) ?? null);
    };
    const placementOf = (asset: AssetRef): Placement | null => {
      const tokenId = tokenOf(asset);
      return tokenId === null ? null : placed(tokenId, asset.key ?? null);
    };
    const placeLeg = async (tokenId: string, at: Date): Promise<Placement | null> => {
      const placement = placed(tokenId, null);
      if (placement === null) return await resolveGroup(tokenId, null, at);
      if (at < placement.earliest) placement.earliest = at;
      return placement;
    };
    const holdingFailureOf = (tokenId: string, key?: string) =>
      failures.get(groupOf(tokenId, key ?? null));
    return { placementOf, placeLeg, holdingFailureOf, placementsByHolding: byHolding };
  }

  /** Today's legacy columns as given, then every column a contract field or this write owns. */
  private ledgerRow(entry: FeedEntry, holding: Holding, inputId: string): NewHoldingTransaction {
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
