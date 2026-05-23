/**
 * `HoldingSnapshotProjection` — projects `HoldingSnapshot[]` (the
 * provider registry's `BalanceProvider` return shape) into the
 * `IntegrationHolding[]` shape the wallet/exchange import + sync use
 * cases consume.
 *
 * The wider `HoldingSnapshot` carries `tokenIdentity: Partial<NewToken>`
 * with provider-namespaced metadata. The `IntegrationHolding` shape is
 * what the use cases pass downstream to `findOrCreateTokenFromIntegrationMapping`
 * and the holding write path: a flat
 * `{symbol, name, balance, decimals, externalTokenId, contractAddress?, iconUrl?}`
 * row. This file owns the small extraction logic that picks the right
 * external id (CoinGecko id vs Kraken asset vs Binance symbol vs IBKR
 * symbol) and surfaces the EVM contract address when present.
 */

import type { TokenMetadata } from '@scani/db/schema';
import type { HoldingSnapshot } from '@scani/providers/core/types';

export interface TokenMappingResult {
  token: {
    symbol: string;
    name: string;
    typeId: string;
    decimals?: number;
    iconUrl?: string | null;
    // Structural exchange segment ('US' / 'TO' / 'L' / …). Dropping it
    // here let the IBKR balance import resolve stocks to a NULL-segment
    // token while the tx import resolved them to the segmented one,
    // splitting every holding in two.
    marketSegment?: string | null;
    providerMetadata?: string | TokenMetadata;
  };
  isNew: boolean;
  confidence: number;
}

export interface IntegrationHolding {
  symbol: string;
  name: string;
  balance: string;
  decimals: number;
  tokenType?: string;
  externalTokenId?: string;
  contractAddress?: string;
  iconUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface FetchHoldingsResult {
  holdings: IntegrationHolding[];
  total: number;
  accountId: string;
  timestamp: Date;
  errors?: string[];
}

function readMetaField(
  metadata: TokenMetadata | string | null | undefined,
  pickers: Array<(m: Record<string, unknown>) => unknown>
): unknown {
  if (!metadata) return undefined;
  let parsed: Record<string, unknown> | undefined;
  if (typeof metadata === 'string') {
    try {
      parsed = JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  } else {
    parsed = metadata as unknown as Record<string, unknown>;
  }
  if (!parsed) return undefined;
  for (const pick of pickers) {
    const v = pick(parsed);
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/**
 * Best-effort extraction of a `contractAddress` string from a
 * provider's `tokenIdentity.providerMetadata` blob. Looks at the
 * Etherscan namespace (where wallet imports stash the contract) and
 * a top-level fallback for any provider that wrote it there directly.
 */
function extractContractAddress(
  metadata: TokenMetadata | string | null | undefined
): string | undefined {
  const v = readMetaField(metadata, [
    (m) => (m.etherscan as { contractAddress?: unknown } | undefined)?.contractAddress,
    (m) => m.contractAddress,
  ]);
  if (typeof v !== 'string') return undefined;
  // Defend against the legacy '0x0' placeholder used for native EVM
  // assets pre-fix — treat it as "no contract".
  const lower = v.toLowerCase();
  if (lower === '0x0' || /^0x0+$/.test(lower)) return undefined;
  return v;
}

/**
 * Best-effort extraction of a provider-native external id (`coingecko.id`,
 * `kraken.asset`, `binance.symbol`, `ibkr.symbol`, …). Used downstream
 * for idempotent dedup against the holding write path.
 */
function extractExternalTokenId(
  metadata: TokenMetadata | string | null | undefined,
  fallbackExternalId: string
): string {
  const v = readMetaField(metadata, [
    (m) => (m.coingecko as { id?: unknown } | undefined)?.id,
    (m) => (m.kraken as { asset?: unknown } | undefined)?.asset,
    (m) => (m.binance as { symbol?: unknown } | undefined)?.symbol,
    (m) => (m.ibkr as { symbol?: unknown; currency?: unknown } | undefined)?.symbol,
    (m) => (m.ibkr as { symbol?: unknown; currency?: unknown } | undefined)?.currency,
  ]);
  if (typeof v === 'string') return v;
  return fallbackExternalId;
}

/**
 * Translate `HoldingSnapshot[]` (returned by
 * `BalanceProvider.fetchBalances`) into the `FetchHoldingsResult`
 * shape the wallet/exchange use cases consume.
 *
 * `accountId` is the use-case-supplied identifier (Scani account id
 * for syncs, externalId for imports). `errors` is always empty —
 * provider-side errors throw rather than surfacing as soft warnings,
 * matching the use case's "successful fetch" semantics.
 */
export function projectSnapshotsToHoldings(
  snapshots: HoldingSnapshot[],
  accountId: string
): FetchHoldingsResult {
  const holdings: IntegrationHolding[] = snapshots.map((s) => {
    const ti = s.tokenIdentity;
    const symbol = (ti.symbol ?? s.externalId ?? '').toString();
    const name = (ti.name ?? symbol).toString();
    const decimals = typeof ti.decimals === 'number' ? ti.decimals : 18;
    const contractAddress = extractContractAddress(ti.providerMetadata);
    const externalTokenId = extractExternalTokenId(ti.providerMetadata, s.externalId);
    const out: IntegrationHolding = {
      symbol,
      name,
      balance: s.balance,
      decimals,
      externalTokenId,
    };
    if (contractAddress) out.contractAddress = contractAddress;
    if (typeof ti.iconUrl === 'string') out.iconUrl = ti.iconUrl;
    // Carry the provider-supplied token type (fiat / crypto / stock)
    // through to HoldingsSyncHelper so it picks the right token_types
    // row. Without this, a Kraken USD/EUR/GBP holding ends up tagged
    // 'crypto' and the price router sends it to CoinGecko (which
    // returns the "Unstable States Dollar" scam token instead of $1).
    if (typeof s.tokenType === 'string') out.tokenType = s.tokenType;
    return out;
  });

  return {
    holdings,
    total: holdings.length,
    accountId,
    timestamp: new Date(),
  };
}

/**
 * Project a single `HoldingSnapshot.tokenIdentity` into the
 * `TokenMappingResult` shape `tokenService.findOrCreateTokenFromIntegrationMapping`
 * consumes. The tokenIdentity is already normalized — we just pick
 * and pass through the providerMetadata blob (the contract accepts
 * either string or TokenMetadata; blockchain-origin token mappings
 * carry a JSON string).
 */
export function projectSnapshotToTokenMapping(snapshot: HoldingSnapshot): TokenMappingResult {
  const ti = snapshot.tokenIdentity;
  const symbol = (ti.symbol ?? snapshot.externalId ?? '').toString();
  const name = (ti.name ?? symbol).toString();
  const decimals = typeof ti.decimals === 'number' ? ti.decimals : 18;
  return {
    token: {
      symbol,
      name,
      typeId: '', // service layer fills in (crypto type for blockchain holdings)
      decimals,
      iconUrl: typeof ti.iconUrl === 'string' ? ti.iconUrl : null,
      marketSegment: ti.marketSegment ?? null,
      providerMetadata:
        ti.providerMetadata ??
        (snapshot.externalId ? JSON.stringify({ externalId: snapshot.externalId }) : undefined),
    },
    isNew: false, // service layer determines
    confidence: 1.0, // high confidence — provider gave us normalized data
  };
}
