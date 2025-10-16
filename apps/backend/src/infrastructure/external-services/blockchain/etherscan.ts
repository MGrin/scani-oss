/**
 * Etherscan V2 API Service
 *
 * Uses unified Etherscan V2 API endpoint for ALL EVM chains.
 * Single endpoint: https://api.etherscan.io/v2/api?chainid={chainId}
 *
 * Features:
 * - Get native balance for any EVM chain
 * - Get all ERC-20 token holdings with balances
 * - Check if wallet exists on specific chains
 *
 * Rate Limiting:
 * - addresstokenbalance endpoint: 2 calls/second (throttled by Etherscan)
 * - All other endpoints: 5 calls/second (free tier)
 *
 * Supported chains: All EVM chains in our database (30+ chains)
 */

import Decimal from 'decimal.js';
import { EVM_CHAINS } from '../../../config/chains';
import { config } from '../../../config/pricing';
import { createComponentLogger } from '../../../utils/logger';

const etherscanLogger = createComponentLogger('etherscan');

/**
 * Etherscan V2 unified API endpoint
 * Works for ALL EVM chains with chainid parameter
 */
const ETHERSCAN_V2_BASE_URL = 'https://api.etherscan.io/v2/api';

/**
 * Rate limiter for Etherscan API calls
 * Conservative rate: 2 calls/second for token endpoints, 5 calls/second for others
 */
class EtherscanRateLimiter {
  private lastCallTime = 0;
  private readonly minInterval = 500; // 500ms = 2 calls/second (safest for all endpoints)

  async waitIfNeeded(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastCallTime;

    if (timeSinceLastCall < this.minInterval) {
      const waitTime = this.minInterval - timeSinceLastCall;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    this.lastCallTime = Date.now();
  }
}

const rateLimiter = new EtherscanRateLimiter();

/**
 * Get Etherscan API key
 * V2 API uses single API key for all chains
 */
function getApiKey(): string {
  return config.etherscan.ethereum || config.etherscan.default;
}

/**
 * Native balance result from Etherscan
 */
export interface NativeBalance {
  balance: Decimal; // Converted to Decimal for precision
  chainId: number;
  chainName: string;
  walletAddress: string;
}

/**
 * Discovered ERC-20 token info with balance
 */
export interface DiscoveredToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: number;
  balance: string; // Raw balance string (will be converted to Decimal later)
}

/**
 * Etherscan V2 API response format
 */
interface EtherscanV2Response<T> {
  status: string;
  message?: string;
  result: T | string;
}

/**
 * Etherscan addresstokenbalance response
 */
interface EtherscanTokenBalance {
  TokenAddress: string;
  TokenName: string;
  TokenSymbol: string;
  TokenQuantity: string;
  TokenDivisor: string;
}

/**
 * Check if wallet has any activity on a specific chain
 * Returns true if wallet has non-zero native balance OR any ERC-20 tokens
 *
 * @param walletAddress - EVM wallet address
 * @param chainId - EVM chain ID
 * @returns True if wallet exists on chain, false otherwise
 */
export async function walletExistsOnChain(
  walletAddress: string,
  chainId: number
): Promise<boolean> {
  const chainConfig = EVM_CHAINS[chainId];
  if (!chainConfig) {
    etherscanLogger.warn({ chainId }, `Chain ${chainId} not found in EVM_CHAINS config`);
    return false;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    etherscanLogger.warn({}, 'No Etherscan API key configured, cannot check wallet existence');
    return false;
  }

  try {
    // Respect rate limit
    await rateLimiter.waitIfNeeded();

    // Check native balance
    const url = new URL(ETHERSCAN_V2_BASE_URL);
    url.searchParams.set('chainid', chainId.toString());
    url.searchParams.set('module', 'account');
    url.searchParams.set('action', 'balance');
    url.searchParams.set('address', walletAddress);
    url.searchParams.set('tag', 'latest');
    url.searchParams.set('apikey', apiKey);

    const response = await fetch(url.toString());

    if (!response.ok) {
      etherscanLogger.warn(
        { chainId, status: response.status },
        `HTTP error checking wallet existence on chain ${chainId}`
      );
      return false;
    }

    const data = (await response.json()) as EtherscanV2Response<string>;

    if (data.status !== '1') {
      // API error - assume wallet doesn't exist
      return false;
    }

    const balance = new Decimal(data.result);

    // Wallet exists if it has any balance
    if (!balance.isZero()) {
      return true;
    }

    // If no native balance, check for ERC-20 tokens
    // (Wallets can have tokens but no native balance)
    const tokens = await getERC20TokenHoldings(walletAddress, chainId, 1, 1);
    return tokens.length > 0;
  } catch (error) {
    etherscanLogger.error(
      {
        walletAddress,
        chainId,
        error: error instanceof Error ? error.message : String(error),
      },
      `Failed to check wallet existence on chain ${chainId}`
    );
    return false;
  }
}

