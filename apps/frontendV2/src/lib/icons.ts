import type { LucideIcon } from 'lucide-react';
import {
  Building,
  Building2,
  Coins,
  CreditCard,
  DollarSign,
  Home,
  PiggyBank,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { normalizeSymbol } from '@/lib/utils';

// Type for token display information
export type TokenDisplay = {
  type: 'symbol' | 'icon';
  value: string | LucideIcon;
};

/**
 * Get symbol or icon for fiat currencies based on symbol
 */
export const getFiatCurrencyDisplay = (symbol: string): TokenDisplay => {
  switch (normalizeSymbol(symbol)) {
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
  switch (normalizeSymbol(symbol)) {
    case 'BTC':
    case 'BITCOIN':
      return { type: 'symbol', value: '₿' }; // Bitcoin has an official Unicode symbol
    default:
      return { type: 'icon', value: Coins }; // Default to generic coins icon for other cryptocurrencies
  }
};

/**
 * Get icon component for token types
 * Note: Only handles seeded types: fiat, crypto, stock, private-company, other
 */
export const getTokenTypeIcon = (type: string): LucideIcon => {
  switch (type?.toLowerCase()) {
    case 'fiat':
      return DollarSign;
    case 'crypto':
    case 'cryptocurrency':
      return Coins;
    case 'stock':
      // 'stock' type covers Stock/ETF/Equity/Commodity
      return TrendingUp;
    case 'private-company':
      return Building2;
    default:
      return CreditCard;
  }
};

/**
 * Get icon component for account types
 * Note: Only handles seeded types: checking, savings, investment, crypto, other
 */
export const getAccountTypeIcon = (type: string): LucideIcon => {
  switch (type?.toLowerCase()) {
    case 'checking':
      return Wallet;
    case 'savings':
      return PiggyBank;
    case 'investment':
      return TrendingUp;
    case 'crypto':
      return Coins;
    case 'real estate':
      return Home;
    default:
      return CreditCard;
  }
};

/**
 * Get icon component for institution types
 * Note: Only handles seeded types: bank, brokerage, crypto-exchange, real-estate, other
 */
export const getInstitutionTypeIcon = (type: string): LucideIcon => {
  switch (type?.toLowerCase()) {
    case 'bank':
      return Building;
    case 'brokerage':
      return TrendingUp;
    case 'crypto-exchange':
      return Coins;
    case 'real-estate':
    case 'real estate':
      return Home;
    default:
      return Building2;
  }
};
