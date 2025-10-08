/**
 * Tron Balance Service
 *
 * Fetches TRX balances using TronGrid public API
 * Supports Tron mainnet addresses (base58 format)
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
 * Tron address validation
 * Tron addresses start with 'T' and are 34 characters long (base58)
 */
const TRON_ADDRESS_PATTERN = /^T[a-zA-Z0-9]{33}$/;

/**
 * Simple rate limiter for Tron API calls
 */
class TronRateLimiter {
  private requestCounts: { count: number; resetTime: number } = {
    count: 0,
    resetTime: Date.now() + 60000,
  };
  private readonly maxRequestsPerMinute = 20;
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

export class TronService implements ChainBalanceService {
  private rateLimiter = new TronRateLimiter();
  private readonly SUN_PER_TRX = 1_000_000; // 1 TRX = 1,000,000 SUN

  getServiceName(): string {
    return 'TronService';
  }

  supportsChain(chainId: number): boolean {
    // Tron mainnet identifier (custom, not EVM)
    return chainId === -1; // Using -1 for Tron
  }

  /**
   * Validate Tron address format
   */
  private isValidTronAddress(address: string): boolean {
    return TRON_ADDRESS_PATTERN.test(address);
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    if (!this.isValidTronAddress(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    if (!this.rateLimiter.canMakeRequest()) {
      const waitTime = this.rateLimiter.getTimeUntilReset();
      logger.warn(`Tron API rate limit hit, wait ${waitTime}ms`);
      throw new ChainServiceError(
        `Rate limit exceeded, retry in ${Math.ceil(waitTime / 1000)}s`,
        chainId,
        address
      );
    }

    // Try TronGrid API and fallback APIs
    const apis = [() => this.fetchFromTronGrid(address), () => this.fetchFromTronScan(address)];

    let lastError: unknown;
    for (const apiFn of apis) {
      try {
        const balance = await apiFn();

        logger.info(`Fetched Tron balance for ${address}: ${balance.toString()} TRX`);

        return {
          address,
          chainId: -1, // Tron mainnet
          chainName: 'Tron',
          tokenSymbol: 'TRX',
          balance,
          decimals: 6,
        };
      } catch (error) {
        lastError = error;
        logger.warn(`Tron API failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new ChainServiceError('All Tron APIs failed', chainId, address, lastError);
  }

  /**
   * Fetch balance from TronGrid (official Tron API)
   */
  private async fetchFromTronGrid(address: string): Promise<Decimal> {
    const response = await fetch(`https://api.trongrid.io/v1/accounts/${address}`, {
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`TronGrid HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as {
      data?: Array<{ balance?: number }>;
    };

    if (!data.data || data.data.length === 0) {
      // Account not found or has 0 balance
      return new Decimal(0);
    }

    const account = data.data[0];
    if (!account) {
      return new Decimal(0);
    }

    const balanceSun = account.balance || 0;

    // Convert SUN to TRX
    return new Decimal(balanceSun).div(this.SUN_PER_TRX);
  }

  /**
   * Fetch balance from TronScan (alternative API)
   */
  private async fetchFromTronScan(address: string): Promise<Decimal> {
    const response = await fetch(`https://apilist.tronscanapi.com/api/account?address=${address}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`TronScan HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as { balance?: number };

    if (!data || typeof data.balance !== 'number') {
      return new Decimal(0);
    }

    const balanceSun = data.balance;

    // Convert SUN to TRX
    return new Decimal(balanceSun).div(this.SUN_PER_TRX);
  }
}

// Singleton instance
export const tronService = new TronService();
