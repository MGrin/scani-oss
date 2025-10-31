/**
 * Common types for blockchain integration services
 */

/**
 * Represents a token balance on a blockchain
 */
export interface TokenBalance {
  /** Token contract address (or native token identifier) */
  tokenAddress: string;
  /** Token symbol (e.g., 'ETH', 'USDC') */
  symbol: string;
  /** Token name (e.g., 'Ethereum', 'USD Coin') */
  name: string;
  /** Token balance as string for Decimal.js precision */
  balance: string;
  /** Number of decimal places for the token */
  decimals: number;
  /** Token icon/logo URL if available */
  iconUrl?: string;
  /** CoinGecko ID for pricing if available */
  coinGeckoId?: string;
  /** Whether this is a native token (ETH, BTC, SOL, etc.) */
  isNative: boolean;
  /** Chain-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Represents wallet information
 */
export interface WalletInfo {
  /** Wallet address */
  address: string;
  /** Human-readable name (e.g., ENS name) */
  displayName?: string;
  /** Chain ID or chain identifier */
  chainId: string | number;
  /** Chain name */
  chainName: string;
  /** All token balances in this wallet on this chain */
  balances: TokenBalance[];
}

/**
 * Result of wallet import operation
 */
export interface WalletImportResult {
  /** Wallet information for each chain */
  wallets: WalletInfo[];
  /** Total number of tokens found */
  totalTokens: number;
  /** Chains where the wallet was found */
  chainsDetected: string[];
}

/**
 * Base interface for blockchain service
 */
export interface IBlockchainService {
  /** Get the chain identifier */
  getChainId(): string | number;

  /** Get the chain name */
  getChainName(): string;

  /** Check if an address is valid for this blockchain */
  isValidAddress(address: string): boolean;

  /** Get all token balances for a wallet address */
  getTokenBalances(address: string): Promise<TokenBalance[]>;

  /** Check if wallet has any activity on this chain (optional, defaults to checking balances) */
  hasActivity?(address: string): Promise<boolean>;

  /** Get human-readable name for address (e.g., ENS) */
  resolveAddressName?(address: string): Promise<string | null>;
}

/**
 * Configuration for blockchain services
 */
export interface BlockchainServiceConfig {
  /** API key for the blockchain provider */
  apiKey?: string;
  /** Rate limiter for API calls */
  rateLimiter?: {
    execute: <T>(fn: () => Promise<T>) => Promise<T>;
  };
  /** Base URL for API endpoints */
  baseUrl?: string;
}
