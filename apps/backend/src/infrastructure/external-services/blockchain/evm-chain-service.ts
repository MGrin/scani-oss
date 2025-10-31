/**
 * EVM Chain Service
 * Handles balance fetching for EVM-compatible chains using Etherscan V2 unified API
 *
 * Uses the unified Etherscan V2 endpoint: https://api.etherscan.io/v2/api
 * with chainid parameter to specify which chain to query
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
 * EVM Chain Service using Etherscan V2 unified API
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
   * Build Etherscan V2 API URL with chainid parameter
   * The unified endpoint requires chainid for all requests
   */
  private buildApiUrl(params: Record<string, string | number>): string {
    if (!this.chainConfig.explorerApiUrl) {
      throw new Error(`No explorerApiUrl configured for chain ${this.chainConfig.name}`);
    }

    const urlParams = new URLSearchParams();

    // Add chainid parameter for Etherscan V2 unified API
    urlParams.append('chainid', this.chainConfig.chainId.toString());

    // Add all other parameters
    for (const [key, value] of Object.entries(params)) {
      urlParams.append(key, value.toString());
    }

    // Add API key
    urlParams.append('apikey', this.apiKey);

    return `${this.chainConfig.explorerApiUrl}?${urlParams.toString()}`;
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
          chainName: this.chainConfig.name,
          address,
          totalTokens: balances.length,
        },
        `Fetched token balances on ${this.chainConfig.name}`
      );

      return balances;
    } catch (error) {
      logger.error(
        {
          chainId: this.chainConfig.chainId,
          chainName: this.chainConfig.name,
          address,
          explorerUrl: this.chainConfig.explorerApiUrl,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: 'Error', message: String(error) },
        },
        `Failed to fetch token balances on ${this.chainConfig.name}: ${error instanceof Error ? error.message : String(error)}`
      );
      throw error;
    }
  }

  /**
   * Get native token (ETH, BNB, etc.) balance
   */
  private async getNativeBalance(address: string): Promise<TokenBalance | null> {
    const url = this.buildApiUrl({
      module: 'account',
      action: 'balance',
      address: address,
      tag: 'latest',
    });

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
    const url = this.buildApiUrl({
      module: 'account',
      action: 'tokentx',
      address: address,
      page: '1',
      offset: '10000',
      sort: 'desc',
    });

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
                error:
                  error instanceof Error
                    ? { name: error.name, message: error.message }
                    : { name: 'Error', message: String(error) },
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
    const url = this.buildApiUrl({
      module: 'account',
      action: 'tokenbalance',
      contractaddress: contractAddress,
      address: address,
      tag: 'latest',
    });

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
          chainName: this.chainConfig.name,
          address: `${address.substring(0, 10)}...`,
          url: this.chainConfig.explorerApiUrl,
          error:
            error instanceof Error
              ? { name: error.name, message: error.message }
              : { name: 'Error', message: String(error) },
        },
        `Error checking wallet activity on ${this.chainConfig.name}: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
  }

  /**
   * Check if address has normal transactions
   */
  private async hasNormalTransactions(address: string): Promise<boolean> {
    return this.hasTransactionsByAction(address, 'txlist');
  }

  /**
   * Check if address has internal transactions
   */
  private async hasInternalTransactions(address: string): Promise<boolean> {
    return this.hasTransactionsByAction(address, 'txlistinternal');
  }

  /**
   * Check if address has token transactions (ERC-20)
   */
  private async hasTokenTransactions(address: string): Promise<boolean> {
    return this.hasTransactionsByAction(address, 'tokentx');
  }

  /**
   * Generic method to check if address has transactions for a specific action
   */
  private async hasTransactionsByAction(
    address: string,
    action: 'txlist' | 'txlistinternal' | 'tokentx'
  ): Promise<boolean> {
    const url = this.buildApiUrl({
      module: 'account',
      action: action,
      address: address,
      page: '1',
      offset: '1',
      sort: 'desc',
    });

    const checkTransactions = async () => {
      try {
        const response = await fetchWithTimeout(url);

        if (!response.ok) {
          logger.debug(
            {
              chainId: this.chainConfig.chainId,
              chainName: this.chainConfig.name,
              action,
              status: response.status,
              statusText: response.statusText,
              url: this.chainConfig.explorerApiUrl,
            },
            `HTTP error while checking transactions on ${this.chainConfig.name}`
          );
          return false;
        }

        const data = (await response.json()) as EtherscanResponse<EtherscanTransaction[]>;

        // Status '1' means success and transactions found
        if (data.status === '1' && Array.isArray(data.result) && data.result.length > 0) {
          return true;
        }

        return false;
      } catch (error) {
        logger.debug(
          {
            chainId: this.chainConfig.chainId,
            chainName: this.chainConfig.name,
            action,
            url: this.chainConfig.explorerApiUrl,
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : { name: 'Error', message: String(error) },
          },
          `Error checking transactions on ${this.chainConfig.name}: ${error instanceof Error ? error.message : String(error)}`
        );
        return false;
      }
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
