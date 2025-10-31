/**
 * Bitcoin Chain Service
 * Handles balance fetching for Bitcoin blockchain
 * Uses public blockchain.info API
 */

import Decimal from 'decimal.js';
import { createComponentLogger } from '../../../utils/logger';
import { fetchWithTimeout } from '../pricing/utils';
import type { ChainConfig } from './chain-config';
import type { BlockchainServiceConfig, IBlockchainService, TokenBalance } from './types';

const logger = createComponentLogger('bitcoin-chain-service');

/**
 * Blockchain.info API response types
 */
interface BlockchainInfoAddress {
  address: string;
  final_balance: number;
  n_tx: number;
  total_received: number;
}

/**
 * Bitcoin Chain Service
 */
export class BitcoinChainService implements IBlockchainService {
  private readonly chainConfig: ChainConfig;
  private readonly rateLimiter?: BlockchainServiceConfig['rateLimiter'];

  constructor(chainConfig: ChainConfig, config: BlockchainServiceConfig) {
    this.chainConfig = chainConfig;
    this.rateLimiter = config.rateLimiter;
  }

  getChainId(): string | number {
    return this.chainConfig.chainId;
  }

  getChainName(): string {
    return this.chainConfig.name;
  }

  /**
   * Check if address is valid Bitcoin address
   * Basic validation for common address formats (P2PKH, P2SH, Bech32)
   */
  isValidAddress(address: string): boolean {
    // P2PKH addresses (start with 1)
    if (/^1[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;
    // P2SH addresses (start with 3)
    if (/^3[a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(address)) return true;
    // Bech32 addresses (start with bc1)
    if (/^bc1[a-z0-9]{39,59}$/.test(address)) return true;
    return false;
  }

  /**
   * Get Bitcoin balance using blockchain.info API
   */
  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    if (!this.isValidAddress(address)) {
      throw new Error(`Invalid Bitcoin address: ${address}`);
    }

    const fetchBalance = async () => {
      try {
        const url = `https://blockchain.info/rawaddr/${address}`;
        const response = await fetchWithTimeout(url);

        if (!response.ok) {
          throw new Error(`Blockchain.info API error: ${response.statusText}`);
        }

        const data = (await response.json()) as BlockchainInfoAddress;

        // Convert from satoshis to BTC (1 BTC = 100,000,000 satoshis)
        const balanceSatoshis = new Decimal(data.final_balance);
        const balanceBTC = balanceSatoshis.dividedBy(100000000);

        if (balanceBTC.isZero()) {
          logger.debug({ address }, 'Bitcoin address has zero balance');
          return [];
        }

        logger.debug(
          {
            address,
            balance: balanceBTC.toString(),
          },
          'Fetched Bitcoin balance'
        );

        return [
          {
            tokenAddress: 'native',
            symbol: 'BTC',
            name: 'Bitcoin',
            balance: balanceBTC.toString(),
            decimals: 8,
            isNative: true,
          },
        ];
      } catch (error) {
        logger.error(
          {
            address,
            chainName: 'Bitcoin',
            url: 'https://blockchain.info/rawaddr/',
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : { name: 'Error', message: String(error) },
          },
          `Failed to fetch Bitcoin balance: ${error instanceof Error ? error.message : String(error)}`
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
