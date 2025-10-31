/**
 * Tron Chain Service
 * Handles balance fetching for Tron blockchain
 * Uses public TronGrid API
 */

import Decimal from 'decimal.js';
import { createComponentLogger } from '../../../utils/logger';
import { fetchWithTimeout } from '../pricing/utils';
import type { ChainConfig } from './chain-config';
import type { BlockchainServiceConfig, IBlockchainService, TokenBalance } from './types';

const logger = createComponentLogger('tron-chain-service');

/**
 * Tron API response types
 */
interface TronAccountInfo {
  balance?: number;
  address?: string;
}

interface TronTRC20Token {
  balance: string;
  tokenId: string;
  tokenAbbr: string;
  tokenName: string;
  tokenDecimal: number;
  tokenCanShow: number;
  tokenType: string;
  vip: boolean;
}

interface TronTRC20Response {
  data: TronTRC20Token[];
  success: boolean;
}

/**
 * Tron Chain Service
 */
export class TronChainService implements IBlockchainService {
  private readonly chainConfig: ChainConfig;
  private readonly rateLimiter?: BlockchainServiceConfig['rateLimiter'];
  private readonly apiUrl: string;

  constructor(chainConfig: ChainConfig, config: BlockchainServiceConfig) {
    this.chainConfig = chainConfig;
    this.rateLimiter = config.rateLimiter;
    // Use public TronGrid API
    this.apiUrl = config.baseUrl || 'https://api.trongrid.io';
  }

  getChainId(): string | number {
    return this.chainConfig.chainId;
  }

  getChainName(): string {
    return this.chainConfig.name;
  }

  /**
   * Check if address is valid Tron address (starts with T, 34 chars, base58)
   */
  isValidAddress(address: string): boolean {
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  }

  /**
   * Get all token balances including TRX and TRC20 tokens
   */
  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    if (!this.isValidAddress(address)) {
      throw new Error(`Invalid Tron address: ${address}`);
    }

    const balances: TokenBalance[] = [];

    try {
      // Fetch TRX balance and TRC20 token balances in parallel
      const [trxBalance, trc20Balances] = await Promise.all([
        this.getTRXBalance(address),
        this.getTRC20Balances(address),
      ]);

      // Add TRX if balance > 0
      if (trxBalance && new Decimal(trxBalance.balance).greaterThan(0)) {
        balances.push(trxBalance);
      }

      // Add TRC20 tokens with balance > 0
      for (const token of trc20Balances) {
        if (new Decimal(token.balance).greaterThan(0)) {
          balances.push(token);
        }
      }

      logger.debug(
        {
          address,
          totalTokens: balances.length,
        },
        'Fetched Tron token balances'
      );

      return balances;
    } catch (error) {
      logger.error(
        {
          address,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to fetch Tron balances'
      );
      throw error;
    }
  }

  /**
   * Get native TRX balance
   */
  private async getTRXBalance(address: string): Promise<TokenBalance | null> {
    const fetchBalance = async () => {
      const url = `${this.apiUrl}/v1/accounts/${address}`;
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(`TronGrid API error: ${response.statusText}`);
      }

      const data = (await response.json()) as { data: TronAccountInfo[] };

      if (!data.data || data.data.length === 0 || data.data[0]?.balance === undefined) {
        return null;
      }

      // Convert from sun to TRX (1 TRX = 1,000,000 sun)
      const balanceSun = new Decimal(data.data[0].balance);
      const balanceTRX = balanceSun.dividedBy(1000000);

      if (balanceTRX.isZero()) {
        return null;
      }

      return {
        tokenAddress: 'native',
        symbol: 'TRX',
        name: 'Tron',
        balance: balanceTRX.toString(),
        decimals: 6,
        isNative: true,
      };
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(fetchBalance);
    }
    return fetchBalance();
  }

  /**
   * Get all TRC20 token balances
   */
  private async getTRC20Balances(address: string): Promise<TokenBalance[]> {
    const fetchBalances = async () => {
      const url = `${this.apiUrl}/v1/accounts/${address}/tokens`;
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(`TronGrid API error: ${response.statusText}`);
      }

      const data = (await response.json()) as TronTRC20Response;

      if (!data.success || !data.data) {
        return [];
      }

      const balances: TokenBalance[] = [];

      for (const token of data.data) {
        // Only include TRC20 tokens
        if (token.tokenType !== 'trc20') {
          continue;
        }

        const balance = new Decimal(token.balance).dividedBy(
          new Decimal(10).pow(token.tokenDecimal)
        );

        if (balance.greaterThan(0)) {
          balances.push({
            tokenAddress: token.tokenId,
            symbol: token.tokenAbbr,
            name: token.tokenName,
            balance: balance.toString(),
            decimals: token.tokenDecimal,
            isNative: false,
            metadata: {
              tokenType: token.tokenType,
            },
          });
        }
      }

      return balances;
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(fetchBalances);
    }
    return fetchBalances();
  }
}
