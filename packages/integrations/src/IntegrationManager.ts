/**
 * IntegrationManager
 *
 * Manages all institution integrations and provides unified access to them.
 * Uses a registry-based architecture to support all integration types:
 * - Blockchains (Ethereum, Bitcoin, Solana, etc.)
 * - Exchanges (Binance, Kraken, Coinbase, etc.)
 * - Brokers, Banks, Payment providers, and more
 *
 * This manager:
 * - Creates integrations on-demand using the integration registry
 * - Provides lookup by institution ID
 * - Maintains database-backed chain-to-institution mappings for backwards compatibility
 * - Manages global rate limiters
 * - Integrates with TypeDI for dependency injection
 */

import { db } from '@scani/core/database/connection';
import * as schema from '@scani/core/database/schema';
import type { ChainConfig } from '@scani/core/external-services/blockchain';
import { getChainConfig } from '@scani/core/external-services/blockchain';
import { InstitutionBlockchainMappingRepository } from '@scani/core/repositories';
import { createComponentLogger } from '@scani/core/utils/logger';
import { RateLimiter } from '@scani/rate-limiter';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import type { ScaniIntegration } from './base';
import { allIntegrationConfigs } from './config/integrationConfigs';
import {
  BitcoinIntegration,
  BlockchainIntegration,
  EvmChainIntegration,
  SolanaIntegration,
  TonIntegration,
  TronIntegration,
} from './implementations';
import { integrationRegistry } from './registry/IntegrationRegistry';

const logger = createComponentLogger('integration-manager');

/**
 * Type guard to check if an integration is a BlockchainIntegration
 * This provides type-safe access to blockchain-specific methods like hasActivity
 */
function isBlockchainIntegration(
  integration: ScaniIntegration
): integration is BlockchainIntegration {
  return integration instanceof BlockchainIntegration;
}

/**
 * Global rate limiters for all APIs
 * Shared across all integrations to prevent exceeding provider limits
 */
const GLOBAL_INTEGRATION_RATE_LIMITERS = {
  // Etherscan: 7 calls/second paid plan
  etherscan: new RateLimiter(7, 1000),
  // Bitcoin blockchain.info: ~1 call/10 seconds to be safe
  bitcoin: new RateLimiter(1, 10000),
  // Solana public RPC: ~10 calls/second
  solana: new RateLimiter(10, 1000),
  // Tron TronGrid: ~20 calls/second free tier
  tron: new RateLimiter(20, 1000),
  // TON toncenter: ~1 call/second free tier
  ton: new RateLimiter(1, 1000),
  // Binance: ~10 calls/second (conservative)
  binance: new RateLimiter(10, 1000),
};

/**
 * Create a blockchain integration factory for a given chain mapping.
 * Returns a function that creates the correct integration type on demand.
 */
function createBlockchainIntegrationFactory(
  institutionId: string,
  chainConfig: ChainConfig,
  chainType: string
): (() => ScaniIntegration) | null {
  const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';

  switch (chainType) {
    case 'evm':
      return () =>
        new EvmChainIntegration(
          institutionId,
          chainConfig,
          ETHERSCAN_API_KEY,
          GLOBAL_INTEGRATION_RATE_LIMITERS.etherscan,
          undefined,
          undefined
        );
    case 'bitcoin':
      return () =>
        new BitcoinIntegration(
          institutionId,
          chainConfig,
          GLOBAL_INTEGRATION_RATE_LIMITERS.bitcoin,
          undefined,
          undefined
        );
    case 'solana':
      return () =>
        new SolanaIntegration(
          institutionId,
          chainConfig,
          GLOBAL_INTEGRATION_RATE_LIMITERS.solana,
          undefined,
          undefined
        );
    case 'tron':
      return () =>
        new TronIntegration(
          institutionId,
          chainConfig,
          GLOBAL_INTEGRATION_RATE_LIMITERS.tron,
          undefined,
          undefined
        );
    case 'ton':
      return () =>
        new TonIntegration(
          institutionId,
          chainConfig,
          GLOBAL_INTEGRATION_RATE_LIMITERS.ton,
          undefined,
          undefined
        );
    default:
      return null;
  }
}

/**
 * Initialize the integration registry
 * This happens once at startup and registers all available integrations
 * (exchanges AND blockchains) so the registry is the single source of truth.
 */
