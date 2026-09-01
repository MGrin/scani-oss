/**
 * BackfillHistoricalPricesUseCase
 *
 * Identifies (token, date) pairs that need a daily-close price and runs
 * them through HistoricalPriceBackfillService. Scoped deliberately to
 * only the tokens users actually hold, in the user's base currency(s),
 * to keep request volume proportional to value delivered.
 *
 * Called from:
 *  - apps/backend/worker/src/processors/historical-price-backfill.ts (nightly)
 *  - apps/backend/worker/src/processors/ingest-transactions.ts (after an
 *    ingester populates new tx occurred_at dates)
 */

import { withAdvisoryLock } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { TokenRepository } from '../repositories/TokenRepository';
import { HistoricalPriceBackfillService } from '../services';
import { rollupLockKey } from './RollupPortfolioValueDailyUseCase';

const logger = createComponentLogger('use-case:backfill-historical-prices');

// Cooldown applied when a token's entire requested backfill range comes
// back empty. 7 days balances "stop hammering providers" against "give
// a newly-listed token a chance to start showing up." Tunable here.
const UNPRICEABLE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// Don't apply the cooldown for short ranges — a 5-day backfill that
// happens to land on a holiday weekend should not blocklist a stock for
// a week. 30 days of consecutive misses is the floor.
const UNPRICEABLE_MIN_RANGE_DAYS = 30;

export interface BackfillSummary {
  attempted: number;
  inserted: number;
  alreadyHad: number;
  providerMissing: number;
  // Tokens we skipped entirely because they're inside an unpriceable
  // cooldown window from a previous failed backfill.
  skippedUnpriceable: number;
  // Tokens whose providers ERRORED rather than answering. Deliberately
  // not folded into `providerMissing`: that number reads as "nobody has
  // this data", and these are runs that never found out. A non-zero
  // value here is an upstream or request problem to investigate, not a
  // fact about the tokens.
  attemptsFailed: number;
  // True when the per-user advisory lock was already held — another
  // backfill or rollup is in flight for this user, so we no-oped.
  // Caller (typically the user job processor) can re-queue a delayed
  // retry rather than reporting an empty success.
  skippedDueToLock?: boolean;
  // Only set by `planOnly`. The per-token windows this run WOULD have
  // requested, so an operator can read them before any provider is
  // called rather than inferring them from what came back.
  plan?: BackfillPlanEntry[];
  durationMs: number;
}

/** postgres.js hands aggregate timestamps back as either a Date or a string
 *  depending on the driver path; both reach the window arithmetic below. */
function toDate(value: Date | string | null): Date | null {
  if (value instanceof Date) return value;
  return value ? new Date(value) : null;
}

/** One token's intended request window, for `planOnly` runs. */
interface BackfillPlanEntry {
  tokenId: string;
  /** Days with no price row — what the range fetch is actually for. */
  missingDays: number;
  /**
   * Inclusive bounds of those days, `null` when `missingDays` is 0.
   *
   * A candidate token with **nothing to request** is in this list on
   * purpose. Reporting only the tokens with work leaves the interesting
   * failure invisible: a token whose per-token start resolved later than
   * its first transaction has an empty window and looks identical to a
   * token that is fully priced. That is the shape of the bug this whole
   * ticket is made of, so the plan has to be able to say "considered, asked
   * for nothing" out loud.
   */
  from: Date | null;
  to: Date | null;
  /** The token's earliest transaction, as discovery resolved it. `null` when
   *  it has no `holding_coverage` row and fell back to the lookback window —
   *  which is itself worth seeing, because that fallback is what the fixed
   *  5-year floor used to truncate. */
  firstTxAt: Date | null;
}

@Service()
export class BackfillHistoricalPricesUseCase {
  // Class-field DI — see note in BalanceAtTimeService.ts.
  private readonly backfillService = Container.get(HistoricalPriceBackfillService);
  private readonly tokenRepository = Container.get(TokenRepository);

