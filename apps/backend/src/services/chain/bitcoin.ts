/**
 * Bitcoin Balance Service
 *
 * Fetches Bitcoin balances using public blockchain APIs
 * Supports multiple Bitcoin address formats (P2PKH, P2SH, Bech32)
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
 * Bitcoin address validation patterns
 */
const BITCOIN_ADDRESS_PATTERNS = {
  // Legacy P2PKH (starts with 1)
  p2pkh: /^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/,
  // P2SH (starts with 3)
  p2sh: /^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/,
  // Bech32 (starts with bc1)
  bech32: /^bc1[a-z0-9]{39,59}$/,
};

/**
 * Simple rate limiter for Bitcoin API calls
 */
class BitcoinRateLimiter {
  private requestCounts: { count: number; resetTime: number } = {
    count: 0,
    resetTime: Date.now() + 60000,
  };
  private readonly maxRequestsPerMinute = 20; // Conservative limit
  private readonly windowMs = 60000; // 1 minute

  canMakeRequest(): boolean {
    const now = Date.now();

    // Window expired, reset
    if (now >= this.requestCounts.resetTime) {
      this.requestCounts = { count: 1, resetTime: now + this.windowMs };
      return true;
    }

    // Check if under limit
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

export class BitcoinService implements ChainBalanceService {
  private rateLimiter = new BitcoinRateLimiter();
  private readonly SATOSHIS_PER_BTC = 100_000_000;

  getServiceName(): string {
    return 'BitcoinService';
  }

  supportsChain(chainId: number): boolean {
    // Bitcoin doesn't use EVM-style chain IDs, but we use a custom identifier
    // We'll use 0 for Bitcoin mainnet
    return chainId === 0;
  }

  /**
   * Validate Bitcoin address format
   */
  private isValidBitcoinAddress(address: string): boolean {
    return (
      BITCOIN_ADDRESS_PATTERNS.p2pkh.test(address) ||
      BITCOIN_ADDRESS_PATTERNS.p2sh.test(address) ||
      BITCOIN_ADDRESS_PATTERNS.bech32.test(address)
    );
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    // Validate address format
    if (!this.isValidBitcoinAddress(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    // Check rate limit
    if (!this.rateLimiter.canMakeRequest()) {
      const waitTime = this.rateLimiter.getTimeUntilReset();
      logger.warn(`Bitcoin API rate limit hit, wait ${waitTime}ms`);
      throw new ChainServiceError(
        `Rate limit exceeded, retry in ${Math.ceil(waitTime / 1000)}s`,
        chainId,
        address
      );
    }

    // Try multiple APIs in order of preference
    const apis = [
      () => this.fetchFromBlockchainInfo(address),
      () => this.fetchFromBlockcypher(address),
      () => this.fetchFromBlockchair(address),
    ];

    let lastError: unknown;
    for (const apiFn of apis) {
      try {
        const balance = await apiFn();

        logger.info(`Fetched Bitcoin balance for ${address}: ${balance.toString()} BTC`);

        return {
          address,
          chainId: 0, // Bitcoin mainnet
          chainName: 'Bitcoin',
          tokenSymbol: 'BTC',
          balance,
          decimals: 8,
        };
      } catch (error) {
        lastError = error;
        logger.warn(
          `Bitcoin API failed: ${error instanceof Error ? error.message : String(error)}`
        );
        // Continue to next API
      }
    }

    // All APIs failed
    throw new ChainServiceError('All Bitcoin APIs failed', chainId, address, lastError);
  }

  /**
   * Fetch balance from Blockchain.info
   */
  private async fetchFromBlockchainInfo(address: string): Promise<Decimal> {
    const response = await fetch(`https://blockchain.info/balance?active=${address}`, {
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Blockchain.info HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as Record<string, { final_balance: number }>;

    if (!data[address]) {
      throw new Error('Address not found in response');
    }

    const finalBalance = data[address].final_balance;

    // Convert satoshis to BTC
    return new Decimal(finalBalance).div(this.SATOSHIS_PER_BTC);
  }

  /**
   * Fetch balance from BlockCypher
   */
  private async fetchFromBlockcypher(address: string): Promise<Decimal> {
    const response = await fetch(
      `https://api.blockcypher.com/v1/btc/main/addrs/${address}/balance`,
      {
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      throw new Error(`BlockCypher HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as { final_balance?: number };

    if (typeof data.final_balance !== 'number') {
      throw new Error('Invalid response format');
    }

    // Convert satoshis to BTC
    return new Decimal(data.final_balance).div(this.SATOSHIS_PER_BTC);
  }

  /**
   * Fetch balance from Blockchair
   */
  private async fetchFromBlockchair(address: string): Promise<Decimal> {
    const response = await fetch(
      `https://api.blockchair.com/bitcoin/dashboards/address/${address}`,
      {
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!response.ok) {
      throw new Error(`Blockchair HTTP error: ${response.status}`);
    }

    const data = (await response.json()) as {
      data?: Record<string, { address: { balance: number } }>;
    };

    if (!data.data || !data.data[address]) {
      throw new Error('Address not found in response');
    }

    const balance = data.data[address].address.balance;

    // Convert satoshis to BTC
    return new Decimal(balance).div(this.SATOSHIS_PER_BTC);
  }
}

// Singleton instance
export const bitcoinService = new BitcoinService();
