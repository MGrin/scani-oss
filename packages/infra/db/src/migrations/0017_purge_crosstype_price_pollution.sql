-- Purge cross-asset-class price pollution from token_prices.
--
-- The historical-price backfill offered every provider whose canPrice()
-- accepted a token and stored the first non-empty result. Crypto
-- providers (DeFiLlama, CoinGecko) match purely by ticker, so a stock
-- ticker like BLK resolved to a same-symbol memecoin and stored a
-- ~$0.04 price alongside the correct ~$1000 yahoo-finance row. With both
-- rows present, findClosestPriceByGranularity returned whichever had the
-- later timestamp, so the portfolio chart oscillated day-to-day
-- (BLK: $0.02 <-> $480 on alternating days — prod incident 2026-05).
--
-- HistoricalPriceBackfillService now routes providers by token type
-- (crypto providers are no longer offered stock/fiat tokens). This
-- migration removes the bad rows already stored. Only crypto-sourced
-- rows on stock/fiat-typed tokens are deleted; the correct equity /
-- forex rows remain, so affected days stay priced. The derived
-- portfolio_value_daily cache should be rebuilt by a full rollup after
-- this migration so the chart reflects the cleaned prices.
--
-- Idempotent — a second run finds no matching rows.

DELETE FROM token_prices tp
USING tokens t, token_types tt
WHERE tp.token_id = t.id
  AND t.type_id = tt.id
  AND tt.code IN ('stock', 'fiat')
  AND (
    tp.source LIKE 'defillama%'
    OR tp.source LIKE 'coingecko%'
    OR tp.source LIKE 'kraken%'
    OR tp.source LIKE 'binance%'
  );