  // Walks every user's held tokens, identifies dates where we have a
  // transaction but no nearby daily price, and runs the backfill.
  // Idempotent — re-running does no harm because the service short-circuits
  // on existing daily prices within a 24h window.
  async execute(
    opts: {
      usdTokenId: string;
      lookbackDays?: number;
      // Scope to a single user — when set, both the holdings and
      // transactions discovery queries filter by user_id, so the
      // candidate set covers only this user's tokens.
      userId?: string;
      // Restrict to specific tokens — applied after the held/tx union,
      // before the existing-price-dedup. Useful for the manual-create
      // follow-up flow that wants to backfill exactly the tokens the
      // user just added.
      tokenIds?: string[];
      /** Compute the per-token windows and return WITHOUT calling any
       *  provider or writing a row. What `--dry-run` is made of. */
      planOnly?: boolean;
    } = { usdTokenId: '' }
  ): Promise<BackfillSummary> {
    if (!opts.usdTokenId) {
      throw new Error('BackfillHistoricalPricesUseCase.execute requires opts.usdTokenId');
    }
    // Per-user mode: take the same advisory lock the rollup uses, so a
    // manual "Recompute" click during the 04:00 cron rollup or the 03:00
    // historical-price-backfill cron no-ops cleanly instead of racing
    // on the same token_prices rows.
    if (opts.userId) {
      const outcome = await withAdvisoryLock(rollupLockKey(opts.userId), () =>
        this.executeLocked(opts)
      );
      if (outcome.ran) return outcome.result;
      logger.info(
        { userId: opts.userId },
        'Backfill skipped — rollup/backfill already in flight for this user'
      );
      return {
        attempted: 0,
        inserted: 0,
        alreadyHad: 0,
        providerMissing: 0,
        skippedUnpriceable: 0,
        attemptsFailed: 0,
        skippedDueToLock: true,
        durationMs: 0,
      };
    }
    return this.executeLocked(opts);
  }

  private async executeLocked(opts: {
    usdTokenId: string;
    lookbackDays?: number;
    userId?: string;
    tokenIds?: string[];
    planOnly?: boolean;
  }): Promise<BackfillSummary> {
    const start = Date.now();
    const lookback = opts.lookbackDays ?? 365 * 5;
    const since = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000);

    // Identify (token, date) pairs we need.
    //
    // Strategy: cross-product every token the user *has ever held*
    // (union of `holdings.token_id` with `holding_transactions.token_id`)
    // against every day in the lookback window, MINUS days that already
    // have a daily price within ±24h.
    //
    // Why not just tx-days? The rollup prices the portfolio at every
    // day in the lookback window, not just days the user transacted.
    // If the user's last BTC trade was in November 2025, the old
    // tx-only candidate set stored prices up to November and the
    // rollup then used November's $118k BTC close as the price for
    // every subsequent day — producing a flat chart and a wildly
    // wrong current-day total when the live price diverged. Covering
    // every day eliminates both problems.
    //
    // Scale: ~N_tokens × lookbackDays candidates. With the in-memory
    // per-pair cache in ExchangeKlinesProvider (one HTTP call per
    // pair covers ~720 daily bars from Kraken) and Frankfurter's
    // generous free tier, this fits easily inside the cron window
    // for users with tens of tokens.
    // Build the candidate set with three plain Drizzle queries + an
    // in-memory cross-product. Clearer than the previous raw-SQL CTE
    // (which was misparsing param order in postgres.js) and still
    // cheap: three indexed queries plus a Map-based dedup over a few
    // thousand rows.
    //   1. Every token the user has ever held (union of holdings
    //      + holding_transactions).
    //   2. Existing daily-granularity price rows in the lookback
    //      window (so we can skip candidates we already priced).
    //   3. generate_series in JS for the date list.
    // Per-token lifetime, derived from `holding_coverage`. Lets the
    // cross-product below walk only the days where the user actually
    // held the token — for closed positions, we don't need to keep
    // pricing them through to today. Tokens whose holding_coverage
    // row hasn't been populated (~22 % of prod holdings as of 2026-05)
    // fall back to the ledger itself, below.
    const lifetimeRows = await db
      .select({
        tokenId: schema.holdings.tokenId,
        firstTxAt: sql<Date | null>`MIN(${schema.holdingCoverage.firstTxAt})`,
        lastTxAt: sql<Date | null>`MAX(${schema.holdingCoverage.lastTxAt})`,
        stillHeld: sql<boolean>`BOOL_OR(${schema.holdings.balance}::numeric > 0)`,
      })
      .from(schema.holdings)
      .leftJoin(schema.holdingCoverage, eq(schema.holdingCoverage.holdingId, schema.holdings.id))
      .where(opts.userId ? eq(schema.holdings.userId, opts.userId) : undefined)
      .groupBy(schema.holdings.tokenId);
    const tokenLifetime = new Map<
      string,
      { firstTxAt: Date | null; lastTxAt: Date | null; stillHeld: boolean }
    >();
    for (const row of lifetimeRows) {
      tokenLifetime.set(row.tokenId, {
        firstTxAt: toDate(row.firstTxAt),
        lastTxAt: toDate(row.lastTxAt),
        stillHeld: row.stillHeld === true,
      });
    }

