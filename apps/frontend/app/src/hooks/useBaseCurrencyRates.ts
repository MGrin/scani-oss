import { useMemo } from 'react';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { trpc } from '@/lib/trpc';
import type { BaseCurrencyRate, ConversionContext, RatesStatus } from '@/v3/lib/paymentTotals';

/**
 * FX rates into the user's base currency, for every currency a surface is
 * about to print.
 *
 * Lives above the v2/v3 split next to `useBaseCurrency()` because both trees
 * need it: the user reported the per-currency total in both, and v2 is still
 * his default. Feed it the currency token ids actually on screen — the query
 * key is the sorted set, so two surfaces showing the same currencies share one
 * request, and a surface that gains a currency refetches only that once.
 *
 * The rates themselves come from `tokens.getBaseCurrencyRates`, i.e. the same
 * `CurrencyConverter` a portfolio valuation goes through. Nothing here fetches
 * or derives a rate of its own.
 */

/** Rates are cached server-side for 10 minutes; matching it here keeps a tab
 *  switch from re-asking for a figure that cannot have moved. */
const RATE_STALE_TIME_MS = 10 * 60 * 1000;

export interface BaseCurrencyRates extends ConversionContext {
  rateByCurrencyTokenId: Map<string, BaseCurrencyRate | null>;
  /** The symbol every converted figure is denominated in. */
  baseSymbol: string;
}

export function useBaseCurrencyRates(currencyTokenIds: readonly string[]): BaseCurrencyRates {
  const baseCurrency = useBaseCurrency();
  // Only a resolved base currency carries a real `tokens.id`; the placeholder
  // the context serves while its query is in flight would match nothing.
  const baseCurrencyTokenId = baseCurrency.isResolved ? baseCurrency.token.id : null;

  const requested = useMemo(() => {
    const unique = new Set(currencyTokenIds);
    if (baseCurrencyTokenId) unique.delete(baseCurrencyTokenId);
    return Array.from(unique).sort();
  }, [currencyTokenIds, baseCurrencyTokenId]);

  const rates = trpc.tokens.getBaseCurrencyRates.useQuery(
    { currencyTokenIds: requested },
    { enabled: Boolean(baseCurrencyTokenId) && requested.length > 0, staleTime: RATE_STALE_TIME_MS }
  );

  const rateByCurrencyTokenId = useMemo(() => {
    const map = new Map<string, BaseCurrencyRate | null>();
    for (const entry of rates.data?.rates ?? []) {
      map.set(entry.currencyTokenId, entry.rate ? { rate: entry.rate, asOf: entry.asOf } : null);
    }
    return map;
  }, [rates.data]);

  return {
    baseCurrencyTokenId,
    rateByCurrencyTokenId,
    baseSymbol: baseCurrency.symbol,
    ratesStatus: resolveStatus({
      baseCurrencyLoading: baseCurrency.isLoading,
      baseCurrencyTokenId,
      requestedCount: requested.length,
      failed: rates.isError,
      // Read off the DATA, not off `isLoading`. React Query v4 reports a
      // disabled query as `status: 'loading'` forever, so a flag-driven
      // version of this says "still coming" about a request that was never
      // made — which is how the figure below it would sit under a skeleton
      // that never resolves.
      answered: Boolean(rates.data),
    }),
  };
}

export interface StatusInputs {
  baseCurrencyLoading: boolean;
  baseCurrencyTokenId: string | null;
  requestedCount: number;
  failed: boolean;
  answered: boolean;
}

/**
 * Exported for its own test: this is the whole of SC-210's judgement about
 * what the app knows, and it is the one part of the fix a component test
 * cannot reach — every branch here is a react-query state that a static
 * render never enters.
 */
export function resolveStatus({
  baseCurrencyLoading,
  baseCurrencyTokenId,
  requestedCount,
  failed,
  answered,
}: StatusInputs): RatesStatus {
  if (baseCurrencyLoading) return 'loading';
  // Settled, and still no base currency: there is nothing to convert *into*,
  // so every figure on the surface is unknowable rather than merely late.
  if (!baseCurrencyTokenId) return 'unavailable';
  // Nothing foreign on screen. The query is disabled and the empty map is the
  // complete and correct answer, not a missing one.
  if (requestedCount === 0) return 'ready';
  if (failed) return 'unavailable';
  return answered ? 'ready' : 'loading';
}
