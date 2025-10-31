/**
 * TON Chain Service
 * Handles balance fetching for TON blockchain
 * Uses public TON API
 */

import Decimal from 'decimal.js';
import { createComponentLogger } from '../../../utils/logger';
import { fetchWithTimeout } from '../pricing/utils';
import type { ChainConfig } from './chain-config';
import type { BlockchainServiceConfig, IBlockchainService, TokenBalance } from './types';

const logger = createComponentLogger('ton-chain-service');

/**
 * TON Chain Service
 */
export class TonChainService implements IBlockchainService {
  private readonly chainConfig: ChainConfig;
  private readonly rateLimiter?: BlockchainServiceConfig['rateLimiter'];
  private readonly apiUrl: string;

  constructor(chainConfig: ChainConfig, config: BlockchainServiceConfig) {
    this.chainConfig = chainConfig;
    this.rateLimiter = config.rateLimiter;
    // Use public TON API
    this.apiUrl = config.baseUrl || 'https://toncenter.com/api/v2';
  }

  getChainId(): string | number {
    return this.chainConfig.chainId;
  }

  getChainName(): string {
    return this.chainConfig.name;
  }

  /**
   * Check if address is valid TON address
   * TON addresses can be in different formats (raw, user-friendly)
   * Basic validation for user-friendly format
   */
  isValidAddress(address: string): boolean {
    // User-friendly format: EQ... or UQ... (48 chars base64url)
    if (/^[EU]Q[A-Za-z0-9_-]{46}$/.test(address)) return true;
    // Raw format: 0:hex (64 hex chars after colon)
    if (/^-?[0-9]:[a-fA-F0-9]{64}$/.test(address)) return true;
    return false;
  }

  /**
   * Get TON balance (native token only for now)
   */
  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    if (!this.isValidAddress(address)) {
      throw new Error(`Invalid TON address: ${address}`);
    }

    const fetchBalance = async () => {
      try {
        const url = `${this.apiUrl}/getAddressBalance?address=${encodeURIComponent(address)}`;
        const response = await fetchWithTimeout(url);

        if (!response.ok) {
          throw new Error(`TON API error: ${response.statusText}`);
        }

        const data = (await response.json()) as {
          ok: boolean;
          result: string;
        };

        if (!data.ok) {
          throw new Error('TON API returned not ok');
        }

        // Convert from nanotons to TON (1 TON = 1,000,000,000 nanotons)
        const balanceNanotons = new Decimal(data.result);
        const balanceTON = balanceNanotons.dividedBy(1000000000);

        if (balanceTON.isZero()) {
          logger.debug({ address }, 'TON address has zero balance');
          return [];
        }

        logger.debug(
          {
            address,
            balance: balanceTON.toString(),
          },
          'Fetched TON balance'
        );

        return [
          {
            tokenAddress: 'native',
            symbol: 'TON',
            name: 'Toncoin',
            balance: balanceTON.toString(),
            decimals: 9,
            isNative: true,
          },
        ];
      } catch (error) {
        logger.error(
          {
            address,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to fetch TON balance'
        );
        throw error;
      }
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(fetchBalance);
    }
    return fetchBalance();
  }
}
