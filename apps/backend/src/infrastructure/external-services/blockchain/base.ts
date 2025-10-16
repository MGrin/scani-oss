/**
 * Chain Balance Service
 *
 * Provides balance fetching for different blockchain types with proper rate limiting
 */

import type Decimal from 'decimal.js';

/**
 * Balance result for a single token on a specific chain
 */
export interface TokenBalance {
  address: string; // Wallet address
  chainId: number;
  chainName: string;
  tokenSymbol: string; // Native token symbol (ETH, BNB, etc.)
  balance: Decimal;
  decimals: number;
  tokenAddress?: string; // Contract address for ERC-20 tokens (undefined for native)
  tokenName?: string; // Full token name
  coingeckoId?: string; // CoinGecko ID for pricing
}

/**
 * ERC-20 token metadata
 */
export interface ERC20TokenInfo {
  address: string; // Contract address
  symbol: string;
  name: string;
  decimals: number;
  coingeckoId?: string;
}

/**
 * ERC-20 token balance with metadata
 */
export interface ERC20TokenBalance extends ERC20TokenInfo {
  balance: Decimal;
  chainId: number;
  chainName: string;
  walletAddress: string;
}

/**
 * Base interface for chain balance services
 */
export interface ChainBalanceService {
  /**
   * Fetch native token balance for an address
   */
  getNativeBalance(address: string, chainId: number): Promise<TokenBalance>;

  /**
   * Check if service supports a specific chain
   */
  supportsChain(chainId: number): boolean;

  /**
   * Get service name for logging/debugging
   */
  getServiceName(): string;
}

/**
 * Extended interface for chains that support ERC-20 tokens
 */
export interface ERC20BalanceService extends ChainBalanceService {
  /**
   * Get balance for a specific ERC-20 token
   */
  getTokenBalance(
    walletAddress: string,
    tokenAddress: string,
    chainId: number
  ): Promise<ERC20TokenBalance>;

  /**
   * Get balances for multiple ERC-20 tokens
   */
  getMultipleTokenBalances(
    walletAddress: string,
    tokenAddresses: string[],
    chainId: number
  ): Promise<ERC20TokenBalance[]>;

  /**
   * Get token metadata (name, symbol, decimals)
   */
  getTokenInfo(tokenAddress: string, chainId: number): Promise<ERC20TokenInfo>;
}

/**
 * Error types for chain services
 */
export class ChainServiceError extends Error {
  constructor(
    message: string,
    public readonly chainId: number,
    public readonly address: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'ChainServiceError';
  }
}

export class RateLimitError extends ChainServiceError {
  constructor(chainId: number, address: string) {
    super('Rate limit exceeded for RPC calls', chainId, address);
    this.name = 'RateLimitError';
  }
}

export class InvalidAddressError extends ChainServiceError {
  constructor(chainId: number, address: string) {
    super(`Invalid address format: ${address}`, chainId, address);
    this.name = 'InvalidAddressError';
  }
}

export class UnsupportedChainError extends ChainServiceError {
  constructor(chainId: number, address: string) {
    super(`Chain ID ${chainId} is not supported`, chainId, address);
    this.name = 'UnsupportedChainError';
  }
}
