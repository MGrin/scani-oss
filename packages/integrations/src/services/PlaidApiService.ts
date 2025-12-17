/**
 * PlaidApiService - Service for interacting with Plaid API
 *
 * Handles all Plaid API communication including:
 * - Link token creation
 * - Public token exchange
 * - Account fetching
 * - Balance retrieval
 * - Institution information
 */

import type { RateLimiter } from '../types';

// Plaid SDK types (will be available once plaid package is installed)
// For now, we define minimal types needed
interface PlaidLinkTokenCreateRequest {
  user: { client_user_id: string };
  client_name: string;
  products: string[];
  country_codes: string[];
  language: string;
  institution_id?: string;
}

interface PlaidLinkTokenResponse {
  link_token: string;
  expiration: string;
}

interface PlaidPublicTokenExchangeRequest {
  public_token: string;
}

interface PlaidPublicTokenExchangeResponse {
  access_token: string;
  item_id: string;
}

interface PlaidAccountsGetRequest {
  access_token: string;
}

interface PlaidAccount {
  account_id: string;
  balances: {
    available: number | null;
    current: number | null;
    limit: number | null;
    iso_currency_code: string | null;
    unofficial_currency_code: string | null;
  };
  mask: string | null;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
}

export interface PlaidAccountsResponse {
  accounts: PlaidAccount[];
  item: {
    item_id: string;
    institution_id: string | null;
    webhook: string | null;
  };
}

interface PlaidInstitutionGetRequest {
  institution_id: string;
  country_codes: string[];
}

interface PlaidInstitution {
  institution_id: string;
  name: string;
  products: string[];
  country_codes: string[];
  url: string | null;
  primary_color: string | null;
  logo: string | null;
}

interface PlaidItemGetRequest {
  access_token: string;
}

interface PlaidItemResponse {
  item: {
    item_id: string;
    institution_id: string | null;
    webhook: string | null;
    error: unknown | null;
    available_products: string[];
    billed_products: string[];
    consent_expiration_time: string | null;
  };
}

export class PlaidApiService {
  private baseUrl: string;
  private clientId: string;
  private secret: string;
  private rateLimiter: RateLimiter;

  constructor(
    environment: 'sandbox' | 'development' | 'production',
    clientId: string,
    secret: string,
    rateLimiter: RateLimiter
  ) {
    // Set base URL based on environment
    const envUrls = {
      sandbox: 'https://sandbox.plaid.com',
      development: 'https://development.plaid.com',
      production: 'https://production.plaid.com',
    };
    this.baseUrl = envUrls[environment];
    this.clientId = clientId;
    this.secret = secret;
    this.rateLimiter = rateLimiter;
  }

  /**
   * Create a Link token for Plaid Link frontend integration
   */
  async createLinkToken(request: PlaidLinkTokenCreateRequest): Promise<PlaidLinkTokenResponse> {
    return this.rateLimiter.execute(async () => {
      const response = await fetch(`${this.baseUrl}/link/token/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': this.clientId,
          'PLAID-SECRET': this.secret,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: Plaid API error response type is unknown
        const error = await response.json();
        throw new Error(`Plaid API error: ${(error as any)?.error_message || response.statusText}`);
      }

      return response.json() as Promise<PlaidLinkTokenResponse>;
    });
  }

  /**
   * Exchange a public token for an access token
   */
  async exchangePublicToken(
    request: PlaidPublicTokenExchangeRequest
  ): Promise<PlaidPublicTokenExchangeResponse> {
    return this.rateLimiter.execute(async () => {
      const response = await fetch(`${this.baseUrl}/item/public_token/exchange`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': this.clientId,
          'PLAID-SECRET': this.secret,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: Plaid API error response type is unknown
        const error = await response.json();
        throw new Error(`Plaid API error: ${(error as any)?.error_message || response.statusText}`);
      }

      // biome-ignore lint/suspicious/noExplicitAny: Plaid API response types vary by endpoint
      return response.json() as any;
    });
  }

  /**
   * Get accounts for an access token
   */
  async getAccounts(request: PlaidAccountsGetRequest): Promise<PlaidAccountsResponse> {
    return this.rateLimiter.execute(async () => {
      const response = await fetch(`${this.baseUrl}/accounts/get`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': this.clientId,
          'PLAID-SECRET': this.secret,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: Plaid API error response type is unknown
        const error = await response.json();
        throw new Error(`Plaid API error: ${(error as any)?.error_message || response.statusText}`);
      }

      // biome-ignore lint/suspicious/noExplicitAny: Plaid API response types vary by endpoint
      return response.json() as any;
    });
  }

  /**
   * Get balances for an access token (real-time balance check)
   */
  async getBalances(accessToken: string, accountIds?: string[]): Promise<PlaidAccountsResponse> {
    return this.rateLimiter.execute(async () => {
      const response = await fetch(`${this.baseUrl}/accounts/balance/get`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': this.clientId,
          'PLAID-SECRET': this.secret,
        },
        body: JSON.stringify({
          access_token: accessToken,
          options: accountIds ? { account_ids: accountIds } : undefined,
        }),
      });

      if (!response.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: Plaid API error response type is unknown
        const error = await response.json();
        throw new Error(`Plaid API error: ${(error as any)?.error_message || response.statusText}`);
      }

      // biome-ignore lint/suspicious/noExplicitAny: Plaid API response types vary by endpoint
      return response.json() as any;
    });
  }

  /**
   * Get institution information by ID
   */
  async getInstitution(request: PlaidInstitutionGetRequest): Promise<PlaidInstitution> {
    return this.rateLimiter.execute(async () => {
      const response = await fetch(`${this.baseUrl}/institutions/get_by_id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': this.clientId,
          'PLAID-SECRET': this.secret,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: Plaid API error response type is unknown
        const error = await response.json();
        throw new Error(`Plaid API error: ${(error as any)?.error_message || response.statusText}`);
      }

      // biome-ignore lint/suspicious/noExplicitAny: Plaid API response type is unknown
      const data = (await response.json()) as any;
      return data.institution;
    });
  }

  /**
   * Get item (connection) details
   */
  async getItem(request: PlaidItemGetRequest): Promise<PlaidItemResponse> {
    return this.rateLimiter.execute(async () => {
      const response = await fetch(`${this.baseUrl}/item/get`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': this.clientId,
          'PLAID-SECRET': this.secret,
        },
        body: JSON.stringify(request),
      });

      if (!response.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: Plaid API error response type is unknown
        const error = await response.json();
        throw new Error(`Plaid API error: ${(error as any)?.error_message || response.statusText}`);
      }

      // biome-ignore lint/suspicious/noExplicitAny: Plaid API response types vary by endpoint
      return response.json() as any;
    });
  }

  /**
   * Remove an item (disconnect)
   */
  async removeItem(accessToken: string): Promise<void> {
    return this.rateLimiter.execute(async () => {
      const response = await fetch(`${this.baseUrl}/item/remove`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'PLAID-CLIENT-ID': this.clientId,
          'PLAID-SECRET': this.secret,
        },
        body: JSON.stringify({
          access_token: accessToken,
        }),
      });

      if (!response.ok) {
        // biome-ignore lint/suspicious/noExplicitAny: Plaid API error response type is unknown
        const error = await response.json();
        throw new Error(`Plaid API error: ${(error as any)?.error_message || response.statusText}`);
      }
    });
  }
}
