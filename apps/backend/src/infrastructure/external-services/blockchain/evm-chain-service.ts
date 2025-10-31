/**
 * EVM Chain Service
 * Handles balance fetching for EVM-compatible chains using Etherscan V2 API
 */

import Decimal from 'decimal.js';
import { createComponentLogger } from '../../../utils/logger';
import { fetchWithTimeout } from '../pricing/utils';
import type { ChainConfig } from './chain-config';
import type { BlockchainServiceConfig, IBlockchainService, TokenBalance } from './types';

const logger = createComponentLogger('evm-chain-service');

interface EtherscanResponse<T> {
  status: string;
  message: string;
  result: T;
}

interface EtherscanTransaction {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  [key: string]: unknown;
}

/**
 * EVM Chain Service using Etherscan V2 API
 */
export class EvmChainService implements IBlockchainService {
  private readonly chainConfig: ChainConfig;
  private readonly apiKey: string;
  private readonly rateLimiter?: BlockchainServiceConfig['rateLimiter'];

  constructor(chainConfig: ChainConfig, config: BlockchainServiceConfig) {
    this.chainConfig = chainConfig;
    this.apiKey = config.apiKey || '';
    this.rateLimiter = config.rateLimiter;

    if (!chainConfig.explorerApiUrl) {
      logger.warn(
        { chainId: chainConfig.chainId, chainName: chainConfig.name },
        'Chain has no explorerApiUrl configured'
      );
    }
  }

  getChainId(): string | number {
    return this.chainConfig.chainId;
  }

  getChainName(): string {
    return this.chainConfig.name;
  }

  /**
   * Check if address is valid EVM address (0x + 40 hex chars)
   */
  isValidAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  /**
   * Get all token balances for an address including native token
   */
  async getTokenBalances(address: string): Promise<TokenBalance[]> {
    if (!this.isValidAddress(address)) {
      throw new Error(`Invalid EVM address: ${address}`);
    }

    if (!this.chainConfig.explorerApiUrl) {
      logger.warn(
        { chainId: this.chainConfig.chainId, address },
        'Cannot fetch balances: no explorer API URL configured'
      );
      return [];
    }

    const balances: TokenBalance[] = [];

    try {
      // Fetch native token balance and ERC-20 token balances in parallel
      const [nativeBalance, erc20Balances] = await Promise.all([
        this.getNativeBalance(address),
        this.getERC20Balances(address),
      ]);

      // Add native token if balance > 0
      if (nativeBalance && new Decimal(nativeBalance.balance).greaterThan(0)) {
        balances.push(nativeBalance);
      }

      // Add ERC-20 tokens with balance > 0
      for (const token of erc20Balances) {
        if (new Decimal(token.balance).greaterThan(0)) {
          balances.push(token);
        }
      }

      logger.debug(
        {
          chainId: this.chainConfig.chainId,
          address,
          totalTokens: balances.length,
        },
        'Fetched token balances'
      );

      return balances;
    } catch (error) {
      logger.error(
        {
          chainId: this.chainConfig.chainId,
          address,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to fetch token balances'
      );
      throw error;
    }
  }

  /**
   * Get native token (ETH, BNB, etc.) balance
   */
  private async getNativeBalance(address: string): Promise<TokenBalance | null> {
    const url = `${this.chainConfig.explorerApiUrl}?module=account&action=balance&address=${address}&tag=latest&apikey=${this.apiKey}`;

    const fetchBalance = async () => {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(`Etherscan API error: ${response.statusText}`);
      }

      const data = (await response.json()) as EtherscanResponse<string>;

      if (data.status !== '1') {
        // Status '0' is not always an error - could be zero balance
        if (data.message === 'NOTOK') {
          throw new Error(`Etherscan API error: ${data.result}`);
        }
        // Return null for zero balance or no transactions
        return null;
      }

      // Convert from wei to token units (18 decimals for most native tokens)
      const balanceWei = new Decimal(data.result);
      const balance = balanceWei.dividedBy(new Decimal(10).pow(18));

      if (balance.isZero()) {
        return null;
      }

      return {
        tokenAddress: 'native',
        symbol: this.chainConfig.nativeSymbol,
        name: this.chainConfig.nativeName,
        balance: balance.toString(),
        decimals: 18,
        isNative: true,
      };
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(fetchBalance);
    }
    return fetchBalance();
  }

