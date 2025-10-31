/**
 * Blockchain Service Manager
 * Coordinates all blockchain services and provides unified interface
 */

import { Service } from 'typedi';
import { config } from '../../../config/pricing';
import { createComponentLogger } from '../../../utils/logger';
import { RateLimiter } from '../pricing/utils';
import { BitcoinChainService } from './bitcoin-chain-service';
import {
  type ChainConfig,
  EVM_CHAINS,
  getAllChains,
  getChainConfig,
  NON_EVM_CHAINS,
} from './chain-config';
import { EvmChainService } from './evm-chain-service';
import { SolanaChainService } from './solana-chain-service';
import { TonChainService } from './ton-chain-service';
import { TronChainService } from './tron-chain-service';
import type {
  BlockchainServiceConfig,
  IBlockchainService,
  TokenBalance,
  WalletImportResult,
  WalletInfo,
} from './types';

const logger = createComponentLogger('blockchain-service-manager');

/**
 * Global rate limiters for blockchain APIs
 * Shared across all chain services to prevent exceeding provider limits
 */
const GLOBAL_BLOCKCHAIN_RATE_LIMITERS = {
  // Etherscan: 5 calls/second free tier
  etherscan: new RateLimiter(5, 1000),
  // Bitcoin blockchain.info: ~1 call/10 seconds to be safe
  bitcoin: new RateLimiter(1, 10000),
  // Solana public RPC: ~10 calls/second
  solana: new RateLimiter(10, 1000),
  // Tron TronGrid: ~20 calls/second free tier
  tron: new RateLimiter(20, 1000),
  // TON toncenter: ~1 call/second free tier
  ton: new RateLimiter(1, 1000),
};

/**
 * Blockchain Service Manager
 */
@Service()
export class BlockchainServiceManager {
  private readonly services = new Map<string | number, IBlockchainService>();

  constructor() {
    this.initializeServices();
  }

  /**
   * Initialize all blockchain services
   */
  private initializeServices(): void {
    // Initialize EVM chain services
    for (const [key, chainConfig] of Object.entries(EVM_CHAINS)) {
      if (chainConfig.isActive && chainConfig.explorerApiUrl) {
        const service = new EvmChainService(chainConfig, {
          apiKey: this.getEtherscanApiKey(chainConfig),
          rateLimiter: GLOBAL_BLOCKCHAIN_RATE_LIMITERS.etherscan,
        });
        this.services.set(chainConfig.chainId, service);
        logger.debug({ chain: key, chainId: chainConfig.chainId }, 'Initialized EVM chain service');
      }
    }

    // Initialize non-EVM chain services
    const nonEvmConfigs: [string, ChainConfig, IBlockchainService][] = [
      [
        'bitcoin',
        NON_EVM_CHAINS.bitcoin,
        new BitcoinChainService(NON_EVM_CHAINS.bitcoin, {
          rateLimiter: GLOBAL_BLOCKCHAIN_RATE_LIMITERS.bitcoin,
        }),
      ],
      [
        'solana',
        NON_EVM_CHAINS.solana,
        new SolanaChainService(NON_EVM_CHAINS.solana, {
          rateLimiter: GLOBAL_BLOCKCHAIN_RATE_LIMITERS.solana,
        }),
      ],
      [
        'tron',
        NON_EVM_CHAINS.tron,
        new TronChainService(NON_EVM_CHAINS.tron, {
          rateLimiter: GLOBAL_BLOCKCHAIN_RATE_LIMITERS.tron,
        }),
      ],
      [
        'ton',
        NON_EVM_CHAINS.ton,
        new TonChainService(NON_EVM_CHAINS.ton, {
          rateLimiter: GLOBAL_BLOCKCHAIN_RATE_LIMITERS.ton,
        }),
      ],
    ];

    for (const [key, chainConfig, service] of nonEvmConfigs) {
      if (chainConfig.isActive) {
        this.services.set(chainConfig.chainId, service);
        logger.debug(
          { chain: key, chainId: chainConfig.chainId },
          'Initialized non-EVM chain service'
        );
      }
    }

    logger.info({ totalChains: this.services.size }, 'Blockchain services initialized');
  }

