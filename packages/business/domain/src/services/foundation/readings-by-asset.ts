import type { PriceReading } from '../../engine/types';

/**
 * Each asset's share of one base's readings: those that name the asset, and
 * those between two of the base and the hubs. `priceAt` reads no other pair
 * for the asset (`readingPairsFor`) and `readingTimes` reads only rows quoting
 * it, so both answer from the share exactly as from the whole list. Built once
 * per base, so pricing N assets no longer scans every reading N times.
 */
export function readingsByAsset(
  readings: readonly PriceReading[],
  baseTokenId: string,
  hubTokenIds: readonly string[]
): (tokenId: string) => PriceReading[] {
  const anchors = new Set([baseTokenId, ...hubTokenIds]);
  const between: PriceReading[] = [];
  const naming = new Map<string, PriceReading[]>();
  for (const reading of readings) {
    if (anchors.has(reading.tokenId) && anchors.has(reading.baseTokenId)) {
      between.push(reading);
      continue;
    }
    for (const tokenId of new Set([reading.tokenId, reading.baseTokenId])) {
      const own = naming.get(tokenId);
      if (own) own.push(reading);
      else naming.set(tokenId, [reading]);
    }
  }
  return (tokenId) => [...(naming.get(tokenId) ?? []), ...between];
}
