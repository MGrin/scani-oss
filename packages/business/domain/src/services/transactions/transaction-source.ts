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
