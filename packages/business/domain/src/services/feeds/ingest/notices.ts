import { identityCacheKey } from '../../../lib/transactions/token-identity-key';
import { walletReviewSkipNotice } from '../../transactions/transaction-sources';
import { assetKey } from '../asset-key';
import type { AssetRef, FeedBatch, FeedEntry } from '../feed-batch';
import { type BatchTokens, tokenModeOf } from './BatchTokens';
import type { Placement } from './HoldingPlacer';

/** The router's line for a holding it could not find or create, once per event or leg it dropped. */
export const holdingFailedNotice = (tokenId: string, message: string) =>
  `Failed to resolve holding for token ${tokenId}: ${message}`;

export const unresolvedLegsNotice = (count: number) =>
  `Skipped ${count} settlement leg(s): the holding for their currency could not be resolved, so those trades are recorded without their cash side and that cash balance will not reconcile.`;

/** T10 M6: a balance a non-create batch had no holding for, named rather than dropped in silence. */
const unheldCheckpointsNotice = (count: number, symbols: readonly string[]) =>
  `Skipped ${count} balance(s) the account holds no position for, because this sync never opens one: ${symbols.join(', ')}.`;

/** R58: counted, never named, like the batch refusals. */
export const duplicatePlacementNotice = (count: number) =>
  `duplicate-placement: ${count} event(s) were placed on a holding that already held an older copy of them, while this feed recorded each on another holding. Each older copy was removed and the event moved to the holding it was placed on, so each is now held once.`;

/** `ambiguous`: several catalog listings share the symbol, so none was taken. */
export interface SkippedAsset {
  symbol: string;
  reason: string;
  ambiguous?: true;
}

/** Each of the batch's own assets that did not resolve, once. */
export function skippedAssets(batch: FeedBatch, tokens: BatchTokens): SkippedAsset[] {
  const skipped = new Map<string, SkippedAsset>();
  const assets = [...batch.entries.map((e) => e.asset), ...batch.checkpoints.map((c) => c.asset)];
  for (const asset of assets) {
    const answer = tokens.answerOf(asset, tokenModeOf(batch.legacy.holdingPolicy));
    if (answer === null || 'tokenId' in answer || skipped.has(assetKey(asset))) continue;
    skipped.set(assetKey(asset), {
      symbol: asset.identity.symbol,
      reason: 'skipped' in answer ? answer.skipped : answer.failed,
      ...('ambiguous' in answer && answer.ambiguous ? { ambiguous: true as const } : {}),
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
export function reviewSkipNotice(
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
 * The checkpoints a non-create batch dropped because the account holds no
 * position for their token (T10 M6), counted and named. One whose token
 * lookup or holding failed is not among them: each has its own report.
 */
export function unheldCheckpointNotice(
  batch: FeedBatch,
  tokenOf: (asset: AssetRef) => string | null,
  placementOf: (asset: AssetRef) => Placement | null,
  holdingFailureOf: (tokenId: string, key?: string) => string | undefined
): string[] {
  if (batch.legacy.holdingPolicy === 'create') return [];
  const unheld = batch.checkpoints.filter(({ asset }) => {
    const tokenId = tokenOf(asset);
    return (
      tokenId !== null &&
      placementOf(asset) === null &&
      holdingFailureOf(tokenId, asset.key) === undefined
    );
  });
  if (unheld.length === 0) return [];
  const symbols = [...new Set(unheld.map(({ asset }) => asset.identity.symbol))];
  return [unheldCheckpointsNotice(unheld.length, symbols)];
}
