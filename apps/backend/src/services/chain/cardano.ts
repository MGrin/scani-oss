/**
 * Cardano Balance Service
 *
 * Fetches ADA balances using Cardano public API endpoints
 * Supports Cardano mainnet addresses (addr1 prefix for Shelley era)
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
 * Cardano address validation
 * Shelley addresses start with addr1
 */
const CARDANO_ADDRESS_PATTERN = /^addr1[a-z0-9]{98}$/;

/**
 * Simple rate limiter for Cardano API calls
 */
class CardanoRateLimiter {
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

export class CardanoService implements ChainBalanceService {
  private rateLimiter = new CardanoRateLimiter();
  private readonly LOVELACE_PER_ADA = 1_000_000; // 1 ADA = 1,000,000 lovelace
  private readonly CHAIN_ID = -5; // Custom chain ID for Cardano

  getServiceName(): string {
    return 'CardanoService';
  }

  supportsChain(chainId: number): boolean {
    return chainId === this.CHAIN_ID;
  }

  /**
   * Validate Cardano address format
   */
  private isValidCardanoAddress(address: string): boolean {
    return CARDANO_ADDRESS_PATTERN.test(address);
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    if (!this.isValidCardanoAddress(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    if (!this.rateLimiter.canMakeRequest()) {
      const waitTime = this.rateLimiter.getTimeUntilReset();
      logger.warn(`Cardano API rate limit hit, wait ${waitTime}ms`);
      throw new ChainServiceError(
        `Rate limit exceeded, retry in ${Math.ceil(waitTime / 1000)}s`,
        chainId,
        address
      );
    }

    // Try Blockfrost public API
    try {
      const balance = await this.fetchFromBlockfrost(address);

      logger.info(`Fetched Cardano balance for ${address}: ${balance.toString()} ADA`);

      return {
        address,
        chainId: this.CHAIN_ID,
        chainName: 'Cardano',
        tokenSymbol: 'ADA',
        balance,
        decimals: 6,
      };
    } catch (error) {
      logger.warn(`Cardano API failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new ChainServiceError('Cardano API endpoint failed', chainId, address, error);
    }
  }

  /**
   * Fetch balance from Blockfrost (requires no API key for basic queries)
   */
  private async fetchFromBlockfrost(address: string): Promise<Decimal> {
    const response = await fetch(
      `https://cardano-mainnet.blockfrost.io/api/v0/addresses/${address}`,
      {
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        // Address not found means 0 balance
        return new Decimal(0);
      }
      throw new Error(`Blockfrost HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as {
      amount?: Array<{ unit: string; quantity: string }>;
    };

    if (!data.amount || !Array.isArray(data.amount)) {
      return new Decimal(0);
    }

    // Find ADA balance (unit: "lovelace")
    const adaAmount = data.amount.find((item) => item.unit === 'lovelace');
    if (!adaAmount) {
      return new Decimal(0);
    }

    const balanceLovelace = adaAmount.quantity;

    // Convert lovelace to ADA
    return new Decimal(balanceLovelace).div(this.LOVELACE_PER_ADA);
  }
}

// Singleton instance
export const cardanoService = new CardanoService();
