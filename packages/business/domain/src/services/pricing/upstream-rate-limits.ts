import type { OutflowLimiterConfig } from '@scani/rate-limiter';

// Single source of truth for the per-key rate budgets we honour upstream.
// The outflow registry keys by namespace, so two consumers asking for the
// same constant here resolve to the same shared limiter and one coherent
// budget.
//
// Rates reflect the upstream provider's free-tier or contracted cap.
// Tighten only when we see provider-side 429s in production logs.
//
// CoinGecko / Finnhub limits used to live here too, but they're now
// configured in the @scani/providers data-provider tier (since all
// upstream HTTP for those APIs happens there). Only ExchangeRate-API
// is still called from the api process (CurrencyConverter inside
// `@scani/domain`'s pricing chain).

export const EXCHANGERATE_LIMIT: OutflowLimiterConfig = {
  namespace: 'exchangerate',
  maxRequests: 2,
  windowMs: 60_000,
};
