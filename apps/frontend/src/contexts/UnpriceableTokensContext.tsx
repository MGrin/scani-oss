import type React from 'react';
import { createContext, useContext, useEffect, useState } from 'react';
import type { UnpriceableToken } from '@/components/ui/monetization-notification';

interface UnpriceableTokensContextType {
  unpriceableTokens: UnpriceableToken[] | undefined;
  notificationDismissed: boolean;
  setUnpriceableTokens: (tokens: UnpriceableToken[] | undefined) => void;
  setNotificationDismissed: (dismissed: boolean) => void;
  isTokenUnpriceable: (symbol: string) => boolean;
  isAccountAffected: (institutionName: string, accountName: string) => boolean;
  isInstitutionAffected: (institutionName: string) => boolean;
  hasUnpriceableTokensOfType: (
    tokenType: string,
    tokens: { symbol: string; typeName: string | null }[]
  ) => boolean;
  shouldHighlight: () => boolean;
}

const UnpriceableTokensContext = createContext<UnpriceableTokensContextType | undefined>(undefined);

export const useUnpriceableTokens = () => {
  const context = useContext(UnpriceableTokensContext);
  if (context === undefined) {
    throw new Error('useUnpriceableTokens must be used within an UnpriceableTokensProvider');
  }
  return context;
};

interface UnpriceableTokensProviderProps {
  children: React.ReactNode;
  unpriceableTokens?: UnpriceableToken[];
  notificationDismissed?: boolean;
}

export const UnpriceableTokensProvider: React.FC<UnpriceableTokensProviderProps> = ({
  children,
  unpriceableTokens: initialTokens,
  notificationDismissed: externalDismissed = false,
}) => {
  const [unpriceableTokens, setUnpriceableTokens] = useState<UnpriceableToken[] | undefined>(
    initialTokens
  );
  const [notificationDismissed, setNotificationDismissed] = useState(externalDismissed);

  // Update tokens when they change externally
  useEffect(() => {
    setUnpriceableTokens(initialTokens);
  }, [initialTokens]);

  // Update dismissed state when it changes externally
  useEffect(() => {
    setNotificationDismissed(externalDismissed);
  }, [externalDismissed]);

  const isTokenUnpriceable = (symbol: string): boolean => {
    if (!unpriceableTokens) return false;
    return unpriceableTokens.some((token) => token.symbol === symbol);
  };

  const isAccountAffected = (institutionName: string, accountName: string): boolean => {
    if (!unpriceableTokens) return false;
    return unpriceableTokens.some(
      (token) => token.institutionName === institutionName && token.accountName === accountName
    );
  };

  const isInstitutionAffected = (institutionName: string): boolean => {
    if (!unpriceableTokens) return false;
    return unpriceableTokens.some((token) => token.institutionName === institutionName);
  };

  const hasUnpriceableTokensOfType = (
    tokenType: string,
    tokens: { symbol: string; typeName: string | null }[]
  ): boolean => {
    if (!unpriceableTokens || !tokens) return false;
    // Get all token symbols of this type
    const tokenSymbolsOfType = tokens
      .filter((token) => token.typeName === tokenType)
      .map((token) => token.symbol);

    // Check if any of these symbols are in the unpriceable list
    return unpriceableTokens.some((unpriceableToken) =>
      tokenSymbolsOfType.includes(unpriceableToken.symbol)
    );
  };

  const shouldHighlight = (): boolean => {
    return Boolean(unpriceableTokens && unpriceableTokens.length > 0 && !notificationDismissed);
  };

  return (
    <UnpriceableTokensContext.Provider
      value={{
        unpriceableTokens,
        notificationDismissed,
        setUnpriceableTokens,
        setNotificationDismissed,
        isTokenUnpriceable,
        isAccountAffected,
        isInstitutionAffected,
        hasUnpriceableTokensOfType,
        shouldHighlight,
      }}
    >
      {children}
    </UnpriceableTokensContext.Provider>
  );
};
