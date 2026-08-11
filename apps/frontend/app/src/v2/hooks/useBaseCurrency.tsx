import type { Token } from '@scani/shared';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

interface BaseCurrencyContextType {
  token: Token;
  symbol: string;
  isLoading: boolean;
  /** True once `token` carries a real `tokens.id`, not the display-only placeholder. */
  isResolved: boolean;
}

const DEFAULT_TOKEN = createCurrencyToken('USD');

const BaseCurrencyContext = createContext<BaseCurrencyContextType>({
  token: DEFAULT_TOKEN,
  symbol: 'USD',
  isLoading: true,
  isResolved: false,
});

export function BaseCurrencyProvider({ children }: { children: ReactNode }) {
  const { data: baseCurrency, isLoading } = trpc.users.getBaseCurrency.useQuery();

  const value = useMemo(() => {
    const symbol = baseCurrency?.symbol || 'USD';
    return {
      // `createCurrencyToken` synthesises a display-only placeholder
      // (`id: "currency-USD"`) for when the real base currency hasn't
      // resolved yet. Once it has, carry the actual DB id/name through —
      // callers that need a real `tokens.id` (e.g. defaulting a currency
      // picker) can't submit a synthetic one, since every FK on
      // `currencyTokenId` validates as `z.string().uuid()`.
      token: baseCurrency
        ? { ...createCurrencyToken(symbol), id: baseCurrency.id, name: baseCurrency.name }
        : createCurrencyToken(symbol),
      symbol,
      isLoading,
      isResolved: Boolean(baseCurrency),
    };
  }, [baseCurrency, isLoading]);

  return <BaseCurrencyContext.Provider value={value}>{children}</BaseCurrencyContext.Provider>;
}

export function useBaseCurrency() {
  return useContext(BaseCurrencyContext);
}