    // The same lifetime, read off the ledger instead of off the summary
    // of it. This is also the token-discovery query — it carries no date
    // bound because the bound it used to carry depends on the start dates
    // it is being read to derive.
    const txLifetimeRows = await db
      .select({
        tokenId: schema.holdingTransactions.tokenId,
        firstTxAt: sql<Date | null>`MIN(${schema.holdingTransactions.occurredAt})`,
        lastTxAt: sql<Date | null>`MAX(${schema.holdingTransactions.occurredAt})`,
      })
      .from(schema.holdingTransactions)
      .where(opts.userId ? eq(schema.holdingTransactions.userId, opts.userId) : undefined)
      .groupBy(schema.holdingTransactions.tokenId);

    // A missing `holding_coverage` row used to send the token to the full
    // 1,826-day lookback — the widest window in the run, applied to exactly
    // the tokens we know least about. On a production dry run that was about
    // half the missing days and half the provider requests, spent establishing
    // that a set of memecoins has no price feed (SC-229).
    //
    // Coverage stays the authority where it exists; only a NULL falls
    // through to here. Both ends fall through together, so a closed
    // position without coverage gets the same lifetime bound as one with it.
    for (const row of txLifetimeRows) {
      const existing = tokenLifetime.get(row.tokenId);
      if (!existing) {
        // No `holdings` row for a token that has transactions — the FK
        // makes this unreachable, and if it ever is, an open-ended window
        // is what the token had before.
        tokenLifetime.set(row.tokenId, {
          firstTxAt: toDate(row.firstTxAt),
          lastTxAt: null,
          stillHeld: true,
        });
        continue;
      }
      if (!existing.firstTxAt) existing.firstTxAt = toDate(row.firstTxAt);
      if (!existing.lastTxAt) existing.lastTxAt = toDate(row.lastTxAt);
    }

    // Earliest day any candidate token can need. `since` is the default
    // for tokens with neither a coverage row nor a transaction; a token
    // whose first transaction predates it reaches back to that transaction
    // instead, so discovery and the existing-price dedup below have to
    // reach at least as far back as the earliest per-token start or they
    // would re-request days we already hold.
    let earliestFirstTx: Date | null = null;
    for (const lifetime of tokenLifetime.values()) {
      const first = lifetime.firstTxAt;
      if (!first) continue;
      if (earliestFirstTx === null || first < earliestFirstTx) earliestFirstTx = first;
    }
    const discoverySince = earliestFirstTx && earliestFirstTx < since ? earliestFirstTx : since;

    const heldTokens = await db
      .select({ tokenId: schema.holdings.tokenId })
      .from(schema.holdings)
      .where(opts.userId ? eq(schema.holdings.userId, opts.userId) : undefined)
      .groupBy(schema.holdings.tokenId);
    const userTokenSet = new Set<string>();
    for (const r of heldTokens) userTokenSet.add(r.tokenId);
    for (const r of txLifetimeRows) userTokenSet.add(r.tokenId);
    userTokenSet.delete(opts.usdTokenId); // base → identity; skip
    if (opts.tokenIds && opts.tokenIds.length > 0) {
      const restrict = new Set(opts.tokenIds);
      for (const id of [...userTokenSet]) {
        if (!restrict.has(id)) userTokenSet.delete(id);
      }
    }

