import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { Decimal } from '@scani/shared';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { balanceAt } from '../../engine/balance-at';
import { assetClassOf, readingPairsFor } from '../../engine/price-at';
import type { AssetClass } from '../../engine/types';
import { EngineEvidenceRepository } from '../../repositories/EngineEvidenceRepository';
import { classifyHoldingEvidence } from '../foundation/legacy-classification';
import { PriceHubResolver } from '../pricing/PriceHubResolver';
import { PriceReader } from '../pricing/PriceReader';
import { asEngineCalculator } from './engine-writer';

/** Whole histories held in memory at once, as history's batches (SC-1283). */
const EVIDENCE_BATCH = 25;

export interface CacheWrite {
  holdingId: string;
  /**
   * The figure the caller wrote evidence for. The engine's answer is what is
   * written (A5 D-1); when the two agree the caller's spelling is kept, `12.30`
   * and not `12.3` (U4), which the syncs compare as text to skip an unchanged
   * balance. A disagreement is logged. Absent where the caller wrote evidence
   * and states no balance (D-18).
   */
  balance?: string;
  /**
   * The instant `last_updated` takes, when the caller stamps one of its own;
   * now otherwise. Null keeps the stored instant, for a row restored as it was.
   */
  lastUpdated?: Date | null;
}

/**
 * The one writer of `holdings.balance` (A2 D-1), and since A5 the engine
 * calculator: it writes `balanceAt(evidence, now)` for each holding it is
 * given, whatever balance the caller expected. So every caller writes its
 * evidence first, in the same transaction (A5 D-15).
 *
 * A holding the closed-position sweep hid is shown again by a non-zero write,
 * so none stays hidden while it holds a balance and every sum built from the
 * shown holdings agrees with the value history, which counts it (SC-1557).
 * `hidden_by` stays 'auto', so the sweep may hide it again. One its owner hid
 * is never shown.
 *
 * It is also the one writer of `value_base` and `value_priced_at` (SC-1610):
 * the balance times its price in the owner's base, as the live valuation
 * computes it, dated by the reading. The data-quality flag for a hidden
 * holding with a new balance reads `value_base` (A5 #9).
 */
@Service()
export class HoldingCacheWriter {
  private readonly prices = Container.get(PriceReader);
  private readonly hubs = Container.get(PriceHubResolver);
  private readonly evidence = Container.get(EngineEvidenceRepository);
  private readonly logger = createComponentLogger('service:HoldingCacheWriter');

