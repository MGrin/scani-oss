-- Restore `source = 'manual'` on manual custom-token prices that the
-- intraday->daily downsample rewrote.
--
-- A manual price is written with the default granularity ('intraday'), so
-- `downsampleIntradayToDaily` treated it as a sample of a curve: after the
-- retention window it inserted a synthesized daily row stamped
-- 'downsample-daily' and deleted the original. The price survived — every
-- valuation reads `findLatestPricesForTokensAnyBase` and kept pricing the
-- holding — but its provenance did not, so
-- `findLatestManualPricesForTokensAnyBase` stopped finding it and /tokens
-- reported "Never priced" for positions the same session valued at six
-- figures (SC-77 2).
--
-- The repository no longer collapses manual rows, which stops new damage.
-- This repairs what already happened, using `token_price_edit_history` —
-- the append-only log of manual edits, which the downsample never touched —
-- as the evidence that a given (token, base, day) price came from a person.
--
-- Deliberately narrow: only custom-typed tokens, only rows the downsample
-- itself stamped, and only where an edit was logged for the same token,
-- base currency and UTC day. Idempotent — a second run matches nothing,
-- because the first run left no 'downsample-daily' row behind that has a
-- matching edit.

UPDATE token_prices tp
SET source = 'manual'
FROM tokens t, token_types tt, token_price_edit_history h
WHERE tp.token_id = t.id
  AND t.type_id = tt.id
  AND tt.code IN ('private-company', 'other')
  AND tp.source = 'downsample-daily'
  AND h.token_id = tp.token_id
  AND h.base_token_id = tp.base_token_id
  AND date_trunc('day', h.created_at AT TIME ZONE 'UTC')
      = date_trunc('day', tp."timestamp" AT TIME ZONE 'UTC');
