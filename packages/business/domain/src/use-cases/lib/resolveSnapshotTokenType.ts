import type { HoldingSnapshot } from '@scani/providers/core/types';

/**
 * Map a provider snapshot's `tokenType` ('fiat' | 'crypto' | 'stock' | …)
 * to a `tokenTypes.id` row. Honours the snapshot's declared type when
 * the provider supplies one (Kraken stamps `fiat` on USD/EUR; IBKR cash
 * legs are `fiat`, equities are `stock`); falls back to `fallbackTypeId`
 * for providers that haven't been retrofitted.
 *
 * Centralised here so a regression like "Kraken USD → crypto type →
 * duplicate token row with no price source" can't recur silently across
 * the per-provider use cases.
 */
export function resolveSnapshotTokenType(
  snapshot: HoldingSnapshot,
  tokenTypeMap: Record<string, string>,
  fallbackTypeId: string
): string {
  const declared = snapshot.tokenType;
  if (declared && tokenTypeMap[declared]) return tokenTypeMap[declared];
  return fallbackTypeId;
}
