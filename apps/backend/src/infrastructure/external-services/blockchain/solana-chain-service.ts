/**
 * Solana Chain Service
 * Handles balance fetching for Solana blockchain
 * Uses public Solana RPC endpoint
 */

import Decimal from 'decimal.js';
import { createComponentLogger } from '../../../utils/logger';
import { fetchWithTimeout } from '../pricing/utils';
import type { ChainConfig } from './chain-config';
import type { BlockchainServiceConfig, IBlockchainService, TokenBalance } from './types';

const logger = createComponentLogger('solana-chain-service');

/**
 * Solana RPC response types
 */
interface SolanaRpcResponse<T> {
  jsonrpc: string;
  result: T;
  id: number;
}

interface SolanaTokenAccount {
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          tokenAmount: {
            amount: string;
            decimals: number;
            uiAmount: number;
          };
        };
        type: string;
      };
      program: string;
      space: number;
    };
  };
  pubkey: string;
}

/**
 * Solana Chain Service
 */
export class SolanaChainService implements IBlockchainService {
  private readonly chainConfig: ChainConfig;
  private readonly rateLimiter?: BlockchainServiceConfig['rateLimiter'];
  private readonly rpcUrl: string;

  constructor(chainConfig: ChainConfig, config: BlockchainServiceConfig) {
    this.chainConfig = chainConfig;
    this.rateLimiter = config.rateLimiter;
    // Use public Solana RPC endpoint
    this.rpcUrl = config.baseUrl || 'https://api.mainnet-beta.solana.com';
  }

  getChainId(): string | number {
    return this.chainConfig.chainId;
  }

  getChainName(): string {
    return this.chainConfig.name;
  }

  /**
   * Check if address is valid Solana address (base58, 32-44 chars)
   */
  isValidAddress(address: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }

  /**
   * Get all token balances including SOL and SPL tokens
   */
  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    if (!this.isValidAddress(address)) {
      throw new Error(`Invalid Solana address: ${address}`);
    }

    const balances: TokenBalance[] = [];

    try {
      // Fetch SOL balance and SPL token balances in parallel
      const [solBalance, splBalances] = await Promise.all([
        this.getSOLBalance(address),
        this.getSPLTokenBalances(address),
      ]);

      // Add SOL if balance > 0
      if (solBalance && new Decimal(solBalance.balance).greaterThan(0)) {
        balances.push(solBalance);
      }

      // Add SPL tokens with balance > 0
      for (const token of splBalances) {
        if (new Decimal(token.balance).greaterThan(0)) {
          balances.push(token);
        }
      }

      logger.debug(
        {
          address,
          totalTokens: balances.length,
        },
        'Fetched Solana token balances'
      );

      return balances;
    } catch (error) {
      logger.error(
        {
          address,
          chainName: 'Solana',
          url: this.rpcUrl,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: 'Error', message: String(error) },
        },
        `Failed to fetch Solana balances: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Get native SOL balance
   */
  private async getSOLBalance(address: string): Promise<TokenBalance | null> {
    const fetchBalance = async () => {
      const response = await fetchWithTimeout(this.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [address],
        }),
      });

      if (!response.ok) {
        throw new Error(`Solana RPC error: ${response.statusText}`);
      }

      const data = (await response.json()) as SolanaRpcResponse<{ value: number }>;

      // Convert from lamports to SOL (1 SOL = 1,000,000,000 lamports)
      const balanceLamports = new Decimal(data.result.value);
      const balanceSOL = balanceLamports.dividedBy(1000000000);

      if (balanceSOL.isZero()) {
        return null;
      }

      return {
        tokenAddress: 'native',
        symbol: 'SOL',
        name: 'Solana',
        balance: balanceSOL.toString(),
        decimals: 9,
        isNative: true,
      };
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(fetchBalance);
    }
    return fetchBalance();
  }

  /**
   * Get all SPL token balances
   */
  private async getSPLTokenBalances(address: string): Promise<TokenBalance[]> {
    const fetchBalances = async () => {
      const response = await fetchWithTimeout(this.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [
            address,
            {
              programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token Program
            },
            {
              encoding: 'jsonParsed',
            },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Solana RPC error: ${response.statusText}`);
      }

      const data = (await response.json()) as SolanaRpcResponse<{
        value: SolanaTokenAccount[];
      }>;

      const balances: TokenBalance[] = [];

      for (const account of data.result.value) {
        const tokenInfo = account.account.data.parsed.info;
        const balance = new Decimal(tokenInfo.tokenAmount.amount).dividedBy(
          new Decimal(10).pow(tokenInfo.tokenAmount.decimals)
        );

        if (balance.greaterThan(0)) {
          balances.push({
            tokenAddress: tokenInfo.mint,
            symbol: `TOKEN_${tokenInfo.mint.substring(0, 8)}`, // Placeholder until metadata lookup
            name: `Solana Token ${tokenInfo.mint.substring(0, 16)}`, // Placeholder until metadata lookup
            balance: balance.toString(),
            decimals: tokenInfo.tokenAmount.decimals,
            isNative: false,
            metadata: {
              mint: tokenInfo.mint,
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