/**
 * Get native balance for a wallet on a specific chain
 *
 * @param walletAddress - EVM wallet address
 * @param chainId - EVM chain ID
 * @returns Native balance with chain info, or undefined if error
 */
export async function getNativeBalance(
  walletAddress: string,
  chainId: number
): Promise<NativeBalance | undefined> {
  const chainConfig = EVM_CHAINS[chainId];
  if (!chainConfig) {
    etherscanLogger.warn({ chainId }, `Chain ${chainId} not found in EVM_CHAINS config`);
    return undefined;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    etherscanLogger.warn({}, 'No Etherscan API key configured, cannot fetch native balance');
    return undefined;
  }

  try {
    // Respect rate limit
    await rateLimiter.waitIfNeeded();

    const url = new URL(ETHERSCAN_V2_BASE_URL);
    url.searchParams.set('chainid', chainId.toString());
    url.searchParams.set('module', 'account');
    url.searchParams.set('action', 'balance');
    url.searchParams.set('address', walletAddress);
    url.searchParams.set('tag', 'latest');
    url.searchParams.set('apikey', apiKey);

    etherscanLogger.info(
      { walletAddress, chainId },
      `Fetching native balance from Etherscan V2 for chain ${chainId}`
    );

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as EtherscanV2Response<string>;

    if (data.status !== '1') {
      throw new Error(`Etherscan API error: ${data.message || data.result}`);
    }

    // Balance is in wei, convert to Decimal
    const balanceWei = new Decimal(data.result);

    etherscanLogger.info(
      {
        walletAddress,
        chainId,
        balance: balanceWei.toString(),
      },
      `Fetched native balance: ${balanceWei
        .div(new Decimal(10).pow(chainConfig.nativeCurrency.decimals))
        .toString()} ${chainConfig.nativeCurrency.symbol}`
    );

    return {
      balance: balanceWei,
      chainId,
      chainName: chainConfig.name,
      walletAddress,
    };
  } catch (error) {
    etherscanLogger.error(
      {
        walletAddress,
        chainId,
        error: error instanceof Error ? error.message : String(error),
      },
      `Failed to fetch native balance from Etherscan for chain ${chainId}`
    );
    return undefined;
  }
}

/**
 * Get all ERC-20 token holdings for a wallet on a specific chain
 * Uses V2 API addresstokenbalance endpoint
 *
 * @param walletAddress - EVM wallet address
 * @param chainId - EVM chain ID
 * @param page - Page number for pagination (default: 1)
 * @param offset - Number of results per page (default: 100, max: 100)
 * @returns Array of discovered tokens with balances (empty if no tokens or API fails)
 */
