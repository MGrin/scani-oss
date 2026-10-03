import type { DatabaseTransaction } from '@scani/db';
import type { Holding } from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { Container, Service } from 'typedi';
import type { AssetRef, DecimalString, FeedBatch, FeedCheckpoint, FeedEntry } from '../feed-batch';
import { HoldingResolver } from '../HoldingResolver';
import { type BatchTokens, tokenModeOf } from './BatchTokens';

/** One holding's share of a batch. */
export interface Placement {
  holding: Holding;
  created: boolean;
  /** The earliest instant the batch carries for the holding. */
  earliest: Date;
  /** Its entries' amounts, as the batch sent them. */
  amounts: DecimalString[];
  /** Its latest checkpoint; at one instant, the last the batch sent. */
  close: FeedCheckpoint | null;
}

/** Which holding each of a batch's assets writes into. */
@Service()
export class HoldingPlacer {
  private readonly resolver = Container.get(HoldingResolver);

  /**
   * Where the plan taken before the transaction lands an entry: under 'create'
   * wherever its asset resolved, since the write finds or creates the holding;
   * otherwise where the holding is there now, by the path's own matching.
   */
  async locateBeforeWrite(
    batch: FeedBatch,
    tokens: BatchTokens,
    carried: readonly FeedEntry[]
  ): Promise<{ landingOf(asset: AssetRef): true | null }> {
    const policy = batch.legacy.holdingPolicy;
    if (policy === 'create') return { landingOf: () => true };
    const mode = tokenModeOf(policy);
    const heldKey = (tokenId: string, key: string | null) => JSON.stringify([tokenId, key]);
    const held = new Map<string, boolean>();
    for (const { asset } of carried) {
      const tokenId = tokens.tokenOf(asset, mode);
      const key = asset.key ?? null;
      if (tokenId === null || held.has(heldKey(tokenId, key))) continue;
      const find = this.resolver.findFeedHolding(
        {
          userId: batch.userId,
          accountId: batch.input.accountId,
          tokenId,
          key,
          match: batch.legacy.holdingMatch,
        },
        undefined
      );
      // A find that throws under skip-entry is tried again by the write, in
      // its savepoint, which skips and reports it there (R37).
      const holding =
        batch.legacy.holdingFailure === 'skip-entry' ? await find.catch(() => null) : await find;
      held.set(heldKey(tokenId, key), holding !== null);
    }
    return {
      landingOf: (asset) => {
        const tokenId = tokens.tokenOf(asset, mode);
        const lands = tokenId !== null && held.get(heldKey(tokenId, asset.key ?? null)) === true;
        return lands ? true : null;
      },
    };
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
  async place(
    batch: FeedBatch,
    entries: readonly FeedEntry[],
    tokenOf: (asset: AssetRef) => string | null,
    tx: DatabaseTransaction
  ) {
    const groupOf = (tokenId: string, key: string | null) => JSON.stringify([tokenId, key]);
    const groups = new Map<
      string,
      { tokenId: string; key: string | null; earliest: Date; opens: boolean }
    >();
    // A holding is opened for an entry, or for a checkpoint unless a zero may
    // not open one: the balance syncs never opened a holding at zero.
    const opensAt = (amount: DecimalString) =>
      batch.legacy.zeroOpensHolding || !new Decimal(amount).isZero();
    const instants: Array<{ asset: AssetRef; at: Date; opens: boolean }> = [
      ...entries.map((e) => ({ asset: e.asset, at: e.occurredAt, opens: true })),
      ...batch.checkpoints.map((c) => ({ asset: c.asset, at: c.at, opens: opensAt(c.amount) })),
    ];
    for (const { asset, at, opens } of instants) {
      const tokenId = tokenOf(asset);
      if (tokenId === null) continue;
      const key = asset.key ?? null;
      const seen = groups.get(groupOf(tokenId, key));
      if (seen === undefined) {
        groups.set(groupOf(tokenId, key), { tokenId, key, earliest: at, opens });
        continue;
      }
      if (at < seen.earliest) seen.earliest = at;
      seen.opens ||= opens;
    }

    const create =
      batch.legacy.holdingPolicy === 'create'
        ? { source: batch.legacy.holdingSource, arrival: batch.legacy.arrival }
        : null;
    const holdingOfGroup = new Map<string, string>();
    const byHolding = new Map<string, Placement>();
    const failures = new Map<string, string>();
    const resolveGroup = async (
      tokenId: string,
      key: string | null,
      earliest: Date,
      opens: boolean
    ): Promise<Placement | null> => {
      if (failures.has(groupOf(tokenId, key))) return null;
      const creates = opens ? create : null;
      const resolve = (within: DatabaseTransaction) =>
        this.resolver.resolveFeedHolding(
          {
            userId: batch.userId,
            accountId: batch.input.accountId,
            tokenId,
            key,
            match: batch.legacy.holdingMatch,
            create: creates,
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
        if (creates === null) return null;
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
    for (const { tokenId, key, earliest, opens } of groups.values()) {
      await resolveGroup(tokenId, key, earliest, opens);
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
      if (placement === null) return await resolveGroup(tokenId, null, at, true);
      if (at < placement.earliest) placement.earliest = at;
      return placement;
    };
    const holdingFailureOf = (tokenId: string, key?: string) =>
      failures.get(groupOf(tokenId, key ?? null));
    return { placementOf, placeLeg, holdingFailureOf, placementsByHolding: byHolding };
  }
}