  async apply(
    userId: string,
    writes: readonly CacheWrite[],
    tx: DatabaseTransaction
  ): Promise<Map<string, string>> {
    if (writes.length === 0) return new Map();
    const balances = await this.engineBalances(
      userId,
      writes.map((w) => w.holdingId),
      tx
    );
    for (const { holdingId, balance } of writes) {
      const engine = balances.get(holdingId);
      if (balance === undefined || engine === undefined) continue;
      if (new Decimal(balance).eq(engine)) {
        // The figure as the person wrote it, `12.30` and not `12.3` (U4).
        balances.set(holdingId, balance);
      } else {
        this.logger.info(
          { userId, holdingId, expected: balance, engine },
          'the engine disagrees with the balance its caller expected'
        );
      }
    }
    await asEngineCalculator(tx, async (calculator) => {
      for (const { holdingId, lastUpdated } of writes) {
        const balance = balances.get(holdingId) ?? '0';
        await calculator
          .update(schema.holdings)
          .set({
            balance,
            ...(lastUpdated === null ? {} : { lastUpdated: lastUpdated ?? new Date() }),
            isHidden: sql`${schema.holdings.isHidden} AND NOT (${schema.holdings.hiddenBy} IS NOT DISTINCT FROM 'auto' AND ${balance}::numeric <> 0)`,
          })
          .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)));
      }
    });
    await this.revalue(
      userId,
      writes.map((w) => w.holdingId),
      new Date(),
      tx
    );
    return balances;
  }

  /**
   * The cache brought to the engine's answer after evidence was written or
   * removed with no balance stated: an arrival, a gap answer, a deletion
   * (A5 D-18). Each stored instant is kept, as those paths never stamped one.
   */
  refresh(
    userId: string,
    holdingIds: readonly string[],
    tx: DatabaseTransaction
  ): Promise<Map<string, string>> {
    return this.apply(
      userId,
      holdingIds.map((holdingId) => ({ holdingId, lastUpdated: null })),
      tx
    );
  }

  /**
   * One holding's balance now, as `engineBalances` answers it: the figure a
   * movement or a put-back is added to, never the stored column (A5 D-15).
   * `without` names ledger rows the caller is about to rewrite, so an amount
   * added on top does not also count the row it replaces.
   */
  async engineBalance(
    userId: string,
    holdingId: string,
    tx: DatabaseTransaction,
    without: ReadonlySet<string> = new Set()
  ): Promise<string> {
    return (await this.engineBalances(userId, [holdingId], tx, without)).get(holdingId) ?? '0';
  }

  /**
   * Each holding's balance now, from its evidence, as the engine answers it.
   * The rows are locked first, in id order, so no write lands between the
   * read and the UPDATE; `now` is taken after the lock, so evidence the
   * caller wrote in this transaction counts. A holding that has not started
   * yet is 0. Logs the time and rows read per call (A5 PR-3 Step 1).
   */
  async engineBalances(
    userId: string,
    holdingIds: readonly string[],
    tx: DatabaseTransaction,
    without: ReadonlySet<string> = new Set()
  ): Promise<Map<string, string>> {
    const ids = [...new Set(holdingIds)].sort();
    const balances = new Map<string, string>();
    if (ids.length === 0) return balances;
    const locked = await tx
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(and(inArray(schema.holdings.id, ids), eq(schema.holdings.userId, userId)))
      .orderBy(asc(schema.holdings.id))
      .for('no key update');
    if (locked.length !== ids.length) {
      const found = new Set(locked.map((r) => r.id));
      throw new Error(
        `HoldingCacheWriter: user ${userId} has no holding ${ids.find((id) => !found.has(id))}`
      );
    }
    const started = performance.now();
    const now = new Date();
    let rows = 0;
    for (let i = 0; i < ids.length; i += EVIDENCE_BATCH) {
      const raws = await this.evidence.findHoldingEvidence(
        { userId, holdingIds: ids.slice(i, i + EVIDENCE_BATCH) },
        tx
      );
      for (const found of raws) {
        const raw =
          without.size === 0
            ? found
            : { ...found, transactions: found.transactions.filter((t) => !without.has(t.id)) };
        rows += raw.observations.length + raw.transactions.length;
        const answer = balanceAt(classifyHoldingEvidence(raw).evidence, now);
        balances.set(raw.holding.id, answer.status === 'absent' ? '0' : answer.balance.toFixed());
      }
    }
    this.logger.debug(
      { userId, holdings: ids.length, rows, ms: Math.round(performance.now() - started) },
      'engine balances computed'
    );
    return balances;
  }

  /**
   * One price load and at most one UPDATE for the user. A holding with no
   * price, or an owner with no base, caches null. Writes a holding only when
   * its value moved, or when its date moved and the stored one is past its
   * class's refresh horizon; returns the holdings written. A holding whose
   * balance moved after it was read is read and priced once more, so a sync
   * that priced it before a price committed is not left stale (SC-1620).
   */
  revalue(
    userId: string,
    holdingIds: readonly string[],
    at: Date,
    tx: DatabaseTransaction
  ): Promise<string[]> {
    return this.revalueOnce(userId, holdingIds, at, tx, true);
  }

  private async revalueOnce(
    userId: string,
    holdingIds: readonly string[],
    at: Date,
    tx: DatabaseTransaction,
    retry: boolean
  ): Promise<string[]> {
    if (holdingIds.length === 0) return [];
    const [owner] = await tx
      .select({ baseTokenId: schema.users.baseCurrencyId })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    const base = owner?.baseTokenId ?? null;
    const rows = await tx
      .select({
        id: schema.holdings.id,
        tokenId: schema.holdings.tokenId,
        balance: schema.holdings.balance,
        valueBase: schema.holdings.valueBase,
        valuePricedAt: schema.holdings.valuePricedAt,
        typeCode: schema.tokenTypes.code,
      })
      .from(schema.holdings)
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
      .leftJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
      .where(and(eq(schema.holdings.userId, userId), inArray(schema.holdings.id, [...holdingIds])));
    const priced =
      base === null
        ? new Map()
        : await this.prices.at(
            [...new Set(rows.map((r) => r.tokenId))].filter((id) => id !== base),
            base,
            at,
            tx
          );

    const writes: Array<{
      id: string;
      balance: string;
      valueBase: string | null;
      valuePricedAt: Date | null;
    }> = [];
    for (const row of rows) {
      const answer =
        base === null
          ? null
          : row.tokenId === base
            ? { price: new Decimal(1), readingAt: at }
            : (priced.get(row.tokenId) ?? null);
      const valueBase = answer
        ? new Decimal(row.balance).mul(new Decimal(answer.price.toString())).toString()
        : null;
      const valuePricedAt = answer?.readingAt ?? null;
      const valueMoved =
        valueBase === null || row.valueBase === null
          ? valueBase !== row.valueBase
          : !new Decimal(valueBase).eq(row.valueBase);
      const dateMoved = valuePricedAt?.getTime() !== row.valuePricedAt?.getTime();
      if (
        valueMoved ||
        (dateMoved &&
          (row.valuePricedAt === null || pastRefresh(row.valuePricedAt, row.typeCode, at)))
      ) {
        writes.push({ id: row.id, balance: row.balance, valueBase, valuePricedAt });
      }
    }
    // A balance written since it was read here is left for its own writer's revalue.
    if (writes.length === 0) return [];
    const values = sql.join(
      writes.map(
        (w) =>
          sql`(${w.id}::uuid, ${w.balance}::text, ${w.valueBase}::text, ${w.valuePricedAt?.toISOString() ?? null}::timestamptz)`
      ),
      sql`, `
    );
    const updated = await asEngineCalculator(tx, (calculator) =>
      calculator.execute<{ id: string }>(sql`
        UPDATE holdings AS h
           SET value_base = v.value_base, value_priced_at = v.value_priced_at
          FROM (VALUES ${values}) AS v(id, balance, value_base, value_priced_at)
         WHERE h.id = v.id AND h.balance = v.balance
     RETURNING h.id`)
    );
    const done = [...updated].map((row) => row.id);
    const skipped = writes.map((w) => w.id).filter((id) => !done.includes(id));
    if (!retry || skipped.length === 0) return done;
    return [...done, ...(await this.revalueOnce(userId, skipped, at, tx, false))];
  }

  /**
   * After prices were written: revalues every holding one of whose candidate
   * routes reads a changed (token, base) pair. With `sweep` (the hourly run)
   * also every one never valued, and every one whose cached date is past its
   * class's refresh horizon, so a price that stops moving does not leave the
   * cache dated while the live read is fresh. A route switch on a same-price
   * reading is missed; the shadow names it and the refresh bounds it. Hidden
   * holdings too: no total reads them, but the flag for a hidden holding with
   * a new balance does (SC-1676). Each owner in its own transaction unless one
   * is handed. Returns the holdings written.
   */
  async revalueAffected(
    changedPairs: ReadonlyArray<{ tokenId: string; baseTokenId: string }>,
    at: Date,
    { tx, sweep = false }: { tx?: DatabaseTransaction; sweep?: boolean } = {}
  ): Promise<string[]> {
    const changed = new Set(changedPairs.map((p) => pairKey(p.tokenId, p.baseTokenId)));
    if (changed.size === 0 && !sweep) return [];
    const reader = tx ?? getDb();
    const holdings = await reader
      .select({
        id: schema.holdings.id,
        userId: schema.holdings.userId,
        tokenId: schema.holdings.tokenId,
        baseTokenId: schema.users.baseCurrencyId,
        valuePricedAt: schema.holdings.valuePricedAt,
        typeCode: schema.tokenTypes.code,
      })
      .from(schema.holdings)
      .innerJoin(schema.users, eq(schema.users.id, schema.holdings.userId))
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
      .leftJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
      .where(isNotNull(schema.users.baseCurrencyId));
    const hubTokenIds = changed.size > 0 ? await this.hubs.hubTokenIds(tx) : [];
    const quotes =
      changed.size > 0
        ? await this.evidence.findQuoteTokenIds(
            [...new Set(holdings.map((h) => h.tokenId))],
            at,
            tx
          )
        : new Map<string, string[]>();

    const byUser = new Map<string, string[]>();
    for (const h of holdings) {
      if (h.baseTokenId === null) continue;
      const routed =
        changed.size > 0 &&
        h.tokenId !== h.baseTokenId &&
        readingPairsFor([h.tokenId], h.baseTokenId, hubTokenIds, quotes).some((p) =>
          changed.has(pairKey(p.tokenId, p.baseTokenId))
        );
      const swept =
        sweep && (h.valuePricedAt === null || pastRefresh(h.valuePricedAt, h.typeCode, at));
      if (!routed && !swept) continue;
      const ids = byUser.get(h.userId);
      if (ids) ids.push(h.id);
      else byUser.set(h.userId, [h.id]);
    }

    const written: string[] = [];
    for (const [userId, ids] of byUser) {
      written.push(
        ...(tx
          ? await this.revalue(userId, ids, at, tx)
          : await getDb().transaction((own) => this.revalue(userId, ids, at, own)))
      );
    }
    return written;
  }
}

const HOUR_MS = 3_600_000;

/** How old a cached date may grow before it is rewritten unmoved; a custom price is a step and never is. */
const REFRESH_AFTER_MS: Readonly<Record<AssetClass, number | null>> = {
  crypto: 6 * HOUR_MS,
  unknown: 6 * HOUR_MS,
  fiat: 24 * HOUR_MS,
  stock: 24 * HOUR_MS,
  custom: null,
};

function pastRefresh(pricedAt: Date | null, typeCode: string | null, at: Date): boolean {
  const horizon = REFRESH_AFTER_MS[assetClassOf(typeCode)];
  return pricedAt !== null && horizon !== null && at.getTime() - pricedAt.getTime() > horizon;
}

function pairKey(tokenId: string, baseTokenId: string): string {
  return `${tokenId}|${baseTokenId}`;
}
