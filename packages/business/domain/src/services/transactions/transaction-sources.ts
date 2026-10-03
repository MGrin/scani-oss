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
  'airwallex-api': 'airwallex',
};

/**
 * Sources that report a trade as ONE row, with the cash side only as its
 * counter. The cash leg is derived as its own settlement row (SC-1453). Every
 * other source already writes the cash row itself, so deriving one there would
 * count the money twice.
 */
/**
 * Sources whose quantity is GROSS of a fee taken in the row's own token
 * (SC-1486): Kraken's ledger `amount` and Bybit's `execQty` are what moved
 * before the fee, and the fee arrives only as a field beside them. Without a row
 * of its own the holding's ledger ran ahead of its balance by every such fee,
 * and the balance check booked that gap as money out — each fee counted twice.
 */
export const GROSS_OF_OWN_FEE_SOURCES: ReadonlySet<string> = new Set(['kraken-api', 'bybit-api']);

export const SETTLEMENT_DERIVED_SOURCES: ReadonlySet<string> = new Set([
  'ibkr-api',
  'binance-api',
  'bybit-api',
  'bitget-api',
  'gate-api',
  'gemini-api',
  'mexc-api',
  'huobi-api',
  'bitstamp-api',
]);

/** Exchange/broker transaction-import source tags. */
const EXCHANGE_SOURCES: ReadonlySet<string> = new Set(Object.keys(CEX_SOURCE_TO_INSTITUTION));

/**
 * True when the source is an on-chain wallet import (EVM, Solana, …) —
 * i.e. anything that is not a known exchange/broker source. Wallet
 * imports are review-gated, so a transaction import finds only for them
 * (`legacyTransactionBatch`, by `inputSourceClass`, which agrees on every
 * source the import accepts).
 */
export function isWalletDerivedSource(source: string): boolean {
  return !EXCHANGE_SOURCES.has(source);
}

/**
 * What a FIND-ONLY import says about the events it dropped for want of a
 * holding the user kept, so the run does not go quiet about them (SC-343).
 */
export function walletReviewSkipNotice(events: number, tokens: number): string {
  return `Skipped ${events} tx event(s) referencing ${tokens} token(s) the user didn't keep during wallet review.`;
}
