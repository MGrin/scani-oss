/**
 * ScaniIntegration - Abstract base class for institution integrations
 *
 * This class provides the foundation for all institution integrations in Scani.
 * Concrete implementations should extend this class and implement the abstract methods.
 *
 * Supports multiple authentication types:
 * - OAuth 2.0 (for exchanges like Binance, Coinbase)
 * - RPC (for blockchain networks)
 * - API Key (for traditional brokers)
 * - Manual (for manual data entry)
 */

import type {
  AuthConfig,
  FetchAccountsResult,
  FetchHoldingsResult,
  ICredentialManager,
  IntegrationAuthType,
  IntegrationHolding,
  IntegrationStatus,
  IWalletManager,
  RateLimiter,
  TokenMappingResult,
} from './types';

export abstract class ScaniIntegration {
  protected readonly authConfig: AuthConfig;
  protected readonly rateLimiter?: RateLimiter;
  protected readonly institutionId: string;
  protected readonly credentialManager?: ICredentialManager;
  protected readonly walletManager?: IWalletManager;

  /**
   * Create a new integration instance
   * @param institutionId - The Scani institution ID
   * @param authConfig - Authentication configuration
   * @param rateLimiter - Optional rate limiter for API calls
   * @param credentialManager - Optional credential manager for encrypted credentials
   * @param walletManager - Optional wallet manager for user wallets
   */
  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    rateLimiter?: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    this.institutionId = institutionId;
    this.authConfig = authConfig;
    this.rateLimiter = rateLimiter;
    this.credentialManager = credentialManager;
    this.walletManager = walletManager;
  }

  /**
   * Get the authentication type for this integration
   */
  getAuthType(): IntegrationAuthType {
    return this.authConfig.type;
  }

  /**
   * Get the institution ID
   */
  getInstitutionId(): string {
    return this.institutionId;
  }

  /**
   * Check if the integration requires authentication
   * Manual integrations don't require auth
   */
  requiresAuthentication(): boolean {
    return this.authConfig.type !== 'manual';
  }

  /**
   * Fetch all accounts from the institution
   *
   * This method should retrieve all accounts/wallets available through the integration.
   * For blockchain integrations, this might return wallet addresses.
   * For exchange integrations, this returns trading accounts/subaccounts.
   *
   * @param credentials - User-specific credentials or tokens
   * @returns Promise resolving to list of accounts
   */
  abstract fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult>;

  /**
   * Fetch all holdings (token balances) for a specific account
   *
   * This method retrieves all asset holdings within a given account.
   * For blockchain wallets, this returns token balances on that chain.
   * For exchange accounts, this returns all trading pairs and balances.
   *
   * @param accountId - The external account ID from the institution
   * @param credentials - User-specific credentials or tokens
   * @returns Promise resolving to list of holdings
   */
  abstract fetchHoldings(
    accountId: string,
    credentials?: Record<string, unknown>
  ): Promise<FetchHoldingsResult>;

  /**
   * Map an institution's token representation to Scani's token format
   *
   * This method converts institution-specific token data into Scani's internal
   * token representation. It should handle:
   * - Symbol normalization (e.g., 'WETH' -> 'ETH')
   * - Token type detection (crypto, stock, fiat, etc.)
   * - Metadata extraction (contract address, decimals, etc.)
   *
   * @param holding - The holding data from the institution
   * @returns Promise resolving to token mapping result
   */
  abstract mapToken(holding: IntegrationHolding): Promise<TokenMappingResult>;

  /**
   * Check the health/status of the integration
   *
   * Optional method to verify the integration is operational.
   * Implementations can check:
   * - API connectivity
   * - Authentication validity
   * - Rate limit status
   *
   * @returns Promise resolving to integration status
   */
  async checkHealth(): Promise<IntegrationStatus> {
    // Default implementation - can be overridden
    return {
      isHealthy: true,
      details: {
        authType: this.authConfig.type,
        institutionId: this.institutionId,
      },
    };
  }

  /**
   * Validate credentials for the integration
   *
   * Optional method to validate user credentials before attempting API calls.
   * Useful for OAuth token validation, API key verification, etc.
   *
   * @param credentials - User-specific credentials to validate
   * @returns Promise resolving to true if credentials are valid
   */
  async validateCredentials(credentials?: Record<string, unknown>): Promise<boolean> {
    // Default implementation - can be overridden
    if (!this.requiresAuthentication()) {
      return true;
    }
    return credentials !== undefined && Object.keys(credentials).length > 0;
  }

  /**
   * Refresh authentication tokens (for OAuth integrations)
   *
   * Optional method for OAuth integrations to refresh access tokens.
   *
   * @param refreshToken - The refresh token
   * @returns Promise resolving to new credentials
   */
  async refreshAuthentication(_refreshToken: string): Promise<Record<string, unknown>> {
    throw new Error('Authentication refresh not implemented for this integration');
  }

  /**
   * Execute a function with rate limiting if configured
   *
   * @param fn - Function to execute
   * @returns Promise resolving to function result
   */
  protected async executeWithRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.rateLimiter) {
      return this.rateLimiter.execute(fn);
    }
    return fn();
  }
}
