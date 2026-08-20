/**
 * SC-403 — which chain identity on a token row is allowed to decide what the
 * row IS.
 *
 * A row can carry several provider namespaces at once, and they are not peers.
 * When one of them is a NATIVE identity on a non-EVM chain — today that means
 * `solana.mint` — the row is that mint. An `etherscan` contract sitting beside
 * it is at best a bridged wrapper and at worst an unrelated contract that
 * shares the ticker. Production carried two of the second kind (measured
 * 2026-08-18):
 *
 *   BONK   mint `DezXAZ8z…`  beside base `0xf2b2c2a4…`, `name()` "Bonk by Virtuals"
 *   TRUMP  mint `6p6xgHyF…`  beside base `0x36d68289…`, `name()` "Trump Wars"
 *
 * `symbol()` MATCHES on both, so a symbol-equality guard — the obvious one,
 * and the shape SC-389 shipped for CoinGecko ids — catches neither. The tell
 * that needs no RPC call and no list of contested tickers is structural: a row
 * with a foreign-native identity should not be having anything decided for it
 * by an EVM contract.
 *
 * This lives beside `TokenMetadata` because it is an invariant of that shape,
 * and because it is the only place every caller can reach: `@scani/providers`
 * depends on `@scani/db` and not the other way round.
 *
 * The same rule, on the decimals question, is `decimalsAuthority()` in
 * `scripts/lib/sc396-token-decimals.ts`, which now delegates here so there is
 * one implementation rather than two vocabularies for one idea.
 *
 * WHAT THIS CANNOT REACH: a SQL migration. SC-408 named the writer that put
 * those two contracts on those two rows in the first place — migration
 * `0007_merge_chain_spread_crypto`, which merged a chain-spread duplicate into
 * its canonical with `provider_metadata = canonical || duplicate` and chose
 * the canonical as `ORDER BY (market_segment IS NULL) DESC`, which is the
 * Solana row every time. `mergeIdentityDeltas` protects the two code paths it
 * is called from; a statement that never enters the process is guarded by
 * `packages/infra/db/tests/migration-metadata-union.test.ts` instead. See
 * `docs/technical/2026-08-19_sc408-the-migration-that-unioned-namespaces.md`.
 */

/**
 * `foreign-native` — the row's identity is a native asset on a non-EVM chain,
 * and no EVM contract on the row is authoritative for it.
 * `evm-contract` — the ordinary case; nothing outranks the contract.
 *
 * Absence of a foreign-native identity is deliberately NOT a third state. A
 * row with no chain identity at all is priced by symbol-derived ids and this
 * rule has nothing to say about it.
 */
export type IdentityAuthority = 'foreign-native' | 'evm-contract';

interface ForeignNativeShape {
  solana?: { mint?: unknown };
}

/** The mint, when the row has one worth believing. */
function solanaMint(metadata: unknown): string | null {
  const mint = (metadata as ForeignNativeShape | null | undefined)?.solana?.mint;
  return typeof mint === 'string' && mint.length > 0 ? mint : null;
}

export function identityAuthority(metadata: unknown): IdentityAuthority {
  return solanaMint(metadata) === null ? 'evm-contract' : 'foreign-native';
}

/**
 * The DeFiLlama coin key a foreign-native row must be priced by, or null when
 * the row is not foreign-native.
 *
 * Returning the key rather than a boolean is deliberate: the callers that need
 * this rule are the ones building an upstream query, and handing them the
 * answer removes the chance of them rebuilding it in the wrong order.
 */
export function foreignNativeChainKey(metadata: unknown): string | null {
  const mint = solanaMint(metadata);
  return mint === null ? null : `solana:${mint}`;
}

/** The chain segment of a DeFiLlama coin key — `base:0x…` → `base`. */
function coinKeyChain(coin: unknown): string | null {
  if (typeof coin !== 'string') return null;
  const separator = coin.indexOf(':');
  return separator > 0 ? coin.slice(0, separator) : null;
}

/**
 * Why a metadata namespace must not be written onto this row, or null to admit
 * it.
 *
 * POSITIVE CONTRADICTION ONLY, which is the rule SC-389 arrived at for
 * CoinGecko ids after measuring the alternative: absence is where the
 * legitimate rows live, and refusing on absence blanks real assets. So an
 * `etherscan` namespace carrying only a `chainId` — the shape used for a
 * chain's NATIVE asset — is admitted; only a concrete `contractAddress` on a
 * foreign-native row is a contradiction, because only that claims to be the
 * token itself.
 */
export function identityDeltaConflict(
  existing: unknown,
  namespace: string,
  value: unknown
): string | null {
  const nativeKey = foreignNativeChainKey(existing);
  if (nativeKey === null) return null;

  if (namespace === 'etherscan') {
    const contract = (value as { contractAddress?: unknown } | null | undefined)?.contractAddress;
    if (typeof contract === 'string' && contract.length > 0) {
      return `refusing EVM contract ${contract} on a foreign-native row (${nativeKey}); a shared ticker is not a shared identity`;
    }
    return null;
  }

  if (namespace === 'defillama') {
    const coin = (value as { coin?: unknown } | null | undefined)?.coin;
    const chain = coinKeyChain(coin);
    if (chain !== null && chain !== 'solana') {
      return `refusing DeFiLlama coin key ${String(coin)} on a foreign-native row (${nativeKey}); it prices a different chain`;
    }
    return null;
  }

  return null;
}

export interface IdentityMergeResult {
  readonly merged: Record<string, unknown>;
  /** Whether anything was actually added — callers skip the UPDATE when not. */
  readonly changed: boolean;
  /** One line per refused namespace, for the log that has to explain itself. */
  readonly refused: readonly string[];
}

/**
 * Merge provider-supplied identity deltas onto a row's existing metadata.
 *
 * First-writer-wins per namespace, which is the contract every
 * `TokenIdentityProvider` is written against — an enricher owns its key and
 * never overwrites another's. What this adds on top is {@link
 * identityDeltaConflict}: a namespace that would contradict the row's
 * foreign-native identity is dropped and reported rather than written.
 *
 * The conflict test runs against the metadata AS IT WILL BE, not as it
 * arrived, so a mint contributed by one delta still protects the row from a
 * contract contributed by a later one in the same pass. That ordering is why
 * this is a shared function and not a rule copy-pasted into each merge loop:
 * the two production merge sites (`BackfillTokenIdentityProcessor` and
 * `TokenIdentityService.createFromIdentity`) had the same loop written twice
 * already, and a guard is only worth what its least careful copy enforces.
 */
export function mergeIdentityDeltas(
  existing: Record<string, unknown>,
  deltas: ReadonlyArray<Record<string, unknown> | null | undefined>
): IdentityMergeResult {
  const merged: Record<string, unknown> = { ...existing };
  const refused: string[] = [];
  let changed = false;

  for (const delta of deltas) {
    if (!delta) continue;
    for (const [namespace, value] of Object.entries(delta)) {
      if (namespace in merged && merged[namespace] !== undefined) continue;
      const conflict = identityDeltaConflict(merged, namespace, value);
      if (conflict !== null) {
        refused.push(conflict);
        continue;
      }
      merged[namespace] = value;
      changed = true;
    }
  }

  return { merged, changed, refused };
}
