/**
 * Aptos Balance Service
 *
 * Fetches APT balances using Aptos public API endpoints
 * Supports Aptos mainnet addresses (hex format with 0x prefix)
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
 * Aptos address validation
 * Aptos addresses are hex strings with 0x prefix, can be short or long form
 */
const APTOS_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{1,64}$/;

/**
 * Simple rate limiter for Aptos API calls
 */
class AptosRateLimiter {
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

export class AptosService implements ChainBalanceService {
  private rateLimiter = new AptosRateLimiter();
  private readonly OCTAS_PER_APT = 100_000_000; // 1 APT = 100,000,000 Octas
  private readonly CHAIN_ID = -11; // Custom chain ID for Aptos

  getServiceName(): string {
    return 'AptosService';
  }

  supportsChain(chainId: number): boolean {
    return chainId === this.CHAIN_ID;
  }

  /**
   * Validate Aptos address format
   */
  private isValidAptosAddress(address: string): boolean {
    return APTOS_ADDRESS_PATTERN.test(address);
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    if (!this.isValidAptosAddress(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    if (!this.rateLimiter.canMakeRequest()) {
      const waitTime = this.rateLimiter.getTimeUntilReset();
      logger.warn(`Aptos API rate limit hit, wait ${waitTime}ms`);
      throw new ChainServiceError(
        `Rate limit exceeded, retry in ${Math.ceil(waitTime / 1000)}s`,
        chainId,
        address
      );
    }

    // Try multiple public API endpoints
    const apiEndpoints = [
      'https://fullnode.mainnet.aptoslabs.com/v1',
      'https://aptos-mainnet.nodereal.io/v1',
      'https://rpc.ankr.com/http/aptos/v1',
    ];

    let lastError: unknown;
    for (const apiUrl of apiEndpoints) {
      try {
        const balance = await this.fetchBalanceFromAPI(apiUrl, address);

        logger.info(`Fetched Aptos balance for ${address}: ${balance.toString()} APT`);

        return {
          address,
          chainId: this.CHAIN_ID,
          chainName: 'Aptos',
          tokenSymbol: 'APT',
          balance,
          decimals: 8,
        };
      } catch (error) {
        lastError = error;
        logger.warn(
          `Aptos API ${apiUrl} failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    throw new ChainServiceError('All Aptos API endpoints failed', chainId, address, lastError);
  }

  /**
   * Fetch balance from an Aptos API endpoint
   */
  private async fetchBalanceFromAPI(apiUrl: string, address: string): Promise<Decimal> {
    const response = await fetch(
      `${apiUrl}/accounts/${address}/resource/0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>`,
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        // Account not found or no balance - return 0
        return new Decimal(0);
      }
      throw new Error(`Aptos API HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as {
      data?: {
        coin?: {
          value?: string;
        };
      };
    };

    if (!data.data?.coin?.value) {
      // No coin store means 0 balance
      return new Decimal(0);
    }

    const balanceOctas = data.data.coin.value;

    // Convert Octas to APT
    return new Decimal(balanceOctas).div(this.OCTAS_PER_APT);
  }
}

// Singleton instance
export const aptosService = new AptosService();
