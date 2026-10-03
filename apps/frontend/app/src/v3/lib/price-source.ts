import type { TFunction } from 'i18next';

/**
 * Proper names, so not in the catalogue: a brand reads the same in every
 * language the app ships.
 */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  airwallex: 'Airwallex',
  binance: 'Binance',
  bitget: 'Bitget',
  bitstamp: 'Bitstamp',
  bybit: 'Bybit',
  coinbase: 'Coinbase',
  coingecko: 'CoinGecko',
  defillama: 'DefiLlama',
  etherscan: 'Etherscan',
  'exchangerate-api': 'ExchangeRate-API',
  finnhub: 'Finnhub',
  gate: 'Gate',
  gemini: 'Gemini',
  'google-sheets': 'Google Sheets',
  huobi: 'HTX',
  ibkr: 'Interactive Brokers',
  kraken: 'Kraken',
  kucoin: 'KuCoin',
  mexc: 'MEXC',
  okx: 'OKX',
  wise: 'Wise',
  'yahoo-finance': 'Yahoo Finance',
};

/** Sources whose name is a description rather than a brand. */
const TRANSLATED_SOURCES: Readonly<Record<string, string>> = {
  frankfurter: 'v3.priceSource.frankfurter',
  manual: 'v3.priceSource.manual',
  'base-currency': 'v3.priceSource.baseCurrency',
  sibling_fallback: 'v3.priceSource.siblingFallback',
};

/**
 * A source id is a provider key with optional variant suffixes —
 * `frankfurter_historical`, `coingecko_historical_usd_converted`,
 * `defillama_stale_fallback` — so a key matches the whole id or the id's head
 * up to an underscore or a hyphen (`manual-…` is a hand-set price too).
 * Longest key first, so `sibling_fallback` is not read as a provider called
 * `sibling`.
 */
function matchKey(source: string, keys: readonly string[]): string | undefined {
  return [...keys]
    .sort((a, b) => b.length - a.length)
    .find((key) => source === key || source.startsWith(`${key}_`) || source.startsWith(`${key}-`));
}

/** An id this build has never seen, as words: its provider segment, spaced and capitalised. */
function readableId(source: string): string {
  const head = (source.split('_')[0] ?? '').replace(/-/g, ' ').trim();
  return head.charAt(0).toUpperCase() + head.slice(1);
}

/**
 * Where a price or rate came from, in a reader's words (SC-1527).
 *
 * The one place a stored source id becomes a label. Every surface that shows
 * one goes through here, so a provider is spelled the same on all of them and
 * a new provider needs one entry rather than a hunt.
 */
export function priceSourceLabel(t: TFunction, source: string): string {
  const id = source.trim().toLowerCase();
  const translated = matchKey(id, Object.keys(TRANSLATED_SOURCES));
  if (translated) return t(TRANSLATED_SOURCES[translated] as string);
  const provider = matchKey(id, Object.keys(PROVIDER_NAMES));
  if (provider) return PROVIDER_NAMES[provider] as string;
  return readableId(id) || t('v3.priceSource.unknown');
}
