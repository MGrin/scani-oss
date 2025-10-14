/**
 * Litecoin Balance Service
 *
 * Fetches LTC balances using Litecoin public API endpoints
 * Supports Litecoin mainnet addresses (L, M, or ltc1 prefix)
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
 * Litecoin address validation
 * Supports P2PKH (L), P2SH (M), and Bech32 (ltc1) addresses
 */
const LITECOIN_ADDRESS_PATTERN = /^(L|M|ltc1)[a-zA-HJ-NP-Z0-9]{25,62}$/;

/**
 * Simple rate limiter for Litecoin API calls
 */
class LitecoinRateLimiter {
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

export class LitecoinService implements ChainBalanceService {
  private rateLimiter = new LitecoinRateLimiter();
  private readonly SATOSHIS_PER_LTC = 100_000_000;
  private readonly CHAIN_ID = -4; // Custom chain ID for Litecoin

  getServiceName(): string {
    return 'LitecoinService';
  }

  supportsChain(chainId: number): boolean {
    return chainId === this.CHAIN_ID;
  }

  /**
   * Validate Litecoin address format
   */
  private isValidLitecoinAddress(address: string): boolean {
    return LITECOIN_ADDRESS_PATTERN.test(address);
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    if (!this.isValidLitecoinAddress(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    if (!this.rateLimiter.canMakeRequest()) {
      const waitTime = this.rateLimiter.getTimeUntilReset();
      logger.warn(`Litecoin API rate limit hit, wait ${waitTime}ms`);
      throw new ChainServiceError(
        `Rate limit exceeded, retry in ${Math.ceil(waitTime / 1000)}s`,
        chainId,
        address
      );
    }

    // Try multiple APIs
    const apis = [
      () => this.fetchFromBlockchair(address),
      () => this.fetchFromBlockcypher(address),
    ];

    let lastError: unknown;
    for (const apiFn of apis) {
      try {
        const balance = await apiFn();

        logger.info(`Fetched Litecoin balance for ${address}: ${balance.toString()} LTC`);

        return {
          address,
          chainId: this.CHAIN_ID,
          chainName: 'Litecoin',
          tokenSymbol: 'LTC',
          balance,
          decimals: 8,
        };
      } catch (error) {
        lastError = error;
        logger.warn(
          `Litecoin API failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    throw new ChainServiceError('All Litecoin API endpoints failed', chainId, address, lastError);
  }

  /**
   * Fetch balance from Blockchair
   */
  private async fetchFromBlockchair(address: string): Promise<Decimal> {
    const response = await fetch(
      `https://api.blockchair.com/litecoin/dashboards/address/${address}`,
      {
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      throw new Error(`Blockchair HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as {
      data?: Record<string, { address?: { balance?: number } }>;
    };

    const addressData = data.data?.[address];
    if (!addressData?.address?.balance) {
      return new Decimal(0);
    }

    // Convert satoshis to LTC
    return new Decimal(addressData.address.balance).div(this.SATOSHIS_PER_LTC);
  }

  /**
   * Fetch balance from BlockCypher
   */
  private async fetchFromBlockcypher(address: string): Promise<Decimal> {
    const response = await fetch(
      `https://api.blockcypher.com/v1/ltc/main/addrs/${address}/balance`,
      {
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      throw new Error(`BlockCypher HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as {
      balance?: number;
      final_balance?: number;
    };

    const balanceSat = data.final_balance ?? data.balance ?? 0;

    // Convert satoshis to LTC
    return new Decimal(balanceSat).div(this.SATOSHIS_PER_LTC);
  }
}

// Singleton instance
export const litecoinService = new LitecoinService();
