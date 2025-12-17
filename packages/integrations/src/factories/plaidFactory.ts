/**
 * Plaid Integration Factory
 *
 * Provides factory functions for creating and managing Plaid integrations
 * without exposing implementation details to consumers
 */

import { PlaidIntegration } from '../implementations/PlaidIntegration';
import { plaidRateLimiter } from '../rate-limiters/plaid';
import { PlaidApiService } from '../services/PlaidApiService';
import type { AuthConfig } from '../types';
import { IntegrationAuthType } from '../types';

/**
 * Create a PlaidApiService instance
 * Uses environment variables for configuration
 */
export function createPlaidApiService(): PlaidApiService {
  const environment =
    (process.env.PLAID_ENV as 'sandbox' | 'development' | 'production') || 'sandbox';
  const clientId = process.env.PLAID_CLIENT_ID || '';
  const secret = process.env.PLAID_SECRET || '';

  if (!clientId || !secret) {
    throw new Error('PLAID_CLIENT_ID and PLAID_SECRET environment variables are required');
  }

  return new PlaidApiService(environment, clientId, secret, plaidRateLimiter);
}

/**
 * Create a PlaidIntegration instance
 */
export function createPlaidIntegration(institutionId: string): PlaidIntegration {
  const service = createPlaidApiService();

  // Plaid uses OAuth-like flow with Link
  const authConfig: AuthConfig = {
    type: IntegrationAuthType.OAUTH,
    clientId: process.env.PLAID_CLIENT_ID || '',
    clientSecret: process.env.PLAID_SECRET || '',
    tokenEndpoint: '', // Not used directly, handled by Plaid SDK
    authorizationEndpoint: '', // Not used directly, handled by Plaid Link
  };

  return new PlaidIntegration(institutionId, authConfig, service, plaidRateLimiter);
}

/**
 * Create a Plaid Link token for user authentication
 * This token is used by the frontend Plaid Link component
 */
export async function createPlaidLinkToken(
  userId: string,
  institutionId?: string
): Promise<{ linkToken: string; expiration: string }> {
  const service = createPlaidApiService();

  const response = await service.createLinkToken({
    user: { client_user_id: userId },
    client_name: 'Scani Finance',
    products: ['auth'], // Only auth product for accounts and balances
    country_codes: ['US', 'CA', 'GB', 'FR', 'DE', 'ES', 'IE', 'NL'],
    language: 'en',
    institution_id: institutionId,
  });

  return {
    linkToken: response.link_token,
    expiration: response.expiration,
  };
}

/**
 * Exchange Plaid public token for access token
 * Called after user completes Plaid Link flow
 */
export async function exchangePlaidPublicToken(
  publicToken: string
): Promise<{ accessToken: string; itemId: string }> {
  const service = createPlaidApiService();

  const response = await service.exchangePublicToken({
    public_token: publicToken,
  });

  return {
    accessToken: response.access_token,
    itemId: response.item_id,
  };
}

/**
 * Get Plaid institution information
 * Used to fetch institution details when creating/updating institution records
 */
export async function getPlaidInstitution(
  plaidInstitutionId: string,
  countryCodes: string[] = ['US']
): Promise<{
  institutionId: string;
  name: string;
  url: string | null;
  logo: string | null;
  primaryColor: string | null;
}> {
  const service = createPlaidApiService();

  const institution = await service.getInstitution({
    institution_id: plaidInstitutionId,
    country_codes: countryCodes,
  });

  return {
    institutionId: institution.institution_id,
    name: institution.name,
    url: institution.url,
    logo: institution.logo,
    primaryColor: institution.primary_color,
  };
}

/**
 * Validate Plaid access token
 */
export async function validatePlaidAccessToken(accessToken: string): Promise<boolean> {
  try {
    const service = createPlaidApiService();
    await service.getItem({
      access_token: accessToken,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get Plaid accounts for an access token
 */
export async function getPlaidAccounts(accessToken: string) {
  const service = createPlaidApiService();
  return service.getAccounts({
    access_token: accessToken,
  });
}

/**
 * Get Plaid balances for an access token
 */
export async function getPlaidBalances(accessToken: string, accountIds?: string[]) {
  const service = createPlaidApiService();
  return service.getBalances(accessToken, accountIds);
}

/**
 * Remove Plaid item (disconnect)
 */
export async function removePlaidItem(accessToken: string): Promise<void> {
  const service = createPlaidApiService();
  return service.removeItem(accessToken);
}