    // Drop tokens still inside an unpriceable cooldown — a previous
    // backfill couldn't get prices, no provider has changed since, no
    // point asking again. Cooldown is cleared on the next successful
    // backfill (e.g. a new provider added, or the token started trading).
    const now = new Date();
    const unpriceable = await this.tokenRepository.findUnpriceableTokenIds(now);
    let skippedUnpriceable = 0;
    for (const id of [...userTokenSet]) {
      if (unpriceable.has(id)) {
        userTokenSet.delete(id);
        skippedUnpriceable++;
      }
    }

    const existing = await db
      .select({
        tokenId: schema.tokenPrices.tokenId,
        // Bucket to day in SQL so the JS set key matches the series
        // format, which is built at midnight UTC.
        //
        // The `AT TIME ZONE` pair is load-bearing: `date_trunc('day', ts)`
        // on a `timestamptz` buckets in the SESSION timezone, which nothing
        // in this repo pins. On a connection an hour east of UTC every key
        // here lands a day off the ones built below, the dedup matches
        // nothing, and the run re-requests days it already holds. Prod's
        // sessions are UTC, so this is identical there — that is the point,
        // the correctness stops depending on a server setting nobody set.
        //
        // We accept ANY granularity here ('daily' OR 'intraday' OR
        // 'tx-exact') — if some other path already wrote a price for
        // (token, day), there's no point hitting the provider again.
        // The previous version filtered to granularity='daily' only,
        // which let intraday rows from the hourly pricing job slip
        // past the dedup and forced redundant provider lookups.
        day: sql<Date>`date_trunc('day', ${schema.tokenPrices.timestamp} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      })
      .from(schema.tokenPrices)
      .where(
        and(
          eq(schema.tokenPrices.baseTokenId, opts.usdTokenId),
          gte(schema.tokenPrices.timestamp, discoverySince),
          ne(schema.tokenPrices.tokenId, opts.usdTokenId)
        )
      );
    const havePriced = new Set<string>();
    for (const r of existing) {
      const dt = r.day instanceof Date ? r.day : new Date(r.day as unknown as string);
      havePriced.add(`${r.tokenId}:${dt.toISOString().slice(0, 10)}`);
    }

    // Day series in JS. `since` is already midnight UTC of the earliest
    // day we want to cover; step by 86400000ms until today inclusive.
    const sinceDay = new Date(
      Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())
    );
    const today = new Date();
    const todayDay = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    );
    const dayMs = 86_400_000;
    const normalized: Array<{ tokenId: string; day: Date }> = [];
    let alreadyHadCount = 0;
    for (const tokenId of userTokenSet) {
      const lifetime = tokenLifetime.get(tokenId);
      // Bound per-token range by the holding's actual lifetime. UTC-day
      // floor on first_tx_at lines up with the candidate keys.
      //
      // The start is the token's FIRST TRANSACTION, not the later of that
      // and the lookback window. It used to be `Math.max(sinceDay,
      // firstDay)`, which silently truncated the range for anyone whose
      // history predated the fixed 5-year window — a bug with a start
      // date rather than a trigger, and one nobody would have connected
      // to the lookback constant when it fired. As of 2026-08-15 the
      // floor sat 21 days away from cutting the oldest receipt in
      // production (SC-171). `sinceDay` now applies only to a token with
      // neither a coverage row nor a transaction to read (SC-229).
      let tokenStart = sinceDay.getTime();
      let tokenEnd = todayDay.getTime();
      if (lifetime?.firstTxAt) {
        tokenStart = Date.UTC(
          lifetime.firstTxAt.getUTCFullYear(),
          lifetime.firstTxAt.getUTCMonth(),
          lifetime.firstTxAt.getUTCDate()
        );
      }
      if (!lifetime?.stillHeld && lifetime?.lastTxAt) {
        const lastDay = Date.UTC(
          lifetime.lastTxAt.getUTCFullYear(),
          lifetime.lastTxAt.getUTCMonth(),
          lifetime.lastTxAt.getUTCDate()
        );
        tokenEnd = Math.min(tokenEnd, lastDay);
      }
      for (let t = tokenStart; t <= tokenEnd; t += dayMs) {
        const dayAt = new Date(t);
        const key = `${tokenId}:${dayAt.toISOString().slice(0, 10)}`;
        if (havePriced.has(key)) {
          alreadyHadCount++;
          continue;
        }
        normalized.push({ tokenId, day: dayAt });
      }
    }

    logger.info(
      {
        pending: normalized.length,
        alreadyHad: alreadyHadCount,
        skippedUnpriceable,
        lookbackDays: lookback,
      },
      'Historical price backfill candidates identified'
    );

    const summary: BackfillSummary = {
      attempted: normalized.length,
      inserted: 0,
      alreadyHad: alreadyHadCount,
      providerMissing: 0,
      skippedUnpriceable,
      attemptsFailed: 0,
      durationMs: 0,
    };

    // Group candidates by tokenId so each token gets ONE range fetch
    // against its provider instead of one HTTP call per (token, day).
    // For range-aware providers (Finnhub, Yahoo, Frankfurter) this
    // collapses 365 sequential calls per token into one. For providers
    // without a range API (CoinGecko, DeFiLlama, Kraken historical)
    // backfillTokenRange falls back to parallel per-day calls within
    // the provider's own rate limiter — still much faster than the
    // old per-candidate loop because all days for one token now
    // share the limiter's bucket fill instead of being serialized.
    const daysByToken = new Map<string, Date[]>();
    for (const row of normalized) {
      const arr = daysByToken.get(row.tokenId);
      if (arr) arr.push(row.day);
      else daysByToken.set(row.tokenId, [row.day]);
    }
    const tokenIds = [...daysByToken.keys()];

    // Everything above is discovery — three indexed reads and a
    // cross-product in memory, no provider touched and no row written. So
    // `planOnly` can return the exact windows the run WOULD request,
    // computed by the same code that would request them. An operator
    // reading a plan derived some other way is reading a guess about this
    // one (SC-171).
    if (opts.planOnly) {
      // Every CANDIDATE, not every token with work — see `BackfillPlanEntry`.
      summary.plan = [...userTokenSet].map((tokenId) => {
        const days = (daysByToken.get(tokenId) ?? []).map((d) => d.getTime()).sort((a, b) => a - b);
        return {
          tokenId,
          missingDays: days.length,
          from: days.length > 0 ? new Date(days[0] as number) : null,
          to: days.length > 0 ? new Date(days[days.length - 1] as number) : null,
          firstTxAt: tokenLifetime.get(tokenId)?.firstTxAt ?? null,
        };
      });
      summary.durationMs = Date.now() - start;
      return summary;
    }

    // Cap fan-out so we don't open dozens of HTTP connections at
    // once when the same provider would handle them all anyway.
    // Different tokens land on different providers (each with its
    // own rate limiter), so 10 parallel tokens is the sweet spot:
    // covers the typical 5-10 distinct holdings without DOS-ing
    // any single provider.
    const TOKEN_CONCURRENCY = 10;
    // Nobody to ask is not the same as nobody has it.
    //
    // A process that never registered a historical pricer answers every day
    // with `providerMissing`, which reads identically to "we asked five
    // providers and none had this token" — and `inserted === 0` over a range
    // past the floor then marks every token unpriceable for a week. That is
    // the SC-171 ratchet rebuilt out of a boot mistake instead of a 400: a
    // one-shot runner missing `buildProviderRegistry` took ETH, BTC, SOL,
    // USDC and MATIC out of the nightly backfill in 1.4 seconds without
    // making a single HTTP call.
    //
    // Same rule `attemptFailed` already carries one layer down: a run that
    // never got an answer has established nothing and may not record one.
    const canAsk = Container.get(ProviderRegistry).getAllHistoricalPricers().length > 0;
    if (!canAsk) {
      logger.warn(
        { attempted: summary.attempted },
        'No historical price providers registered — backfilling nothing and marking nothing'
      );
    }

    const markUnpriceable: string[] = [];
    const clearUnpriceable: string[] = [];
    for (let i = 0; i < tokenIds.length; i += TOKEN_CONCURRENCY) {
      const batch = tokenIds.slice(i, i + TOKEN_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (tokenId) => {
          const days = daysByToken.get(tokenId) ?? [];
          return this.backfillService.backfillTokenRange(tokenId, opts.usdTokenId, days);
        })
      );
      for (let j = 0; j < settled.length; j++) {
        const result = settled[j];
        const tokenId = batch[j];
        if (result?.status === 'fulfilled') {
          summary.inserted += result.value.inserted;
          summary.providerMissing += result.value.providerMissing;
          if (tokenId) {
            const requested = daysByToken.get(tokenId)?.length ?? 0;
            if (result.value.inserted > 0) {
              clearUnpriceable.push(tokenId);
            } else if (result.value.attemptFailed) {
              // A run that never got an answer has established nothing.
              // Marking here is how a 400 from a malformed request took
              // ETH, BTC, AAPL and 117 other tokens out of the backfill
              // for a week at a time, re-marked on every retry, so the
              // gap that caused it could never close (SC-171). Only a
              // provider that answered — cleanly, with nothing — may
              // count toward this decision.
              summary.attemptsFailed++;
            } else if (canAsk && requested >= UNPRICEABLE_MIN_RANGE_DAYS) {
              markUnpriceable.push(tokenId);
            }
          }
        } else if (result?.status === 'rejected') {
          const days = daysByToken.get(tokenId ?? '') ?? [];
          summary.providerMissing += days.length;
          logger.warn(
            { tokenId, error: result.reason },
            'Per-token range backfill rejected; counted as provider-missing'
          );
        }
      }
    }

    // A cooldown only means anything for a token we have NEVER priced, and
    // until now only the read side knew that. `findNeverPricedInCooldownTokenIds`
    // — the method the rollup, holdings and valuation all consult — carries
    //
    //     NOT EXISTS (SELECT 1 FROM token_prices WHERE token_id = tokens.id)
    //
    // in its WHERE, so a mark on a token with stored rows was already inert
    // everywhere except here, where it silently removed the token from the
    // nightly backfill for a week. Same condition on the write, and the two
    // halves finally agree (SC-232).
    //
    // The bug this closes gets WORSE as the backfill gets better: a large
    // successful run is precisely what leaves a stubborn residual behind, so
    // `inserted === 0` over that residual marked the tokens the job had just
    // done the most work for. ETH carried a cooldown while holding 1,956
    // price rows back to 2021. Under this rule it inverts — the more a token
    // has, the less markable it becomes.
    const markable = await this.withoutStoredPrices(markUnpriceable);
    if (markable.length !== markUnpriceable.length) {
      logger.info(
        { considered: markUnpriceable.length, marked: markable.length },
        'Some tokens were not marked unpriceable because they already have stored prices'
      );
    }

    if (markable.length > 0 || clearUnpriceable.length > 0) {
      await this.tokenRepository.applyPricingResults({
        markUnpriceable: markable,
        clearUnpriceable,
        cooldownMs: UNPRICEABLE_COOLDOWN_MS,
        now,
      });
    }

    summary.durationMs = Date.now() - start;
    logger.info(
      { summary, markedUnpriceable: markable.length, cleared: clearUnpriceable.length },
      'Historical price backfill complete'
    );
    return summary;
  }

  /** The subset with no `token_prices` row at all — the only tokens a
   *  cooldown is meaningful for. Mirrors the `NOT EXISTS` in
   *  `TokenRepository.findNeverPricedInCooldownTokenIds`, which is the read
   *  side of the same rule (SC-232). */
  private async withoutStoredPrices(tokenIds: readonly string[]): Promise<string[]> {
    if (tokenIds.length === 0) return [];
    const priced = await db
      .selectDistinct({ tokenId: schema.tokenPrices.tokenId })
      .from(schema.tokenPrices)
      .where(inArray(schema.tokenPrices.tokenId, [...tokenIds]));
    const hasPrices = new Set(priced.map((row) => row.tokenId));
    return tokenIds.filter((id) => !hasPrices.has(id));
  }
}
