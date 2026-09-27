type ExternalProvider = 'finnhub' | 'coingecko';

interface ExternalSearchItem {
  symbol: string;
  name: string;
  type: string;
  currency?: string;
  exchange?: string;
  provider: string;
  providerMetadata?: Record<string, unknown>;
}

/** The metadata `tokens.search` hands the client for an external hit. */
export function externalSearchMetadata(item: ExternalSearchItem): Record<string, unknown> {
  return {
    symbol: item.symbol,
    name: item.name,
    type: item.type,
    currency: item.currency,
    exchange: item.exchange,
    provider: item.provider,
    ...(item.providerMetadata ?? {}),
  };
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' && found.length > 0 ? found : undefined;
}

// Same precedence `TokenService.createFromExternal` uses to read the pricing
// id, so the id verified here is the id that gets stored.
function pricingId(
  provider: ExternalProvider,
  symbol: string,
  metadata: Record<string, unknown>
): string | undefined {
  if (provider === 'coingecko') {
    return (
      nestedString(metadata.providerMetadata, 'id') ??
      nestedString(metadata, 'coinGeckoId') ??
      nestedString(metadata, 'id')
    );
  }
  return (
    nestedString(metadata.providerMetadata, 'symbol') ??
    nestedString(metadata, 'finnhubSymbol') ??
    symbol
  ).toUpperCase();
}

/**
 * A client-picked external token is created only as the provider itself
 * describes it (SC-1339): the pick must name a symbol and pricing id the
 * server's own search returned, and the returned metadata is the server's,
 * never the client's copy. Anything else could plant a shared catalog token
 * priced from a different asset.
 */
export function matchVerifiedExternalToken(
  serverResults: readonly ExternalSearchItem[],
  pick: { symbol: string; provider: ExternalProvider; metadata: Record<string, unknown> }
): Record<string, unknown> | null {
  const symbol = pick.symbol.toUpperCase();
  const wanted = pricingId(pick.provider, symbol, pick.metadata);
  if (!wanted) return null;

  for (const item of serverResults) {
    if (item.provider !== pick.provider || item.symbol.toUpperCase() !== symbol) continue;
    const metadata = externalSearchMetadata(item);
    if (pricingId(pick.provider, symbol, metadata) === wanted) return metadata;
  }
  return null;
}
