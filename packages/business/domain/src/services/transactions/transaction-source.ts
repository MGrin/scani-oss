// Single source of truth mapping an exchange/broker/bank provider name
// to the stable `source` tag the transaction-import pipeline routes by.
// These match the `readonly source = '…'` fields on the CEX
// TransactionIngester classes. Providers without an ingester return
// null — the transaction-import chain is skipped (balance-only sync
// still works). Consumed by the initial exchange-import chain AND the
// recurring transaction-sync job, so the mapping never drifts.
const PROVIDER_SOURCE_MAP: Record<string, string> = {
  kraken: 'kraken-api',
  binance: 'binance-api',
  bybit: 'bybit-api',
  okx: 'okx-api',
  coinbase: 'coinbase-api',
  kucoin: 'kucoin-api',
  'gate.io': 'gate-api',
  gateio: 'gate-api',
  gate: 'gate-api',
  bitget: 'bitget-api',
  huobi: 'huobi-api',
  mexc: 'mexc-api',
  bitstamp: 'bitstamp-api',
  gemini: 'gemini-api',
  ibkr: 'ibkr-api',
  'interactive brokers': 'ibkr-api',
  airwallex: 'airwallex-api',
};

export function sourceForProvider(provider: string): string | null {
  return PROVIDER_SOURCE_MAP[provider.toLowerCase()] ?? null;
}

// Blockchain wallets are keyed by chain, not by provider name. Every EVM
// chain shares the `etherscan` source (Etherscan V2 is one API across
// chains); non-EVM chains use their own slug. The wallet-detection layer
// encodes non-EVM chains as negative sentinels in `accounts.metadata.chainId`
// (0 for Bitcoin, which predates the convention).
const EVM_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, 56, 137, 43114, 42161, 10, 8453, 250, 25, 42170, 324, 534352, 59144, 81457, 5000, 204, 100,
  42220, 1284, 1285,
]);

// Mirrors `NON_EVM_CHAIN_ID_TO_INSTITUTION_CODE` in `WalletDiscoveryService`:
// for a non-EVM chain the source tag and the institution code its provider
// registers under are the same slug.
const NON_EVM_CHAIN_SOURCE_MAP: Record<string, string> = {
  '0': 'bitcoin',
  '-1': 'tron',
  '-2': 'solana',
  '-15': 'ton',
};

/**
 * The non-EVM wallet source tags, which are also the institution codes
 * their providers claim.
 *
 * `TransactionImportCoordinator.resolveInstitutionCode` dispatches off
 * this set rather than off its own list of slugs, so a chain added to
 * the map above is wired into the coordinator by the same edit. Holding
 * the two apart is what SC-364 was: a tag here with no branch there
 * turns a clean `skippedNoSource` into a nightly job that fails with
 * `unsupported-source`, which is strictly worse than not importing.
 */
export const NON_EVM_WALLET_SOURCES: ReadonlySet<string> = new Set(
  Object.values(NON_EVM_CHAIN_SOURCE_MAP)
);

/**
 * Source tag for a blockchain wallet account, from its
 * `accounts.metadata.chainId`.
 *
 * Chain id rather than institution name because the name is a display
 * string ("Bitcoin Network", "Binance Smart Chain") while the chain id is
 * what `TransactionImportCoordinator` already dispatches on. This is the
 * single copy: the wallet-import chain, the recurring transaction sync and
 * `scripts/reimport-wallet-transactions.ts` all read it.
 */
export function sourceForChainId(chainId: string | number | null | undefined): string | null {
  if (chainId === null || chainId === undefined) return null;
  const numeric = typeof chainId === 'number' ? chainId : Number(chainId);
  if (Number.isFinite(numeric) && EVM_CHAIN_IDS.has(numeric)) return 'etherscan';
  return NON_EVM_CHAIN_SOURCE_MAP[String(chainId)] ?? null;
}
