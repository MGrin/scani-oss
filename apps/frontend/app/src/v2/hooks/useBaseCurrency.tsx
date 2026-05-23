import type { Token } from '@scani/shared';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

interface BaseCurrencyContextType {
  token: Token;
  symbol: string;
  isLoading: boolean;
}

const DEFAULT_TOKEN = createCurrencyToken('USD');

const BaseCurrencyContext = createContext<BaseCurrencyContextType>({
  token: DEFAULT_TOKEN,
  symbol: 'USD',
  isLoading: true,
});

export function BaseCurrencyProvider({ children }: { children: ReactNode }) {
  const { data: baseCurrency, isLoading } = trpc.users.getBaseCurrency.useQuery();

  const value = useMemo(() => {
    const symbol = baseCurrency?.symbol || 'USD';
    return {
      token: createCurrencyToken(symbol),
      symbol,
      isLoading,
    };
  }, [baseCurrency?.symbol, isLoading]);

  return <BaseCurrencyContext.Provider value={value}>{children}</BaseCurrencyContext.Provider>;
}

export function useBaseCurrency() {
  return useContext(BaseCurrencyContext);
}