  /**
   * Get Etherscan API key for a specific chain
   */
  private getEtherscanApiKey(chainConfig: ChainConfig): string {
    const chainId = chainConfig.chainId as number;

    switch (chainId) {
      case 1: // Ethereum
        return config.etherscan.ethereum;
      case 137: // Polygon
        return config.etherscan.polygon;
      case 56: // BSC
        return config.etherscan.bsc;
      case 42161: // Arbitrum
        return config.etherscan.arbitrum;
      case 10: // Optimism
        return config.etherscan.optimism;
      case 8453: // Base
        return config.etherscan.base;
      case 43114: // Avalanche
        return config.etherscan.avalanche;
      default:
        // Use default Etherscan key for other chains
        return config.etherscan.default;
    }
  }

  /**
   * Get blockchain service for a specific chain
   */
  getService(chainId: string | number): IBlockchainService | undefined {
    return this.services.get(chainId);
  }

  /**
   * Get all active chain IDs
   */
  getActiveChainIds(): Array<string | number> {
    return Array.from(this.services.keys());
  }

  /**
   * Detect which chains a wallet address exists on
   * Tries to validate and fetch balances on all supported chains
   */
  async detectWalletChains(address: string): Promise<Array<string | number>> {
    const detectedChains: Array<string | number> = [];

    // Try all services in parallel
    const checks = Array.from(this.services.entries()).map(async ([chainId, service]) => {
      try {
        // First check if address format is valid for this chain
        if (!service.isValidAddress(address)) {
          return null;
        }

        // Try to fetch balances (this confirms the wallet exists on this chain)
        const balances = await service.getTokenBalances(address);

        // If we got balances (even if empty), the wallet exists on this chain
        if (balances.length > 0) {
          return chainId;
        }

        return null;
      } catch (error) {
        // If there's an error, the wallet likely doesn't exist on this chain
        logger.debug(
          {
            chainId,
            address: address.substring(0, 10) + '...',
            error: error instanceof Error ? error.message : String(error),
          },
          'Wallet not detected on chain'
        );
        return null;
      }
    });

    const results = await Promise.all(checks);

    for (const chainId of results) {
      if (chainId !== null) {
        detectedChains.push(chainId);
      }
    }

    logger.info(
      {
        address: address.substring(0, 10) + '...',
        detectedChains: detectedChains.length,
      },
      'Detected wallet chains'
    );

    return detectedChains;
  }

  /**
   * Import wallet address across all detected chains
   */
  async importWalletAddress(address: string): Promise<WalletImportResult> {
    logger.info({ address: address.substring(0, 10) + '...' }, 'Starting wallet import');

    // Detect which chains this wallet exists on
    const detectedChainIds = await this.detectWalletChains(address);

    if (detectedChainIds.length === 0) {
      logger.warn({ address }, 'No chains detected for wallet');
      return {
        wallets: [],
        totalTokens: 0,
        chainsDetected: [],
      };
    }

    // Fetch balances from all detected chains in parallel
    const walletPromises = detectedChainIds.map(async (chainId) => {
      const service = this.services.get(chainId);
      if (!service) return null;

      try {
        const balances = await service.getTokenBalances(address);
        const chainConfig = getChainConfig(chainId);

        if (!chainConfig) return null;

        // Try to resolve address name (e.g., ENS) for EVM chains
        let displayName: string | undefined;
        if (service.resolveAddressName) {
          try {
            const name = await service.resolveAddressName(address);
            if (name) displayName = name;
          } catch (error) {
            // Ignore ENS resolution errors
            logger.debug({ address, chainId }, 'Failed to resolve address name');
          }
        }

        return {
          address,
          displayName,
          chainId,
          chainName: chainConfig.name,
          balances,
        } satisfies WalletInfo;
      } catch (error) {
        logger.error(
          {
            chainId,
            address,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to fetch wallet balances'
        );
        return null;
      }
    });

    const walletResults = await Promise.all(walletPromises);
    const wallets = walletResults.filter((w): w is WalletInfo => w !== null);

    const totalTokens = wallets.reduce((sum, wallet) => sum + wallet.balances.length, 0);
    const chainsDetected = wallets.map((w) => w.chainName);

    logger.info(
      {
        address: address.substring(0, 10) + '...',
        chains: chainsDetected.length,
        tokens: totalTokens,
      },
      'Wallet import completed'
    );

    return {
      wallets,
      totalTokens,
      chainsDetected,
    };
  }

  /**
   * Get all supported chains
   */
  getAllSupportedChains(): ChainConfig[] {
    return getAllChains();
  }
}
