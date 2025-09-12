import type { LucideIcon } from 'lucide-react';
import {
  Building,
  Coins,
  CreditCard,
  DollarSign,
  PiggyBank,
  TrendingUp,
  Wallet,
} from 'lucide-react';

// Type for token display information
export type TokenDisplay = {
  type: 'symbol' | 'icon';
  value: string | LucideIcon;
};

/**
 * Get symbol or icon for fiat currencies based on symbol
 */
export const getFiatCurrencyDisplay = (symbol: string): TokenDisplay => {
  switch (symbol?.toUpperCase()) {
    case 'USD':
      return { type: 'symbol', value: '$' };
    case 'EUR':
      return { type: 'symbol', value: '€' };
    case 'GBP':
      return { type: 'symbol', value: '£' };
    case 'JPY':
      return { type: 'symbol', value: '¥' };
    case 'RUB':
      return { type: 'symbol', value: '₽' };
    case 'KRW':
      return { type: 'symbol', value: '₩' };
    case 'INR':
      return { type: 'symbol', value: '₹' };
    case 'CHF':
      return { type: 'symbol', value: 'CHF' };
    case 'CAD':
    case 'AUD':
      return { type: 'symbol', value: '$' };
    case 'CNY':
      return { type: 'symbol', value: '¥' };
    case 'PLN':
      return { type: 'symbol', value: 'zł' };
    case 'BRL':
      return { type: 'symbol', value: 'R$' };
    case 'SEK':
      return { type: 'symbol', value: 'kr' };
    case 'DKK':
      return { type: 'symbol', value: 'kr' };
    case 'CZK':
      return { type: 'symbol', value: 'Kč' };
    default:
      return { type: 'icon', value: DollarSign }; // Default to dollar icon for unknown fiat currencies
  }
};

/**
 * Get symbol or icon for cryptocurrencies based on symbol
 * Most cryptocurrencies don't have standardized Unicode symbols, so we use generic crypto icon
 */
export const getCryptoCurrencyDisplay = (symbol: string): TokenDisplay => {
  switch (symbol?.toUpperCase()) {
    case 'BTC':
    case 'BITCOIN':
      return { type: 'symbol', value: '₿' }; // Bitcoin has an official Unicode symbol
    default:
      return { type: 'icon', value: Coins }; // Default to generic coins icon for other cryptocurrencies
  }
};

/**
 * Get icon component for token types (fallback function)
 */
export const getTokenTypeIcon = (type: string): LucideIcon => {
  switch (type?.toLowerCase()) {
    case 'fiat':
      return DollarSign;
    case 'crypto':
    case 'cryptocurrency':
      return Coins;
    case 'stock':
    case 'equity':
      return TrendingUp;
    case 'etf':
    case 'fund':
      return Building;
    case 'bond':
    case 'fixed_income':
      return CreditCard;
    case 'commodity':
      return Building; // Using Building for commodities (could represent storage/warehouses)
    default:
      return CreditCard;
  }
};

/**
 * Get icon component for account types
 */
export const getAccountTypeIcon = (type: string): LucideIcon => {
  switch (type?.toLowerCase()) {
    case 'checking':
    case 'current':
      return Wallet;
    case 'savings':
      return PiggyBank;
    case 'credit':
    case 'credit_card':
      return CreditCard;
    case 'investment':
    case 'brokerage':
    case 'trading':
      return TrendingUp;
    case 'crypto':
    case 'crypto_wallet':
      return Wallet;
    case 'retirement':
    case 'pension':
      return TrendingUp;
    case 'loan':
      return CreditCard; // Loans are similar to credit products
    default:
      return TrendingUp; // Default for unknown account types
  }
};

/**
 * Get the best display (symbol or icon) for a token based on both its type and symbol
 * This will show specific currency symbols when available, falling back to type icons
 */
export const getTokenDisplay = (type: string, symbol?: string): TokenDisplay => {
  // For fiat currencies, use specific currency symbols
  if (type?.toLowerCase() === 'fiat' && symbol) {
    return getFiatCurrencyDisplay(symbol);
  }

  // For cryptocurrencies, use specific crypto symbols/icons
  if ((type?.toLowerCase() === 'crypto' || type?.toLowerCase() === 'cryptocurrency') && symbol) {
    return getCryptoCurrencyDisplay(symbol);
  }

  // Fall back to type-based icons for other types (stocks, bonds, etc.)
  return { type: 'icon', value: getTokenTypeIcon(type) };
};

/**
 * Legacy function for backward compatibility - returns icon component
 * @deprecated Use getTokenDisplay instead for symbol support
 */
export const getTokenIcon = (type: string, symbol?: string): LucideIcon => {
  const display = getTokenDisplay(type, symbol);
  if (display.type === 'icon') {
    return display.value as LucideIcon;
  }
  // For symbols, return a generic icon based on type
  return getTokenTypeIcon(type);
};

/**
 * Unified icon getter that can handle both token and account types
 * @param type - The type string
 * @param category - Whether this is for 'token' or 'account' types
 */
export const getTypeIcon = (type: string, category: 'token' | 'account' = 'token'): LucideIcon => {
  if (category === 'account') {
    return getAccountTypeIcon(type);
  }
  return getTokenTypeIcon(type);
};
