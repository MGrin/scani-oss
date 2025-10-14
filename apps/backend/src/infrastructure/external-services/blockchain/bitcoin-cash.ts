/**
 * Bitcoin Cash Balance Service
 *
 * Fetches BCH balances using Bitcoin Cash public API endpoints
 * Supports Bitcoin Cash mainnet addresses (multiple formats)
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
 * Bitcoin Cash address validation
 * Supports legacy (1/3 prefix) and CashAddr (bitcoincash: prefix or q/p prefix)
 */
const BCH_LEGACY_PATTERN = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const BCH_CASHADDR_PATTERN = /^(bitcoincash:)?[qp][a-z0-9]{41}$/;

/**
 * Simple rate limiter for Bitcoin Cash API calls
 */
class BitcoinCashRateLimiter {
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

export class BitcoinCashService implements ChainBalanceService {
  private rateLimiter = new BitcoinCashRateLimiter();
  private readonly SATOSHIS_PER_BCH = 100_000_000;
  private readonly CHAIN_ID = -3; // Custom chain ID for Bitcoin Cash

  getServiceName(): string {
    return 'BitcoinCashService';
  }

  supportsChain(chainId: number): boolean {
    return chainId === this.CHAIN_ID;
  }

  /**
   * Validate Bitcoin Cash address format
   */
  private isValidBitcoinCashAddress(address: string): boolean {
    return BCH_LEGACY_PATTERN.test(address) || BCH_CASHADDR_PATTERN.test(address);
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    if (!this.isValidBitcoinCashAddress(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    if (!this.rateLimiter.canMakeRequest()) {
      const waitTime = this.rateLimiter.getTimeUntilReset();
      logger.warn(`Bitcoin Cash API rate limit hit, wait ${waitTime}ms`);
      throw new ChainServiceError(
        `Rate limit exceeded, retry in ${Math.ceil(waitTime / 1000)}s`,
        chainId,
        address
      );
    }

    // Remove bitcoincash: prefix if present
    const cleanAddress = address.replace('bitcoincash:', '');

    // Try multiple APIs
    const apis = [
      () => this.fetchFromBlockchair(cleanAddress),
      () => this.fetchFromBitcoinCom(cleanAddress),
    ];

    let lastError: unknown;
    for (const apiFn of apis) {
      try {
        const balance = await apiFn();

        logger.info(`Fetched Bitcoin Cash balance for ${address}: ${balance.toString()} BCH`);

        return {
          address,
          chainId: this.CHAIN_ID,
          chainName: 'Bitcoin Cash',
          tokenSymbol: 'BCH',
          balance,
          decimals: 8,
        };
      } catch (error) {
        lastError = error;
        logger.warn(
          `Bitcoin Cash API failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    throw new ChainServiceError(
      'All Bitcoin Cash API endpoints failed',
      chainId,
      address,
      lastError
    );
  }

  /**
   * Fetch balance from Blockchair
   */
  private async fetchFromBlockchair(address: string): Promise<Decimal> {
    const response = await fetch(
      `https://api.blockchair.com/bitcoin-cash/dashboards/address/${address}`,
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

    // Convert satoshis to BCH
    return new Decimal(addressData.address.balance).div(this.SATOSHIS_PER_BCH);
  }

  /**
   * Fetch balance from Bitcoin.com API
   */
  private async fetchFromBitcoinCom(address: string): Promise<Decimal> {
    const response = await fetch(`https://rest.bitcoin.com/v2/address/details/${address}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Bitcoin.com API HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as {
      balance?: number;
      balanceSat?: number;
    };

    const balanceSat = data.balanceSat ?? 0;

    // Convert satoshis to BCH
    return new Decimal(balanceSat).div(this.SATOSHIS_PER_BCH);
  }
}

// Singleton instance
export const bitcoinCashService = new BitcoinCashService();