  /**
   * Get all ERC-20 token balances
   */
  private async getERC20Balances(address: string): Promise<TokenBalance[]> {
    const url = `${this.chainConfig.explorerApiUrl}?module=account&action=tokentx&address=${address}&page=1&offset=10000&sort=desc&apikey=${this.apiKey}`;

    const fetchBalances = async () => {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(`Etherscan API error: ${response.statusText}`);
      }

      const data = (await response.json()) as EtherscanResponse<
        Array<{
          contractAddress: string;
          tokenName: string;
          tokenSymbol: string;
          tokenDecimal: string;
        }>
      >;

      if (data.status !== '1') {
        // No transactions is not an error
        if (data.message === 'No transactions found') {
          return [];
        }
        throw new Error(`Etherscan API error: ${data.result}`);
      }

      // Get unique token contracts from transactions
      const uniqueTokens = new Map<string, { name: string; symbol: string; decimals: number }>();

      for (const tx of data.result) {
        const contractAddress = tx.contractAddress.toLowerCase();
        if (!uniqueTokens.has(contractAddress)) {
          uniqueTokens.set(contractAddress, {
            name: tx.tokenName,
            symbol: tx.tokenSymbol,
            decimals: Number.parseInt(tx.tokenDecimal, 10),
          });
        }
      }

      // Fetch current balance for each token
      const balancePromises = Array.from(uniqueTokens.entries()).map(
        async ([contractAddress, tokenInfo]) => {
          try {
            const balance = await this.getTokenBalance(address, contractAddress);
            if (balance && new Decimal(balance).greaterThan(0)) {
              return {
                tokenAddress: contractAddress,
                symbol: tokenInfo.symbol,
                name: tokenInfo.name,
                balance: balance,
                decimals: tokenInfo.decimals,
                isNative: false,
                metadata: {
                  chainId: this.chainConfig.chainId,
                },
              } satisfies TokenBalance;
            }
            return null;
          } catch (error) {
            logger.warn(
              {
                contractAddress,
                error: error instanceof Error ? error.message : String(error),
              },
              'Failed to fetch token balance'
            );
            return null;
          }
        }
      );

      const results = await Promise.all(balancePromises);
      return results.filter((b) => b !== null) as TokenBalance[];
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(fetchBalances);
    }
    return fetchBalances();
  }

  /**
   * Get balance for a specific ERC-20 token
   */
  private async getTokenBalance(address: string, contractAddress: string): Promise<string | null> {
    const url = `${this.chainConfig.explorerApiUrl}?module=account&action=tokenbalance&contractaddress=${contractAddress}&address=${address}&tag=latest&apikey=${this.apiKey}`;

    const fetchBalance = async () => {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(`Etherscan API error: ${response.statusText}`);
      }

      const data = (await response.json()) as EtherscanResponse<string>;

      if (data.status !== '1') {
        return null;
      }

      const balanceRaw = new Decimal(data.result);
      if (balanceRaw.isZero()) {
        return null;
      }

      return balanceRaw.toString();
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(fetchBalance);
    }
    return fetchBalance();
  }

  /**
   * Check if wallet has any activity on this chain
   * Checks normal transactions, internal transactions, and token transactions in parallel
   * Returns true if any transaction history exists
   */
  async hasActivity(address: string): Promise<boolean> {
    if (!this.isValidAddress(address)) {
      return false;
    }

    if (!this.chainConfig.explorerApiUrl) {
      logger.debug(
        { chainId: this.chainConfig.chainId, address },
        'Cannot check activity: no explorer API URL configured'
      );
      return false;
    }

    try {
      // Check all transaction types in parallel for better performance
      const [hasNormalTx, hasInternalTx, hasTokenTx] = await Promise.all([
        this.hasNormalTransactions(address),
        this.hasInternalTransactions(address),
        this.hasTokenTransactions(address),
      ]);

      const hasActivity = hasNormalTx || hasInternalTx || hasTokenTx;

      if (hasActivity) {
        logger.debug(
          {
            chainId: this.chainConfig.chainId,
            address: `${address.substring(0, 10)}...`,
            hasNormalTx,
            hasInternalTx,
            hasTokenTx,
          },
          'Wallet has activity on chain'
        );
      } else {
        logger.debug(
          { chainId: this.chainConfig.chainId, address: `${address.substring(0, 10)}...` },
          'Wallet has no activity on this chain'
        );
      }

      return hasActivity;
    } catch (error) {
      logger.debug(
        {
          chainId: this.chainConfig.chainId,
          address: `${address.substring(0, 10)}...`,
          error: error instanceof Error ? error.message : String(error),
        },
        'Error checking wallet activity'
      );
      return false;
    }
  }

  /**
   * Check if address has normal transactions
   */
  private async hasNormalTransactions(address: string): Promise<boolean> {
    const url = `${this.chainConfig.explorerApiUrl}?module=account&action=txlist&address=${address}&page=1&offset=1&sort=desc&apikey=${this.apiKey}`;

    const checkTransactions = async () => {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as EtherscanResponse<EtherscanTransaction[]>;

      // Status '1' means success and transactions found
      if (data.status === '1' && Array.isArray(data.result) && data.result.length > 0) {
        return true;
      }

      return false;
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(checkTransactions);
    }
    return checkTransactions();
  }

  /**
   * Check if address has internal transactions
   */
  private async hasInternalTransactions(address: string): Promise<boolean> {
    const url = `${this.chainConfig.explorerApiUrl}?module=account&action=txlistinternal&address=${address}&page=1&offset=1&sort=desc&apikey=${this.apiKey}`;

    const checkTransactions = async () => {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as EtherscanResponse<EtherscanTransaction[]>;

      // Status '1' means success and transactions found
      if (data.status === '1' && Array.isArray(data.result) && data.result.length > 0) {
        return true;
      }

      return false;
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(checkTransactions);
    }
    return checkTransactions();
  }

  /**
   * Check if address has token transactions (ERC-20)
   */
  private async hasTokenTransactions(address: string): Promise<boolean> {
    const url = `${this.chainConfig.explorerApiUrl}?module=account&action=tokentx&address=${address}&page=1&offset=1&sort=desc&apikey=${this.apiKey}`;

    const checkTransactions = async () => {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        return false;
      }

      const data = (await response.json()) as EtherscanResponse<EtherscanTransaction[]>;

      // Status '1' means success and transactions found
      if (data.status === '1' && Array.isArray(data.result) && data.result.length > 0) {
        return true;
      }

      return false;
    };

    if (this.rateLimiter) {
      return this.rateLimiter.execute(checkTransactions);
    }
    return checkTransactions();
  }

  /**
   * Resolve ENS name for Ethereum mainnet
   */
  async resolveAddressName(address: string): Promise<string | null> {
    // ENS only works on Ethereum mainnet
    if (this.chainConfig.chainId !== 1) {
      return null;
    }

    try {
      // We'll implement ENS resolution in a future iteration
      // For now, return null
      return null;
    } catch (error) {
      logger.debug({ address, error }, 'Failed to resolve ENS name');
      return null;
    }
  }
}
