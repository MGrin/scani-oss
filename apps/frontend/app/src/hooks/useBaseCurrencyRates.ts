import { useMemo } from 'react';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { trpc } from '@/lib/trpc';
import type { BaseCurrencyRate, ConversionContext } from '@/v2/lib/paymentTotals';

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
  /** True while the base currency or the rates are still in flight. */
  isLoading: boolean;
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
    isLoading: baseCurrency.isLoading || (requested.length > 0 && rates.isLoading),
  };
}
