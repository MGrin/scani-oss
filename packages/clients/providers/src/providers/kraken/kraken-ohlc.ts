/**
 * Kraken public OHLC client — feeds the `HistoricalPriceProvider`
 * capability on `KrakenProvider`. Public endpoint, no auth, no
 * shared rate budget with the private balance/tx endpoints.
 *
 * Why this exists: Kraken-native asset codes (XXBT, ZUSD, XETH) don't
 * appear in DeFiLlama's contract-keyed index or CoinGecko's symbol-
 * keyed index. Without this provider, every Kraken-imported holding
 * would have a `provider-missing` historical-price status. The user
 * called this out in `.context/notes.md`: opportunistic historical
 * pricing from user-credentialed CEX integrations is required to
 * densify the cost-basis chart.
 *
 * Pre-refactor source: `packages/pricing-providers/src/providers/exchange-klines.ts`.
 */

import type { Token } from '@scani/db/schema';
import type { PriceQuote, ProviderContext } from '../../core/types';
import { fetchWithTimeout } from '../../core/utils/fetch';

/**
 * Quote currencies Kraken's OHLC endpoint supports. Asking for
 * something else (RUB, etc.) returns a 200 with an error string —
 * we anticipate the mismatch and fall back to USD-native quoting so
 * the rollup can at least compute a value via the FX hub.
 */
const KRAKEN_SUPPORTED_QUOTES = new Set([
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'JPY',
  'CHF',
  'AUD',
  'USDT',
  'USDC',
]);

const KRAKEN_OHLC_URL = 'https://api.kraken.com/0/public/OHLC';

/**
 * Kraken prefixes some assets with X (crypto) or Z (fiat). These
 * prefixes are stripped on pair strings — `XXBT` → `XBT`, `ZUSD` →
 * `USD`. Strip only when the remainder is 3+ chars to avoid mangling
 * legitimate 3-char tickers that begin with X/Z.
 */
function stripKrakenAssetPrefix(raw: string): string {
  if ((raw.startsWith('X') || raw.startsWith('Z')) && raw.length >= 4) {
    return raw.slice(1);
  }
  return raw;
}

/**
 * Kraken uses XBT (not BTC) and XDG (not DOGE) in its pair names.
 * Everything else passes through unchanged.
 */
function krakenPairBaseFor(strippedAsset: string): string {
  switch (strippedAsset) {
    case 'BTC':
      return 'XBT';
    case 'DOGE':
      return 'XDG';
    default:
      return strippedAsset;
  }
}

/**
 * Pull the Kraken-native asset code from the token's
 * `providerMetadata.kraken.asset` field that `KrakenProvider.fetchBalances`
 * writes when importing balances.
 */
export function readKrakenAssetCode(t: Token): string | null {
  const meta = t.providerMetadata as { kraken?: { asset?: unknown } } | string | null | undefined;
  if (!meta || typeof meta === 'string') {
    if (typeof meta === 'string') {
      try {
        const parsed = JSON.parse(meta) as { kraken?: { asset?: unknown } };
        const asset = parsed.kraken?.asset;
        return typeof asset === 'string' ? asset : null;
      } catch {
        return null;
      }
    }
    return null;
  }
  const asset = meta.kraken?.asset;
  return typeof asset === 'string' ? asset : null;
}

interface OhlcBar {
  timeSec: number;
  close: string;
}

/**
 * Per-pair cache. Kraken returns up to 720 daily bars in one call;
 * subsequent backfill lookups for the same pair serve from memory.
 * Without this cache the nightly backfill fires one HTTP call per
 * (token, day) and Kraken rate-limits us into oblivion.
 *
 * Lifetime: process. The provider instance is created at boot and
 * reused across every backfill run.
 */
const krakenOhlcCache = new Map<string, { bars: OhlcBar[]; maxBarSec: number }>();

/**
 * Walk cached bars from the end (ascending) and return the first
 * bar that's on-or-before `targetSec` — the "daily close that
 * covers `at`". O(n) on the 720-element max is fine.
 */
function priceFromCachedBars(
  tokenId: string,
  baseTokenId: string,
  bars: OhlcBar[],
  targetSec: number,
  source: string
): PriceQuote | null {
  let best: OhlcBar | null = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    if (!bar) continue;
    if (bar.timeSec <= targetSec) {
      best = bar;
      break;
    }
  }
  if (!best) return null;
  return {
    tokenId,
    baseTokenId,
    price: best.close,
    timestamp: new Date(best.timeSec * 1000),
    source,
  };
}

/**
 * Fetch a historical daily-close price for a Kraken-known token.
 * Returns null when the token isn't a Kraken asset, the pair isn't
 * available, or the network call fails — never throws.
 */
export async function fetchKrakenHistoricalPrice(
  token: Token,
  at: Date,
  ctx: ProviderContext
): Promise<PriceQuote | null> {
  const krakenAsset = readKrakenAssetCode(token);
  if (!krakenAsset) return null;

  const baseSymbol = ctx.baseCurrency.symbol.toUpperCase();
  const quoteForRequest = KRAKEN_SUPPORTED_QUOTES.has(baseSymbol) ? baseSymbol : 'USD';
  const stripped = stripKrakenAssetPrefix(krakenAsset);
  const pair = `${krakenPairBaseFor(stripped)}${quoteForRequest}`;
  const targetSec = Math.floor(at.getTime() / 1000);
  const sourceTag = quoteForRequest === baseSymbol ? 'kraken_klines' : 'kraken_klines_usd';

  const cached = krakenOhlcCache.get(pair);
  if (cached && targetSec <= cached.maxBarSec) {
    return priceFromCachedBars(token.id, ctx.baseCurrency.id, cached.bars, targetSec, sourceTag);
  }

  const url = `${KRAKEN_OHLC_URL}?pair=${encodeURIComponent(pair)}&interval=1440`;
  try {
    const response = await fetchWithTimeout(url, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      error?: string[];
      result?: Record<string, unknown>;
    };
    if (data.error && data.error.length > 0) return null;
    if (!data.result) return null;

    // Response shape: `{ 'XXBTZUSD': [[...], ...], last: 123 }`.
    // The single non-`last` key holds the bars.
    const pairKey = Object.keys(data.result).find((k) => k !== 'last');
    if (!pairKey) return null;
    const rawBars = data.result[pairKey];
    if (!Array.isArray(rawBars)) return null;

    // Each bar: [time, open, high, low, close, vwap, volume, count].
    // We only need (time, close).
    const bars: OhlcBar[] = [];
    for (const bar of rawBars as unknown[]) {
      if (!Array.isArray(bar) || bar.length < 5) continue;
      const timeSec = Number(bar[0]);
      if (!Number.isFinite(timeSec)) continue;
      bars.push({ timeSec, close: String(bar[4]) });
    }
    bars.sort((a, b) => a.timeSec - b.timeSec);
    const maxBarSec = bars.length > 0 ? (bars[bars.length - 1]?.timeSec ?? 0) : 0;
    krakenOhlcCache.set(pair, { bars, maxBarSec });

    return priceFromCachedBars(token.id, ctx.baseCurrency.id, bars, targetSec, sourceTag);
  } catch {
    return null;
  }
}
