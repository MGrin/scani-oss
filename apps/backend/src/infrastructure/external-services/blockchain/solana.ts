/**
 * Solana Balance Service
 *
 * Fetches SOL balances using Solana public RPC endpoints
 * Supports Solana mainnet addresses (base58 format)
 */

import Decimal from 'decimal.js';
import { logger } from '../../../utils/logger';
import {
  type ChainBalanceService,
  ChainServiceError,
  InvalidAddressError,
  type TokenBalance,
} from './base';

/**
 * Solana address validation
 * Solana addresses are base58 encoded, 32-44 characters
 */
const SOLANA_ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Simple rate limiter for Solana RPC calls
 */
class SolanaRateLimiter {
  private requestCounts: { count: number; resetTime: number } = {
    count: 0,
    resetTime: Date.now() + 60000,
  };
  private readonly maxRequestsPerMinute = 30; // Public RPCs allow more
  private readonly windowMs = 60000;

  canMakeRequest(): boolean {
    const now = Date.now();

    if (now >= this.requestCounts.resetTime) {
      this.requestCounts = { count: 1, resetTime: now + this.windowMs };
      return true;
    }

    if (this.requestCounts.count < this.maxRequestsPerMinute) {
      this.requestCounts.count++;
      return true;
    }

    return false;
  }

  getTimeUntilReset(): number {
    return Math.max(0, this.requestCounts.resetTime - Date.now());
  }
}

export class SolanaService implements ChainBalanceService {
  private rateLimiter = new SolanaRateLimiter();
  private readonly LAMPORTS_PER_SOL = 1_000_000_000; // 1 SOL = 1 billion lamports

  getServiceName(): string {
    return 'SolanaService';
  }

  supportsChain(chainId: number): boolean {
    // Solana mainnet identifier (custom, not EVM)
    return chainId === -2; // Using -2 for Solana
  }

  /**
   * Validate Solana address format
   */
  private isValidSolanaAddress(address: string): boolean {
    return SOLANA_ADDRESS_PATTERN.test(address);
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    if (!this.isValidSolanaAddress(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    if (!this.rateLimiter.canMakeRequest()) {
      const waitTime = this.rateLimiter.getTimeUntilReset();
      logger.warn(`Solana RPC rate limit hit, wait ${waitTime}ms`);
      throw new ChainServiceError(
        `Rate limit exceeded, retry in ${Math.ceil(waitTime / 1000)}s`,
        chainId,
        address
      );
    }

    // Try multiple public RPC endpoints
    const rpcEndpoints = [
      'https://api.mainnet-beta.solana.com',
      'https://solana-api.projectserum.com',
      'https://rpc.ankr.com/solana',
    ];

    let lastError: unknown;
    for (const rpcUrl of rpcEndpoints) {
      try {
        const balance = await this.fetchBalanceFromRPC(rpcUrl, address);

        logger.info(`Fetched Solana balance for ${address}: ${balance.toString()} SOL`);

        return {
          address,
          chainId: -2, // Solana mainnet
          chainName: 'Solana',
          tokenSymbol: 'SOL',
          balance,
          decimals: 9,
        };
      } catch (error) {
        lastError = error;
        logger.warn(
          `Solana RPC ${rpcUrl} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    throw new ChainServiceError('All Solana RPC endpoints failed', chainId, address, lastError);
  }

  /**
   * Fetch balance from a Solana RPC endpoint
   */
  private async fetchBalanceFromRPC(rpcUrl: string, address: string): Promise<Decimal> {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [address],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Solana RPC HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as {
      error?: { message: string };
      result?: { value: number };
    };

    if (data.error) {
      throw new Error(`Solana RPC error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    if (!data.result || typeof data.result.value !== 'number') {
      throw new Error('Invalid RPC response format');
    }

    const balanceLamports = data.result.value;

    // Convert lamports to SOL
    return new Decimal(balanceLamports).div(this.LAMPORTS_PER_SOL);
  }
}

// Singleton instance
export const solanaService = new SolanaService();
