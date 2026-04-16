/**
 * Blockchain Service Manager
 * Coordinates all blockchain services and provides unified interface
 */

import { Service } from 'typedi';
import { config } from '../../config/pricing';
import { createComponentLogger } from '../../utils/logger';
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
import type { IBlockchainService, WalletImportResult, WalletInfo } from './types';

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
    // All EVM chains use the same unified Etherscan V2 API with a single key
    for (const [key, chainConfig] of Object.entries(EVM_CHAINS)) {
      if (chainConfig.isActive && chainConfig.explorerApiUrl) {
        const service = new EvmChainService(chainConfig, {
          apiKey: config.etherscan.apiKey,
          rateLimiter: GLOBAL_BLOCKCHAIN_RATE_LIMITERS.etherscan,
        });
        this.services.set(chainConfig.chainId, service);
        logger.debug({ chain: key, chainId: chainConfig.chainId }, 'Initialized EVM chain service');
      }
    }

    // Initialize non-EVM chain services
    const bitcoinChain = NON_EVM_CHAINS.bitcoin;
    const solanaChain = NON_EVM_CHAINS.solana;
    const tronChain = NON_EVM_CHAINS.tron;
    const tonChain = NON_EVM_CHAINS.ton;

    if (bitcoinChain?.isActive) {
      const service = new BitcoinChainService(bitcoinChain, {
        rateLimiter: GLOBAL_BLOCKCHAIN_RATE_LIMITERS.bitcoin,
      });
      this.services.set(bitcoinChain.chainId, service);
      logger.debug(
        { chain: 'bitcoin', chainId: bitcoinChain.chainId },
        'Initialized Bitcoin chain service'
      );
    }

    if (solanaChain?.isActive) {
      const service = new SolanaChainService(solanaChain, {
        rateLimiter: GLOBAL_BLOCKCHAIN_RATE_LIMITERS.solana,
      });
      this.services.set(solanaChain.chainId, service);
      logger.debug(
        { chain: 'solana', chainId: solanaChain.chainId },
        'Initialized Solana chain service'
      );
    }

    if (tronChain?.isActive) {
      const service = new TronChainService(tronChain, {
        rateLimiter: GLOBAL_BLOCKCHAIN_RATE_LIMITERS.tron,
      });
      this.services.set(tronChain.chainId, service);
      logger.debug({ chain: 'tron', chainId: tronChain.chainId }, 'Initialized Tron chain service');
    }

    if (tonChain?.isActive) {
      const service = new TonChainService(tonChain, {
        rateLimiter: GLOBAL_BLOCKCHAIN_RATE_LIMITERS.ton,
      });
      this.services.set(tonChain.chainId, service);
      logger.debug({ chain: 'ton', chainId: tonChain.chainId }, 'Initialized TON chain service');
    }

    logger.info({ totalChains: this.services.size }, 'Blockchain services initialized');
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
   * Resolve ENS name for an Ethereum address (mainnet only).
   * Returns null if not resolvable or not an Ethereum address.
   */
  async resolveEnsName(address: string): Promise<string | null> {
    const ethereumService = this.services.get(1); // Ethereum mainnet chainId
    if (ethereumService?.resolveAddressName) {
      try {
        return await ethereumService.resolveAddressName(address);
      } catch (_error) {
        logger.debug({ address: `${address.substring(0, 10)}...` }, 'Failed to resolve ENS name');
        return null;
      }
    }
    return null;
  }

  /**
   * Detect which chains a wallet address exists on
   * Checks for any transaction activity (normal, internal, or token transactions)
   * Returns ALL chains where the wallet has activity, regardless of current balance
   */
  async detectWalletChains(address: string): Promise<Array<string | number>> {
    const detectedChains: Array<string | number> = [];
    const startTime = Date.now();

    logger.info(
      { address: `${address.substring(0, 10)}...`, totalChainsToCheck: this.services.size },
      'Starting wallet chain detection'
    );

    // Try all services in parallel
    const checks = Array.from(this.services.entries()).map(async ([chainId, service]) => {
      const chainStartTime = Date.now();
      try {
        // First check if address format is valid for this chain
        if (!service.isValidAddress(address)) {
          return null;
        }

        // Check if wallet has any activity on this chain
        // Use hasActivity method if available (for EVM chains), otherwise fall back to balance check
        if (service.hasActivity) {
          const hasActivity = await service.hasActivity(address);
          if (hasActivity) {
            const chainDuration = Date.now() - chainStartTime;
            logger.debug(
              {
                chainId,
                chainName: service.getChainName(),
                duration: `${chainDuration}ms`,
              },
              `Wallet detected on ${service.getChainName()} (${chainDuration}ms)`
            );
            return chainId;
          }
        } else {
          // Fallback: check for balances (for non-EVM chains)
          const balances = await service.getTokenBalances(address);
          if (balances.length > 0) {
            const chainDuration = Date.now() - chainStartTime;
            logger.debug(
              {
                chainId,
                chainName: service.getChainName(),
                duration: `${chainDuration}ms`,
              },
              `Wallet detected on ${service.getChainName()} (${chainDuration}ms)`
            );
            return chainId;
          }
        }

        return null;
      } catch (error) {
        // If there's an error, the wallet likely doesn't exist on this chain
        const chainDuration = Date.now() - chainStartTime;
        logger.debug(
          {
            chainId,
            chainName: service.getChainName(),
            address: `${address.substring(0, 10)}...`,
            duration: `${chainDuration}ms`,
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : { name: 'Error', message: String(error) },
          },
          `Wallet not detected on ${service.getChainName()} (${chainDuration}ms): ${error instanceof Error ? error.message : String(error)}`
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

    const totalDuration = Date.now() - startTime;
    logger.info(
      {
        address: `${address.substring(0, 10)}...`,
        detectedChains: detectedChains.length,
        totalChainsChecked: this.services.size,
        totalDuration: `${totalDuration}ms`,
        avgDurationPerChain: `${Math.round(totalDuration / this.services.size)}ms`,
      },
      `Wallet chain detection completed in ${totalDuration}ms (found on ${detectedChains.length} chains)`
    );

    return detectedChains;
  }

  /**
   * Import wallet address across all detected chains
   */
  async importWalletAddress(address: string): Promise<WalletImportResult> {
    logger.info({ address: `${address.substring(0, 10)}...` }, 'Starting wallet import');

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

    // Try to resolve ENS name on Ethereum mainnet first
    // This will be reused for all chains if found
    let ensName: string | undefined;
    const ethereumService = this.services.get(1); // Ethereum mainnet chainId
    if (ethereumService?.resolveAddressName) {
      try {
        const name = await ethereumService.resolveAddressName(address);
        if (name) {
          ensName = name;
          logger.info(
            { address: `${address.substring(0, 10)}...`, ensName },
            'ENS name resolved - will be used for all chains'
          );
        }
      } catch (_error) {
        // Ignore ENS resolution errors
        logger.debug({ address }, 'Failed to resolve ENS name');
      }
    }

    // Fetch balances from all detected chains in parallel
    const walletPromises = detectedChainIds.map(async (chainId) => {
      const service = this.services.get(chainId);
      if (!service) return null;

      const chainConfig = getChainConfig(chainId);
      if (!chainConfig) return null;

      try {
        const balances = await service.getTokenBalances(address);

        // Always return wallet info for detected chains, even if balances are empty
        // This ensures accounts are created for all chains with activity
        // Use the ENS name resolved earlier if available
        return {
          address,
          displayName: ensName,
          chainId,
          chainName: chainConfig.name,
          balances,
        } satisfies WalletInfo;
      } catch (error) {
        logger.error(
          {
            chainId,
            chainName: chainConfig.name,
            address,
            error:
              error instanceof Error
                ? { name: error.name, message: error.message }
                : { name: 'Error', message: String(error) },
          },
          `Failed to fetch wallet balances on ${chainConfig.name}: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
      }
    });

    const walletResults = await Promise.all(walletPromises);
    const wallets = walletResults.filter((w) => w !== null) as WalletInfo[];

    const totalTokens = wallets.reduce((sum, wallet) => sum + wallet.balances.length, 0);
    const chainsDetected = wallets.map((w) => w.chainName);

    logger.info(
      {
        address: `${address.substring(0, 10)}...`,
        chains: chainsDetected.length,
        tokens: totalTokens,
        ensName: ensName || 'none',
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
