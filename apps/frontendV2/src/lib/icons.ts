import type { LucideIcon } from "lucide-react";
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
} from "lucide-react";

/**
 * Get favicon URL from a website URL
 * Uses Google's favicon service as a fallback
 */
export function getFaviconUrl(
  websiteUrl: string | null | undefined
): string | null {
  if (!websiteUrl) return null;

  try {
    const url = new URL(
      websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`
    );
    return `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=64`;
  } catch {
    return null;
  }
}

/**
 * Get icon component for token types
 * Note: Only handles seeded types: fiat, crypto, stock, private-company, other
 */
export const getTokenTypeIcon = (type: string): LucideIcon => {
  switch (type?.toLowerCase()) {
    case "fiat":
      return DollarSign;
    case "crypto":
    case "cryptocurrency":
      return Coins;
    case "stock":
      // 'stock' type covers Stock/ETF/Equity/Commodity
      return TrendingUp;
    case "private-company":
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
    case "checking":
      return Wallet;
    case "savings":
      return PiggyBank;
    case "investment":
      return TrendingUp;
    case "crypto":
      return Coins;
    default:
      return CreditCard;
  }
};

/**
 * Get icon component for institution types
 * Note: Database codes use underscores (crypto_exchange, real_estate, etc.)
 * Seeded types: bank, broker, crypto_wallet, crypto_exchange, investment_fund, private_equity, real_estate, other
 */
export const getInstitutionTypeIcon = (type: string): LucideIcon => {
  switch (type?.toLowerCase()) {
    case "bank":
      return Building;
    case "broker":
      return TrendingUp;
    case "crypto_wallet":
      return Wallet;
    case "crypto_exchange":
      return Coins;
    case "investment_fund":
      return TrendingUp;
    case "private_equity":
      return Building2;
    case "real_estate":
      return Home;
    case "other":
      return Building2;
    default:
      return Building; // Default for unknown institution types
  }
};
