/**
 * Transaction-import source taxonomy.
 *
 * Every `transaction-import` job carries a `source` tag. Sources fall
 * into two families:
 *
 *  - **Exchange/broker sources** — CEX + brokerage integrations. New
 *    tokens appearing in their transaction history are legitimate
 *    deposits and SHOULD create holdings on the fly.
 *  - **Wallet-derived sources** — on-chain wallets (EVM via `etherscan`,
 *    Solana, and any future chain). These imports are review-gated:
 *    `wallet.confirmHoldings` pre-creates only the holdings the user
 *    kept, so the transaction router must be FIND-ONLY for them — it
 *    must never create a holding for a token the user dropped at
 *    review (that is how spam/airdrop tokens used to leak back in).
 *
 * The exchange set is the authoritative list (it also drives registry
 * dispatch). Anything not in it is treated as wallet-derived, so a
 * newly wired blockchain source is review-gated by default.
 */

/**
 * Source tag → institution code (the registry filter). Keeping the
 * source tags stable lets the persisted `holding_transactions.source`
 * column stay valid for dedup, while the registry sees the institution
 * code its providers registered for.
 */
export const CEX_SOURCE_TO_INSTITUTION: Record<string, string> = {
  'kraken-api': 'kraken',
  'binance-api': 'binance',
  'bybit-api': 'bybit',
  'okx-api': 'okx',
  'coinbase-api': 'coinbase',
  'kucoin-api': 'kucoin',
  'gate-api': 'gate',
  'bitget-api': 'bitget',
  'huobi-api': 'huobi',
  'mexc-api': 'mexc',
  'bitstamp-api': 'bitstamp',
  'gemini-api': 'gemini',
  'ibkr-api': 'ibkr',
};

/** Exchange/broker transaction-import source tags. */
export const EXCHANGE_SOURCES: ReadonlySet<string> = new Set(
  Object.keys(CEX_SOURCE_TO_INSTITUTION)
);

/**
 * True when the source is an on-chain wallet import (EVM, Solana, …) —
 * i.e. anything that is not a known exchange/broker source. Wallet
 * imports are review-gated, so the transaction router runs FIND-ONLY
 * for them.
 */
export function isWalletDerivedSource(source: string): boolean {
  return !EXCHANGE_SOURCES.has(source);
}
