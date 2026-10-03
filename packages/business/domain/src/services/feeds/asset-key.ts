import type { AssetRef } from './feed-batch';

/**
 * Two refs with this key resolve to one token, so a batch resolves each key
 * once. It is every field a lookup matches on and never the symbol alone: two
 * tokens can share a symbol. A display field (name, decimals, icon) is not in
 * it, so two refs of one token that spell its name differently are one lookup.
 */
export function assetKey(asset: AssetRef): string {
  const { symbol, marketSegment, providerMetadata } = asset.identity;
  return JSON.stringify([
    asset.lookup ?? 'identity',
    asset.typeCode,
    symbol,
    marketSegment ?? null,
    providerMetadata ?? null,
  ]);
}
