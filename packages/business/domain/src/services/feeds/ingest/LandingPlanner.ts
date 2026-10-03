import type { DatabaseTransaction } from '@scani/db';
import { Service } from 'typedi';
import { loneSwapLegs } from '../../../lib/transactions/swap-groups';
import type { AssetRef, FeedBatch, FeedEntry } from '../feed-batch';
import { type BatchTokens, tokenModeOf } from './BatchTokens';
import { parentKey } from './ledger-rows';

/** Where an asset lands, or null when it has nowhere to. */
interface Locator<At> {
  landingOf(asset: AssetRef): At | null;
}

interface LandingPlan<At, Where> {
  /** The entries whose own asset resolved, a leg only beside the row it settles. */
  carried: FeedEntry[];
  /** The entries that land, each with where. */
  landed: Array<{ entry: FeedEntry; at: At }>;
  /** The landed swap legs whose swap did not survive: each is written as a transfer. */
  demoted: Set<FeedEntry>;
  where: Where;
}

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

@Service()
export class LandingPlanner {
  /**
   * The one decision of which entries land (R34b), taken before ingest's own
   * transaction opens and again inside it. The batch's own assets resolve under
   * its policy; an entry lands when its asset resolved and `locate` gives it a
   * holding, and a leg lands only beside the row it settles. A landed swap leg
   * whose group has no other landed leg is demoted (`loneSwapLegs`, SC-332).
   * Then the tokens the landed rows reference besides their own are found or
   * created, a demoted leg's counter and quotes excepted (R32, R33). Every
   * answer stays in `tokens`, so a second pass asks again only where the first
   * did not.
   */
  async plan<At, Where>(
    batch: FeedBatch,
    tokens: BatchTokens,
    locate: (carried: readonly FeedEntry[]) => Promise<Where & Locator<At>>,
    tx: DatabaseTransaction | undefined
  ): Promise<LandingPlan<At, Where>> {
    const mode = tokenModeOf(batch.legacy.holdingPolicy);
    const assets = [...batch.entries.map((e) => e.asset), ...batch.checkpoints.map((c) => c.asset)];
    for (const asset of assets) await tokens.resolve(asset, mode, tx);
    // A measured exit names a holding that exists, so its token is found, never created.
    for (const { asset } of batch.absences) await tokens.resolve(asset, 'find-only', tx);
    const carried = withParents(
      batch.entries.filter((entry) => tokens.tokenOf(entry.asset, mode) !== null)
    );
    const where = await locate(carried);
    const located = carried.flatMap((entry) => {
      const at = where.landingOf(entry.asset);
      return at === null ? [] : [{ entry, at }];
    });
    const beside = new Set(withParents(located.map(({ entry }) => entry)));
    const landed = located.filter(({ entry }) => beside.has(entry));
    const demoted = loneSwapLegs(
      landed.map(({ entry }) => entry),
      (entry) => entry.groupKey
    );
    for (const { entry } of landed) {
      for (const asset of legacyAssetsOf(entry, demoted.has(entry))) {
        await tokens.resolve(asset, 'create', tx);
      }
    }
    return { carried, landed, demoted, where };
  }
}
