/**
 * EVM Chain Balance Service
 *
 * Fetches native token balances and ERC-20 token balances from EVM-compatible chains
 * Supports all chains defined in config/chains.ts
 */

import Decimal from 'decimal.js';
import { Contract, JsonRpcProvider } from 'ethers';
import { EVM_CHAINS, getChainConfig, isEVMAddress } from '../../../config/chains';
import { createComponentLogger } from '../../../utils/logger';
import {
  type ChainBalanceService,
  ChainServiceError,
  type ERC20BalanceService,
  type ERC20TokenBalance,
  type ERC20TokenInfo,
  InvalidAddressError,
  type TokenBalance,
  UnsupportedChainError,
} from './base';

// Create component logger for EVM service
const evmLogger = createComponentLogger('chain:evm');

// ERC-20 ABI (minimal - only functions we need)
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
];

/**
 * Simple rate limiter for RPC calls
 * Prevents hitting RPC rate limits by tracking requests per chain
 */
class RPCRateLimiter {
  private requestCounts: Map<number, { count: number; resetTime: number }> = new Map();
  private readonly maxRequestsPerMinute = 30; // Conservative limit for public RPCs
  private readonly windowMs = 60000; // 1 minute

  canMakeRequest(chainId: number): boolean {
    const now = Date.now();
    const data = this.requestCounts.get(chainId);

    // No previous requests or window expired
    if (!data || now >= data.resetTime) {
      this.requestCounts.set(chainId, {
        count: 1,
        resetTime: now + this.windowMs,
      });
      return true;
    }

    // Check if under limit
    if (data.count < this.maxRequestsPerMinute) {
      data.count++;
      return true;
    }

    return false;
  }

  getTimeUntilReset(chainId: number): number {
    const data = this.requestCounts.get(chainId);
    if (!data) return 0;
    return Math.max(0, data.resetTime - Date.now());
  }
}

export class EVMChainService implements ChainBalanceService, ERC20BalanceService {
  private rateLimiter = new RPCRateLimiter();
  private providers: Map<number, JsonRpcProvider> = new Map();

  getServiceName(): string {
    return 'EVMChainService';
  }