async function initializeIntegrationRegistry(): Promise<void> {
  if (integrationRegistry.size() > 0) {
    logger.debug('Integration registry already initialized');
    return;
  }

  logger.debug('Initializing integration registry with all configurations');

  // First, register all exchange integrations with their static IDs
  allIntegrationConfigs.forEach((config) => {
    integrationRegistry.register(config);
  });

  // Then, dynamically register exchange integrations with their database UUIDs
  try {
    const knownExchanges = allIntegrationConfigs.map((config) => config.name);

    for (const exchangeName of knownExchanges) {
      const [institution] = await db
        .select()
        .from(schema.institutions)
        .where(eq(schema.institutions.name, exchangeName))
        .limit(1);

      if (institution) {
        const staticConfig = allIntegrationConfigs.find((config) => config.name === exchangeName);

        if (staticConfig) {
          integrationRegistry.register({
            ...staticConfig,
            institutionId: institution.id,
          });
          logger.debug(
            {
              exchangeName,
              staticId: staticConfig.institutionId,
              dbId: institution.id,
            },
            'Registered exchange with database UUID'
          );
        }
      }
    }
  } catch (error) {
    logger.warn(
      { error },
      'Failed to register exchanges with database UUIDs - will fall back to static IDs'
    );
  }

  // Register blockchain integrations from DB mappings so the registry
  // is the single source of truth (no more fallback to InstitutionBlockchainMappingRepository)
  try {
    const mappings = await db
      .select()
      .from(schema.institutionBlockchainMappings)
      .where(eq(schema.institutionBlockchainMappings.isActive, true));

    let registered = 0;
    for (const mapping of mappings) {
      const chainConfig = getChainConfig(mapping.chainId);
      if (!chainConfig) continue;

      const factory = createBlockchainIntegrationFactory(
        mapping.institutionId,
        chainConfig,
        mapping.chainType
      );
      if (!factory) continue;

      integrationRegistry.register({
        institutionId: mapping.institutionId,
        name: chainConfig.name,
        type: 'blockchain',
        authType: 'rpc',
        createIntegration: factory,
      });
      registered++;
    }

    logger.info(
      { blockchainCount: registered, exchangeCount: allIntegrationConfigs.length },
      'Integration registry initialized'
    );
  } catch (error) {
    logger.warn(
      { error },
      'Failed to register blockchain integrations - will fall back to DB mappings'
    );
  }
}

/**
 * IntegrationManager Service
 * Manages all institution integrations using a registry-based architecture
 */
@Service()
export class IntegrationManager {
  private readonly integrationCache = new Map<string, ScaniIntegration>();
  private readonly mappingRepository = Container.get(InstitutionBlockchainMappingRepository);
  private initialized = false;

  /**
   * Initialize the manager (called once at startup)
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await initializeIntegrationRegistry();
    this.initialized = true;
  }

  /**
   * Get integration by institution ID
   * First tries the registry (supports all integration types),
   * then falls back to database mappings for backwards compatibility with blockchains
   */
  async getIntegration(institutionId: string): Promise<ScaniIntegration | undefined> {
    // Ensure registry is initialized
    await this.initialize();

    // Check cache first
    if (this.integrationCache.has(institutionId)) {
      return this.integrationCache.get(institutionId);
    }

    // Try to create from registry (supports all integration types)
    const integration = integrationRegistry.createIntegration(institutionId);

    if (integration) {
      this.integrationCache.set(institutionId, integration);
      return integration;
    }

    // Fall back to database mappings for backwards compatibility with blockchains
    // This supports legacy chain-based integrations
    const mapping = await this.mappingRepository.findByInstitutionId(institutionId);

    if (!mapping || !mapping.isActive) {
      return undefined;
    }

    // Get chain configuration
    const chainConfig = getChainConfig(mapping.chainId);
    if (!chainConfig) {
      return undefined;
    }

    // Create blockchain integration from chain config
    const blockchainIntegration = this.createBlockchainIntegration(
      institutionId,
      chainConfig,
      mapping.chainType
    );

    if (blockchainIntegration) {
      this.integrationCache.set(institutionId, blockchainIntegration);
      return blockchainIntegration;
    }

    return undefined;
  }

