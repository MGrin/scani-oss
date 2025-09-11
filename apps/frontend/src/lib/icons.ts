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
import { FaDollarSign, FaEuroSign, FaPoundSign, FaYenSign } from 'react-icons/fa';
// Import specific currency and crypto icons from react-icons
import {
  SiBitcoin,
  SiCardano,
  SiChainlink,
  SiDogecoin,
  SiEthereum,
  SiLitecoin,
  SiPolkadot,
  SiPolygon,
  SiRipple,
  SiSolana,
} from 'react-icons/si';

import {
  TbCurrencyDollarAustralian,
  TbCurrencyDollarCanadian,
  TbCurrencyFrank,
  TbCurrencyKroneCzech,
  TbCurrencyKroneDanish,
  TbCurrencyKroneSwedish,
  TbCurrencyReal,
  TbCurrencyRubel,
  TbCurrencyRupee,
  TbCurrencyWon,
  TbCurrencyZloty,
} from 'react-icons/tb';

/**
 * Get specific icon for fiat currencies based on symbol
 */
export const getFiatCurrencyIcon = (
  symbol: string
): React.ComponentType<{ className?: string }> => {
  switch (symbol?.toUpperCase()) {
    case 'USD':
      return FaDollarSign;
    case 'EUR':
      return FaEuroSign;
    case 'GBP':
      return FaPoundSign;
    case 'JPY':
      return FaYenSign;
    case 'RUB':
      return TbCurrencyRubel;
    case 'KRW':
      return TbCurrencyWon;
    case 'INR':
      return TbCurrencyRupee;
    case 'CHF':
      return TbCurrencyFrank;
    case 'CZK':
      return TbCurrencyKroneCzech;
    case 'SEK':
      return TbCurrencyKroneSwedish;
    case 'DKK':
      return TbCurrencyKroneDanish;
    case 'PLN':
      return TbCurrencyZloty;
    case 'BRL':
      return TbCurrencyReal;
    case 'CAD':
      return TbCurrencyDollarCanadian;
    case 'AUD':
      return TbCurrencyDollarAustralian;
    default:
      return FaDollarSign; // Default to dollar sign for unknown fiat currencies
  }
};

/**
 * Get specific icon for cryptocurrencies based on symbol
 */
export const getCryptoCurrencyIcon = (
  symbol: string
): React.ComponentType<{ className?: string }> => {
  switch (symbol?.toUpperCase()) {
    case 'BTC':
    case 'BITCOIN':
      return SiBitcoin;
    case 'ETH':
    case 'ETHEREUM':
      return SiEthereum;
    case 'LTC':
    case 'LITECOIN':
      return SiLitecoin;
    case 'DOGE':
    case 'DOGECOIN':
      return SiDogecoin;
    case 'ADA':
    case 'CARDANO':
      return SiCardano;
    case 'DOT':
    case 'POLKADOT':
      return SiPolkadot;
    case 'LINK':
    case 'CHAINLINK':
      return SiChainlink;
    case 'SOL':
    case 'SOLANA':
      return SiSolana;
    case 'MATIC':
    case 'POLYGON':
      return SiPolygon;
    case 'XRP':
    case 'RIPPLE':
      return SiRipple;
    default:
      return Coins; // Default to generic coins icon for unknown cryptocurrencies
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
 * Get the best icon for a token based on both its type and symbol
 * This will show specific currency/crypto icons when available, falling back to type icons
 */
export const getTokenIcon = (
  type: string,
  symbol?: string
): React.ComponentType<{ className?: string }> => {
  // For fiat currencies, use specific currency icons
  if (type?.toLowerCase() === 'fiat' && symbol) {
    return getFiatCurrencyIcon(symbol);
  }

  // For cryptocurrencies, use specific crypto icons
  if ((type?.toLowerCase() === 'crypto' || type?.toLowerCase() === 'cryptocurrency') && symbol) {
    return getCryptoCurrencyIcon(symbol);
  }

  // Fall back to type-based icons for other types (stocks, bonds, etc.)
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