export async function getERC20TokenHoldings(
  walletAddress: string,
  chainId: number,
  page = 1,
  offset = 100
): Promise<DiscoveredToken[]> {
  const chainConfig = EVM_CHAINS[chainId];
  if (!chainConfig) {
    etherscanLogger.warn({ chainId }, `Chain ${chainId} not found in EVM_CHAINS config`);
    return [];
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    etherscanLogger.warn({}, 'No Etherscan API key configured, cannot fetch token holdings');
    return [];
  }

  try {
    // Respect rate limit (2 calls/second for this endpoint)
    await rateLimiter.waitIfNeeded();

    const url = new URL(ETHERSCAN_V2_BASE_URL);
    url.searchParams.set('chainid', chainId.toString());
    url.searchParams.set('module', 'account');
    url.searchParams.set('action', 'addresstokenbalance');
    url.searchParams.set('address', walletAddress);
    url.searchParams.set('page', page.toString());
    url.searchParams.set('offset', offset.toString());
    url.searchParams.set('apikey', apiKey);

    etherscanLogger.info(
      { walletAddress, chainId, page, offset },
      `Fetching ERC-20 token holdings from Etherscan V2 for chain ${chainId}`
    );

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as EtherscanV2Response<EtherscanTokenBalance[]>;

    if (data.status !== '1') {
      // status "0" with message "No records found" is normal for wallets without tokens
      if (data.message === 'No records found' || data.message === 'No transactions found') {
        etherscanLogger.info(
          { walletAddress, chainId },
          'No token holdings found (wallet has no ERC-20 tokens)'
        );
        return [];
      }

      throw new Error(`Etherscan API error: ${data.message || data.result}`);
    }

    const holdings = Array.isArray(data.result) ? data.result : [];

    // Fetch decimals from token contracts (with fallback to 18)
    // Import EVM chain service for decimal fetching
    const { evmChainService } = await import('./evm');

    // Fetch decimals in parallel for all tokens
    const decimalPromises = holdings.map(async (holding): Promise<number> => {
      try {
        const tokenInfo = await evmChainService.getTokenInfo(holding.TokenAddress, chainId);
        return tokenInfo.decimals;
      } catch (error) {
        etherscanLogger.warn(
          {
            walletAddress,
            chainId,
            tokenAddress: holding.TokenAddress,
            tokenSymbol: holding.TokenSymbol,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to fetch decimals from token contract, using fallback of 18'
        );
        return 18; // Fallback to ERC-20 standard
      }
    });

    const decimals: number[] = await Promise.all(decimalPromises);

    // Convert to our format with fetched decimals
    const tokens: DiscoveredToken[] = holdings.map((holding, index) => {
      const tokenDecimals = decimals[index];
      if (tokenDecimals === undefined) {
        etherscanLogger.error({ index, holding }, 'Decimal undefined at index');
        throw new Error('Decimals array mismatch');
      }

      return {
        address: holding.TokenAddress.toLowerCase(),
        symbol: holding.TokenSymbol,
        name: holding.TokenName,
        decimals: tokenDecimals,
        chainId,
        balance: holding.TokenQuantity, // Keep as string for precision
      };
    });

    etherscanLogger.info(
      {
        walletAddress,
        chainId,
        tokenCount: tokens.length,
      },
      `Discovered ${tokens.length} ERC-20 token holdings on chain ${chainId}`
    );

    return tokens;
  } catch (error) {
    etherscanLogger.error(
      {
        walletAddress,
        chainId,
        error: error instanceof Error ? error.message : String(error),
      },
      `Failed to fetch ERC-20 token holdings from Etherscan for chain ${chainId}`
    );
    return [];
  }
}

/**
 * Discover which EVM chains a wallet exists on
 * Checks all EVM chains in parallel
 *
 * @param walletAddress - EVM wallet address
 * @param chainIds - Optional list of chain IDs to check (defaults to all EVM chains)
 * @returns Array of chain IDs where wallet has activity
 */
export async function discoverWalletChains(
  walletAddress: string,
  chainIds?: number[]
): Promise<number[]> {
  const chainsToCheck = chainIds || Object.keys(EVM_CHAINS).map(Number);

  etherscanLogger.info(
    { walletAddress, chainCount: chainsToCheck.length },
    `Checking wallet existence on ${chainsToCheck.length} EVM chains`
  );

  // Check all chains in parallel (rate limiter will queue them appropriately)
  const results = await Promise.all(
    chainsToCheck.map(async (chainId) => {
      const exists = await walletExistsOnChain(walletAddress, chainId);
      return exists ? chainId : null;
    })
  );

  const activeChains = results.filter((chainId) => chainId !== null) as number[];

  etherscanLogger.info(
    {
      walletAddress,
      activeChainCount: activeChains.length,
      activeChains,
    },
    `Wallet exists on ${activeChains.length} chains: ${activeChains.join(', ')}`
  );

  return activeChains;
}

/**
 * Check if a chain supports Etherscan V2 API
 * V2 API supports ALL EVM chains in our database
 */
export function supportsEtherscanV2(chainId: number): boolean {
  return chainId in EVM_CHAINS;
}

/**
 * Get list of all chains that support Etherscan V2 API
 */
export function getSupportedEtherscanChains(): number[] {
  return Object.keys(EVM_CHAINS).map(Number);
}

// Legacy export for backward compatibility
export const discoverTokensViaEtherscan = getERC20TokenHoldings;