  /**
   * Create blockchain integration instance from chain config
   * This is only used for backwards compatibility with legacy chain-based integrations
   */
  private createBlockchainIntegration(
    institutionId: string,
    chainConfig: ChainConfig,
    chainType: string
  ): ScaniIntegration | undefined {
    const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';

    switch (chainType) {
      case 'evm':
        return new EvmChainIntegration(
          institutionId,
          chainConfig,
          ETHERSCAN_API_KEY,
          GLOBAL_INTEGRATION_RATE_LIMITERS.etherscan,
          undefined,
          undefined
        );

      case 'bitcoin':
        return new BitcoinIntegration(
          institutionId,
          chainConfig,
          GLOBAL_INTEGRATION_RATE_LIMITERS.bitcoin,
          undefined,
          undefined
        );

      case 'solana':
        return new SolanaIntegration(
          institutionId,
          chainConfig,
          GLOBAL_INTEGRATION_RATE_LIMITERS.solana,
          undefined,
          undefined
        );

      case 'tron':
        return new TronIntegration(
          institutionId,
          chainConfig,
          GLOBAL_INTEGRATION_RATE_LIMITERS.tron,
          undefined,
          undefined
        );

      case 'ton':
        return new TonIntegration(
          institutionId,
          chainConfig,
          GLOBAL_INTEGRATION_RATE_LIMITERS.ton,
          undefined,
          undefined
        );

      default:
        return undefined;
    }
  }

  /**
   * Get all active institution IDs that have integrations
   * Uses database query instead of loading all into memory
   */
  async getActiveInstitutionIds(): Promise<string[]> {
    const mappings = await this.mappingRepository.findAllActive();
    return mappings.map((m) => m.institutionId);
  }

  /**
   * Check if an institution has an integration available
   */
  async hasIntegration(institutionId: string): Promise<boolean> {
    const mapping = await this.mappingRepository.findByInstitutionId(institutionId);
    return mapping?.isActive ?? false;
  }

  /**
   * Get the chain ID for an institution
   */
  async getChainIdForInstitution(institutionId: string): Promise<string | undefined> {
    const mapping = await this.mappingRepository.findByInstitutionId(institutionId);
    return mapping?.chainId;
  }

  /**
   * Detect which chains (institutions) a wallet address exists on
   * Returns institution IDs where the wallet has activity
   *
   * @param address - Wallet address to check
   * @returns Array of institution IDs where the wallet has activity
   */
  async detectWalletChains(address: string): Promise<string[]> {
    const detectedInstitutionIds: string[] = [];

    // Get all active mappings
    const mappings = await this.mappingRepository.findAllActive();

    if (mappings.length === 0) {
      logger.warn('No active institution mappings found - wallet detection cannot proceed');
      return [];
    }

    logger.debug(
      {
        address: `${address.substring(0, 10)}...`,
        mappingsCount: mappings.length,
      },
      'Checking wallet activity across chains'
    );

    // Check each integration in parallel
    const checks = mappings.map(async (mapping) => {
      try {
        const integration = await this.getIntegration(mapping.institutionId);

        if (!integration) {
          logger.debug(
            { institutionId: mapping.institutionId, chainId: mapping.chainId },
            'Integration not available for mapping'
          );
          return null;
        }

        // Use type guard to check if integration supports hasActivity
        if (isBlockchainIntegration(integration)) {
          const hasActivity = await integration.hasActivity(address);
          if (hasActivity) {
            logger.debug(
              {
                institutionId: mapping.institutionId,
                chainId: mapping.chainId,
              },
              'Wallet has activity on chain'
            );
            return mapping.institutionId;
          }
        }

        return null;
      } catch (error) {
        // If there's an error, the wallet likely doesn't exist on this chain
        logger.debug(
          {
            institutionId: mapping.institutionId,
            chainId: mapping.chainId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Error checking wallet activity on chain'
        );
        return null;
      }
    });

    const results = await Promise.all(checks);

    for (const institutionId of results) {
      if (institutionId !== null) {
        detectedInstitutionIds.push(institutionId);
      }
    }

    logger.info(
      {
        address: `${address.substring(0, 10)}...`,
        detectedCount: detectedInstitutionIds.length,
        totalChecked: mappings.length,
      },
      'Wallet chain detection completed'
    );

    return detectedInstitutionIds;
  }

  /**
   * Clear integration cache (useful for testing or when mappings change)
   */
  clearCache(): void {
    this.integrationCache.clear();
  }
}