  supportsChain(chainId: number): boolean {
    return chainId in EVM_CHAINS;
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    // Validate address format
    if (!isEVMAddress(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    // Check chain support
    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) {
      throw new UnsupportedChainError(chainId, address);
    }

    // Check rate limit
    if (!this.rateLimiter.canMakeRequest(chainId)) {
      const waitTime = this.rateLimiter.getTimeUntilReset(chainId);
      evmLogger.warn(
        { chainId, waitTime },
        `Rate limit hit for chain ${chainId}, wait ${waitTime}ms`
      );
      throw new ChainServiceError(
        `Rate limit exceeded, retry in ${Math.ceil(waitTime / 1000)}s`,
        chainId,
        address
      );
    }

    // Try each RPC URL until one succeeds
    let lastError: unknown;
    for (const rpcUrl of chainConfig.rpcUrls) {
      try {
        const balance = await this.fetchBalanceFromRPC(rpcUrl, address, chainConfig);

        evmLogger.info(
          { address, chainName: chainConfig.name, balance: balance.toString() },
          `Fetched balance for ${address} on ${chainConfig.name}: ${balance.toString()}`
        );

        return {
          address,
          chainId,
          chainName: chainConfig.name,
          tokenSymbol: chainConfig.nativeCurrency.symbol,
          balance,
          decimals: chainConfig.nativeCurrency.decimals,
        };
      } catch (error) {
        lastError = error;
        evmLogger.warn(
          {
            chainId,
            rpcUrl,
            error: error instanceof Error ? error.message : String(error),
          },
          `RPC ${rpcUrl} failed for chain ${chainId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        // Continue to next RPC
      }
    }

    // All RPCs failed
    throw new ChainServiceError(
      `All RPC endpoints failed for chain ${chainId}`,
      chainId,
      address,
      lastError
    );
  }

  /**
   * Fetch balance from a specific RPC endpoint
   */
  private async fetchBalanceFromRPC(
    rpcUrl: string,
    address: string,
    chainConfig: { nativeCurrency: { decimals: number } }
  ): Promise<Decimal> {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getBalance',
        params: [address, 'latest'],
        id: 1,
      }),
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!response.ok) {
      throw new Error(`RPC HTTP error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      error?: { message: string };
      result?: string;
    };

    if (data.error) {
      throw new Error(`RPC error: ${data.error.message || JSON.stringify(data.error)}`);
    }

    if (!data.result) {
      throw new Error('No result in RPC response');
    }

    // Convert hex balance to Decimal
    // Remove '0x' prefix and convert from wei to token amount
    const balanceWei = BigInt(data.result);
    const decimals = chainConfig.nativeCurrency.decimals;

    // Convert to Decimal using string to maintain precision
    const balance = new Decimal(balanceWei.toString()).div(new Decimal(10).pow(decimals));

    return balance;
  }

  /**
   * Fetch balances across all supported EVM chains for an address
   * Returns only chains with non-zero balances
   */
  async getBalancesAcrossChains(address: string): Promise<TokenBalance[]> {
    if (!isEVMAddress(address)) {
      throw new InvalidAddressError(0, address);
    }

    const chainIds = Object.keys(EVM_CHAINS).map(Number);
    const balances: TokenBalance[] = [];

    // Fetch balances concurrently but with rate limiting
    const results = await Promise.allSettled(
      chainIds.map((chainId) => this.getNativeBalance(address, chainId))
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        // Only include non-zero balances
        if (result.value.balance.greaterThan(0)) {
          balances.push(result.value);
        }
      } else {
        // Log errors but don't fail the entire operation
        evmLogger.error(
          { address, reason: String(result.reason) },
          'Failed to fetch balance for address'
        );
      }
    }

    return balances;
  }

  /**
   * Get or create JsonRpcProvider for a chain
   */
  private getProvider(chainId: number): JsonRpcProvider {
    let provider = this.providers.get(chainId);
    if (!provider) {
      const chainConfig = getChainConfig(chainId);
      if (!chainConfig) {
        throw new UnsupportedChainError(chainId, '');
      }
      // Use first RPC URL for provider with proper network configuration
      // This prevents "JsonRpcProvider failed to detect network" errors
      provider = new JsonRpcProvider(
        chainConfig.rpcUrls[0],
        chainId, // Explicitly specify the chain ID
        { staticNetwork: true } // Use static network to avoid network detection
      );
      this.providers.set(chainId, provider);
    }
    return provider;
  }

  /**
   * Get ERC-20 token metadata
   */
  async getTokenInfo(tokenAddress: string, chainId: number): Promise<ERC20TokenInfo> {
    if (!isEVMAddress(tokenAddress)) {
      throw new InvalidAddressError(chainId, tokenAddress);
    }

    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) {
      throw new UnsupportedChainError(chainId, tokenAddress);
    }

    try {
      const provider = this.getProvider(chainId);
      const contract = new Contract(tokenAddress, ERC20_ABI, provider);

      // Fetch metadata in parallel
      const [symbol, name, decimalsResult] = await Promise.all([
        contract.symbol?.() as Promise<string>,
        contract.name?.() as Promise<string>,
        contract.decimals?.() as Promise<bigint>,
      ]);

      return {
        address: tokenAddress.toLowerCase(),
        symbol: symbol || 'UNKNOWN',
        name: name || 'Unknown Token',
        decimals: Number(decimalsResult),
      };
    } catch (error) {
      throw new ChainServiceError(
        `Failed to fetch token info for ${tokenAddress}`,
        chainId,
        tokenAddress,
        error
      );
    }
  }

  /**
   * Get ERC-20 token balance for a wallet
   */
  async getTokenBalance(
    walletAddress: string,
    tokenAddress: string,
    chainId: number
  ): Promise<ERC20TokenBalance> {
    if (!isEVMAddress(walletAddress)) {
      throw new InvalidAddressError(chainId, walletAddress);
    }
    if (!isEVMAddress(tokenAddress)) {
      throw new InvalidAddressError(chainId, tokenAddress);
    }

    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) {
      throw new UnsupportedChainError(chainId, walletAddress);
    }

    // Check rate limit
    if (!this.rateLimiter.canMakeRequest(chainId)) {
      const waitTime = this.rateLimiter.getTimeUntilReset(chainId);
      throw new ChainServiceError(
        `Rate limit exceeded, retry in ${Math.ceil(waitTime / 1000)}s`,
        chainId,
        walletAddress
      );
    }

    try {
      const provider = this.getProvider(chainId);
      const contract = new Contract(tokenAddress, ERC20_ABI, provider);

      // Fetch token info and balance in parallel
      const [tokenInfo, rawBalance] = await Promise.all([
        this.getTokenInfo(tokenAddress, chainId),
        contract.balanceOf?.(walletAddress) as Promise<bigint>,
      ]);

      // Convert balance using token decimals
      const balance = new Decimal(rawBalance.toString()).div(
        new Decimal(10).pow(tokenInfo.decimals)
      );

      evmLogger.info(
        {
          walletAddress,
          tokenSymbol: tokenInfo.symbol,
          chainName: chainConfig.name,
          balance: balance.toString(),
        },
        `Fetched ${tokenInfo.symbol} balance for ${walletAddress} on ${
          chainConfig.name
        }: ${balance.toString()}`
      );

      return {
        ...tokenInfo,
        balance,
        chainId,
        chainName: chainConfig.name,
        walletAddress,
      };
    } catch (error) {
      throw new ChainServiceError(
        `Failed to fetch token balance for ${tokenAddress}`,
        chainId,
        walletAddress,
        error
      );
    }
  }

  /**
   * Get balances for multiple ERC-20 tokens
   * Fetches sequentially to respect rate limits
   */
  async getMultipleTokenBalances(
    walletAddress: string,
    tokenAddresses: string[],
    chainId: number
  ): Promise<ERC20TokenBalance[]> {
    if (!isEVMAddress(walletAddress)) {
      throw new InvalidAddressError(chainId, walletAddress);
    }

    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) {
      throw new UnsupportedChainError(chainId, walletAddress);
    }

    const balances: ERC20TokenBalance[] = [];

    // Fetch balances sequentially to avoid rate limiting
    // TODO: Optimize with Multicall3 in the future
    for (const tokenAddress of tokenAddresses) {
      try {
        const balance = await this.getTokenBalance(walletAddress, tokenAddress, chainId);

        // Only include non-zero balances
        if (balance.balance.greaterThan(0)) {
          balances.push(balance);
        }
      } catch (error) {
        // Log error but continue with other tokens
        evmLogger.error(
          {
            tokenAddress,
            chainId,
            error: error instanceof Error ? error.message : String(error),
          },
          `Failed to fetch balance for token ${tokenAddress} on chain ${chainId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    evmLogger.info(
      {
        walletAddress,
        chainName: chainConfig.name,
        balanceCount: balances.length,
      },
      `Fetched ${balances.length} non-zero token balances for ${walletAddress} on ${chainConfig.name}`
    );

    return balances;
  }
}

// Singleton instance
export const evmChainService = new EVMChainService();
