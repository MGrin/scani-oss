/**
 * Types for the institution integration system
 */

import type { NewToken } from '@scani/db/schema';
import type { IRateLimiter } from '@scani/rate-limiter';

/**
 * Rate limiter type - re-exported from @scani/rate-limiter package
 * Used for rate-limiting API calls to external services
 */
export type { IRateLimiter as RateLimiter };

/**
 * Authentication type for institution integrations
 */
export enum IntegrationAuthType {
  /** OAuth 2.0 authentication (e.g., Binance, Coinbase) */
  OAUTH = 'oauth',
  /** RPC/Blockchain connection (e.g., Ethereum, Bitcoin) */
  RPC = 'rpc',
  /** API Key authentication (e.g., traditional brokers) */
  API_KEY = 'api_key',
  /** Manual entry - no automatic sync */
  MANUAL = 'manual',
}

/**
 * Configuration for different authentication types
 */
export type AuthConfig =
  | {
      type: IntegrationAuthType.OAUTH;
      clientId: string;
      clientSecret: string;
      redirectUri?: string;
      scopes?: string[];
      tokenEndpoint: string;
      authorizationEndpoint: string;
    }
  | {
      type: IntegrationAuthType.RPC;
      rpcUrl: string;
      apiKey?: string;
      chainId?: string | number;
    }
  | {
      type: IntegrationAuthType.API_KEY;
      apiKey: string;
      baseUrl: string;
      headers?: Record<string, string>;
    }
  | {
      type: IntegrationAuthType.MANUAL;
      // No configuration needed for manual entry
    };

/**
 * Represents an account from an institution
 */
export interface IntegrationAccount {
  /** External ID from the institution */
  externalId: string;
  /** Account name/label */
  name: string;
  /** Account type code */
  accountType: string;
  /** Account description (optional) */
  description?: string;
  /** Additional metadata specific to the institution */
  metadata?: Record<string, unknown>;
  /** Whether the account is active */
  isActive?: boolean;
}

/**
 * Represents a holding (token balance) in an account
 */
export interface IntegrationHolding {
  /** Token symbol (e.g., 'BTC', 'ETH', 'AAPL') */
  symbol: string;
  /** Token name */
  name: string;
  /** Balance amount as string for Decimal.js precision */
  balance: string;
  /** Number of decimal places */
  decimals: number;
  /** Token type (crypto, stock, fiat, etc.) */
  tokenType?: string;
  /** Token identifier from the institution */
  externalTokenId?: string;
  /** Token contract address (for blockchain tokens) */
  contractAddress?: string;
  /** Icon/logo URL */
  iconUrl?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of fetching accounts from an institution
 */
export interface FetchAccountsResult {
  /** List of accounts */
  accounts: IntegrationAccount[];
  /** Total number of accounts */
  total: number;
  /** Any errors encountered (non-fatal) */
  errors?: string[];
}

/**
 * Result of fetching holdings for an account
 */
export interface FetchHoldingsResult {
  /** List of holdings */
  holdings: IntegrationHolding[];
  /** Total number of holdings */
  total: number;
  /** Account identifier */
  accountId: string;
  /** Timestamp of the fetch */
  timestamp: Date;
  /** Any errors encountered (non-fatal) */
  errors?: string[];
}

/**
 * Token mapping result from institution to Scani representation
 * Uses NewToken from @scani/domain for type safety
 */
export interface TokenMappingResult {
  /** Successfully mapped token - uses NewToken type for creation/matching */
  token: Omit<NewToken, 'isActive' | 'createdAt' | 'updatedAt'>;
  /** Whether this is a new token or existing */
  isNew: boolean;
  /** Confidence level of the mapping (0-1) */
  confidence: number;
  /** Any warnings about the mapping */
  warnings?: string[];
}

/**
 * Integration status and health information
 */
export interface IntegrationStatus {
  /** Whether the integration is operational */
  isHealthy: boolean;
  /** Last successful sync timestamp */
  lastSync?: Date;
  /** Last error message */
  lastError?: string;
  /** Additional status details */
  details?: Record<string, unknown>;
}

/**
 * Credential management service interface
 * For managing encrypted credentials in the database
 */
export interface ICredentialManager {
  /**
   * Get decrypted credentials for a user and institution
   */
  getCredentials(userId: string, institutionId: string): Promise<Record<string, unknown> | null>;

  /**
   * Store encrypted credentials
   */
  storeCredentials(
    userId: string,
    institutionId: string,
    credentials: Record<string, unknown>,
    credentialsType: string,
    expiresAt?: Date
  ): Promise<void>;

  /**
   * Update existing credentials
   */
  updateCredentials(
    userId: string,
    institutionId: string,
    credentials: Record<string, unknown>
  ): Promise<void>;

  /**
   * Delete credentials
   */
  deleteCredentials(userId: string, institutionId: string): Promise<void>;

  /**
   * Check if credentials are expired
   */
  areCredentialsExpired(userId: string, institutionId: string): Promise<boolean>;
}

/**
 * Wallet management service interface
 * For managing user wallets and their network associations
 */
export interface IWalletManager {
  /**
   * Get all wallets for a user
   */
  getUserWallets(userId: string): Promise<UserWalletInfo[]>;

  /**
   * Get wallet by address
   */
  getWalletByAddress(userId: string, walletAddress: string): Promise<UserWalletInfo | null>;

  /**
   * Create a new wallet
   */
  createWallet(
    userId: string,
    walletAddress: string,
    institutionIds: string[],
    label?: string
  ): Promise<UserWalletInfo>;

  /**
   * Add institution to wallet
   */
  addInstitutionToWallet(walletId: string, institutionId: string): Promise<void>;

  /**
   * Remove institution from wallet
   */
  removeInstitutionFromWallet(walletId: string, institutionId: string): Promise<void>;

  /**
   * Delete wallet
   */
  deleteWallet(walletId: string): Promise<void>;
}

/**
 * User wallet information
 */
export interface UserWalletInfo {
  /** Wallet ID */
  id: string;
  /** User ID */
  userId: string;
  /** Wallet address */
  walletAddress: string;
  /** List of institution IDs (networks) this wallet exists on */
  institutionIds: string[];
  /** Optional user-friendly label */
  label?: string;
  /** Whether the wallet is active */
  isActive: boolean;
  /** Creation timestamp */
  createdAt: Date;
  /** Last update timestamp */
  updatedAt: Date;
}

/**
 * OAuth token credentials
 */
export interface OAuthCredentials {
  /** Access token */
  accessToken: string;
  /** Refresh token (optional) */
  refreshToken?: string;
  /** Token type (usually 'Bearer') */
  tokenType?: string;
  /** Token expiration in seconds */
  expiresIn?: number;
  /** Scopes granted */
  scopes?: string[];
}

/**
 * API key credentials
 */
export interface ApiKeyCredentials {
  /** API key */
  apiKey: string;
  /** API secret (optional) */
  apiSecret?: string;
  /** Additional key metadata */
  metadata?: Record<string, unknown>;
}

/**
 * RPC credentials
 * Note: EVM-compatible chains (Ethereum, Polygon, Arbitrum, etc.) typically use
 * the API_KEY integration type with Etherscan V2 API rather than direct RPC.
 * This type is for blockchains that require direct RPC connections (Bitcoin, Solana, TON, etc.)
 */
export interface RpcCredentials {
  /** RPC URL */
  rpcUrl: string;
  /** API key (optional, for authenticated RPC endpoints) */
  apiKey?: string;
  /** Chain ID (for multi-chain RPC endpoints) */
  chainId?: string | number;
}
