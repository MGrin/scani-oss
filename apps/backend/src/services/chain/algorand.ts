/**
 * Algorand Balance Service
 *
 * Fetches ALGO balances using Algorand public API endpoints
 * Supports Algorand mainnet addresses (base32 format)
 */

import Decimal from 'decimal.js';
import { logger } from '../../utils/logger';
import {
  type ChainBalanceService,
  ChainServiceError,
  InvalidAddressError,
  type TokenBalance,
} from './base';

/**
 * Algorand address validation
 * Algorand addresses are 58 characters, base32 encoded
 */
const ALGORAND_ADDRESS_PATTERN = /^[A-Z2-7]{58}$/;

/**
 * Simple rate limiter for Algorand API calls
 */
class AlgorandRateLimiter {
  private requestCounts: { count: number; resetTime: number } = {
    count: 0,
    resetTime: Date.now() + 60000,
  };
  private readonly maxRequestsPerMinute = 30;
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

export class AlgorandService implements ChainBalanceService {
  private rateLimiter = new AlgorandRateLimiter();
  private readonly MICROALGOS_PER_ALGO = 1_000_000; // 1 ALGO = 1,000,000 microalgos
  private readonly CHAIN_ID = -10; // Custom chain ID for Algorand

  getServiceName(): string {
    return 'AlgorandService';
  }

  supportsChain(chainId: number): boolean {
    return chainId === this.CHAIN_ID;
  }

  /**
   * Validate Algorand address format
   */
  private isValidAlgorandAddress(address: string): boolean {
    return ALGORAND_ADDRESS_PATTERN.test(address);
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    if (!this.isValidAlgorandAddress(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    if (!this.rateLimiter.canMakeRequest()) {
      const waitTime = this.rateLimiter.getTimeUntilReset();
      logger.warn(`Algorand API rate limit hit, wait ${waitTime}ms`);
      throw new ChainServiceError(
        `Rate limit exceeded, retry in ${Math.ceil(waitTime / 1000)}s`,
        chainId,
        address
      );
    }

    // Try multiple public API endpoints
    const apiEndpoints = [
      'https://mainnet-api.algonode.cloud',
      'https://mainnet-api.4160.nodely.dev',
      'https://mainnet-idx.algonode.cloud',
    ];

    let lastError: unknown;
    for (const apiUrl of apiEndpoints) {
      try {
        const balance = await this.fetchBalanceFromAPI(apiUrl, address);

        logger.info(`Fetched Algorand balance for ${address}: ${balance.toString()} ALGO`);

        return {
          address,
          chainId: this.CHAIN_ID,
          chainName: 'Algorand',
          tokenSymbol: 'ALGO',
          balance,
          decimals: 6,
        };
      } catch (error) {
        lastError = error;
        logger.warn(
          `Algorand API ${apiUrl} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    throw new ChainServiceError('All Algorand API endpoints failed', chainId, address, lastError);
  }

  /**
   * Fetch balance from an Algorand API endpoint
   */
  private async fetchBalanceFromAPI(apiUrl: string, address: string): Promise<Decimal> {
    const response = await fetch(`${apiUrl}/v2/accounts/${address}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Algorand API HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as {
      amount?: number;
      'min-balance'?: number;
    };

    if (typeof data.amount !== 'number') {
      throw new Error('Invalid API response format');
    }

    const balanceMicroAlgos = data.amount;

    // Convert microalgos to ALGO
    return new Decimal(balanceMicroAlgos).div(this.MICROALGOS_PER_ALGO);
  }
}

// Singleton instance
export const algorandService = new AlgorandService();
