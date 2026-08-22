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
import { apiBaseUrl } from './api-base-url';

/**
 * Where an institution's mark comes from (SC-208).
 *
 * This used to be `www.google.com/s2/favicons?domain=<host>`, which made every
 * row of the holdings table a third-party request to google.com from a finance
 * app: exactly the shape content blockers exist to stop, unreachable from
 * China, and an undocumented endpoint that had already changed under us once
 * (the 301 behind SC-203). The api now resolves and serves these itself.
 *
 * **Keyed on the institution id, not its website.** The server takes the
 * website from the row rather than from the caller, so this URL cannot be used
 * to make the backend fetch an arbitrary address.
 *
 * `website` is still read, and only to decide whether to ask at all: an
 * institution with no site has no icon, and skipping the request means the
 * letter tile is drawn immediately instead of after a round trip. A row that
 * has a website but no resolvable icon gets a 404 and the same letter tile,
 * one request later.
 */
export function institutionIconUrl(
  institution: { id: string; website?: string | null } | null | undefined
): string | null {
  if (!institution?.website) return null;
  return `${apiBaseUrl()}/institution-icons/${encodeURIComponent(institution.id)}`;
}

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
    case 'bank':
      return Building;
    case 'broker':
      return TrendingUp;
    case 'crypto_wallet':
      return Wallet;
    case 'crypto_exchange':
      return Coins;
    case 'investment_fund':
      return TrendingUp;
    case 'private_equity':
      return Building2;
    case 'real_estate':
      return Home;
    case 'other':
      return Building2;
    default:
      return Building; // Default for unknown institution types
  }
};
