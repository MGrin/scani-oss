import type { Token } from '@scani/shared';
import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

interface BaseCurrencyContextType {
  token: Token;
  symbol: string;
  isLoading: boolean;
  /** True once `token` carries a real `tokens.id`, not the display-only placeholder. */
  isResolved: boolean;
}

/**
 * `null` rather than a USD-shaped default on purpose. The default used to be a
 * fully-formed `{ symbol: 'USD' }`, so a subtree mounted outside the provider
 * rendered real money under the wrong symbol without a warning anywhere — the
 * v3 tree spent V3-13 in exactly that state. A missing provider is a
 * programming error; it should stop the render, not price a portfolio.
 */
const BaseCurrencyContext = createContext<BaseCurrencyContextType | null>(null);

export function BaseCurrencyProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const { data: baseCurrency, isLoading } = trpc.users.getBaseCurrency.useQuery();

  const value = useMemo(() => {
    const symbol = baseCurrency?.symbol || 'USD';
    return {
      // `createCurrencyToken` synthesises a display-only placeholder
      // (`id: "currency-USD"`) for when the real base currency hasn't
      // resolved yet. Once it has, carry the actual DB **id** through —
      // callers that need a real `tokens.id` (e.g. defaulting a currency
      // picker) can't submit a synthetic one, since every FK on
      // `currencyTokenId` validates as `z.string().uuid()`.
      //
      // The NAME is deliberately not carried across (SC-419). This used to
      // spread `name: baseCurrency.name` over the CLDR one, so the placeholder
      // was translated and the real value that replaced it a frame later was
      // `tokens.name` — an English string in Postgres. The base currency is
      // always fiat, so the derived name is right for every row and needs no
      // type check.
      token: baseCurrency
        ? { ...createCurrencyToken(t, symbol), id: baseCurrency.id }
        : createCurrencyToken(t, symbol),
      symbol,
      isLoading,
      isResolved: Boolean(baseCurrency),
    };
  }, [baseCurrency, isLoading, t]);

  return <BaseCurrencyContext.Provider value={value}>{children}</BaseCurrencyContext.Provider>;
}

export function useBaseCurrency(): BaseCurrencyContextType {
  const value = useContext(BaseCurrencyContext);
  if (!value) {
    throw new Error(
      'useBaseCurrency() was called outside <BaseCurrencyProvider>. The provider is mounted above the v2/v3 split in App.tsx — a subtree that renders without it would show amounts in the wrong currency.'
    );
  }
  return value;
}
