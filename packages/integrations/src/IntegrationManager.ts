/**
 * IntegrationManager
 *
 * Manages all institution integrations and provides unified access to them.
 * Uses database-backed chain-to-institution mappings for dynamic configuration.
 *
 * This manager:
 * - Creates integrations on-demand using database mappings
 * - Provides lookup by institution ID
 * - Manages global rate limiters
 * - Integrates with TypeDI for dependency injection
 */

// Import chain configurations and services from core
import type { ChainConfig } from '@scani/core/external-services/blockchain';
import { getChainConfig } from '@scani/core/external-services/blockchain';
import { InstitutionBlockchainMappingRepository } from '@scani/core/repositories';
import { RateLimiter } from '@scani/rate-limiter';
import { Container, Service } from 'typedi';
import type { ScaniIntegration } from './base';
import {
  BitcoinIntegration,
  BlockchainIntegration,
  EvmChainIntegration,
  SolanaIntegration,
  TonIntegration,
  TronIntegration,
} from './implementations';

// Import config - needs to be exported from core
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';

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
 * Global rate limiters for blockchain APIs
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
};

/**
 * IntegrationManager Service
 * Manages all institution integrations using database-backed mappings
 */
@Service()
export class IntegrationManager {
  private readonly integrationCache = new Map<string, ScaniIntegration>();
  private readonly mappingRepository = Container.get(InstitutionBlockchainMappingRepository);

  /**
   * Get integration by institution ID
   * Creates integration on-demand using database mapping
   */
  async getIntegration(institutionId: string): Promise<ScaniIntegration | undefined> {
    // Check cache first
    if (this.integrationCache.has(institutionId)) {
      return this.integrationCache.get(institutionId);
    }

    // Fetch mapping from database
    const mapping = await this.mappingRepository.findByInstitutionId(institutionId);

    if (!mapping || !mapping.isActive) {
      return undefined;
    }

    // Get chain configuration
    const chainConfig = getChainConfig(mapping.chainId);
    if (!chainConfig) {
      return undefined;
    }

    // Create integration based on chain type
    const integration = this.createIntegration(institutionId, chainConfig, mapping.chainType);

    if (integration) {
      // Cache the integration
      this.integrationCache.set(institutionId, integration);
    }

    return integration;
  }

  /**
   * Create integration instance based on chain type
   */
  private createIntegration(
    institutionId: string,
    chainConfig: ChainConfig,
    chainType: string
  ): ScaniIntegration | undefined {
    switch (chainType) {
      case 'evm':
        return new EvmChainIntegration(
          institutionId,
          chainConfig,
          ETHERSCAN_API_KEY,
          GLOBAL_INTEGRATION_RATE_LIMITERS.etherscan,
          undefined, // credentialManager - will be added in phase 2
          undefined // walletManager - will be added in phase 2
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
      return [];
    }

    // Check each integration in parallel
    const checks = mappings.map(async (mapping) => {
      try {
        const integration = await this.getIntegration(mapping.institutionId);

        if (!integration) {
          return null;
        }

        // Use type guard to check if integration supports hasActivity
        if (isBlockchainIntegration(integration)) {
          const hasActivity = await integration.hasActivity(address);
          if (hasActivity) {
            return mapping.institutionId;
          }
        }

        return null;
      } catch (_error) {
        // If there's an error, the wallet likely doesn't exist on this chain
        return null;
      }
    });

    const results = await Promise.all(checks);

    for (const institutionId of results) {
      if (institutionId !== null) {
        detectedInstitutionIds.push(institutionId);
      }
    }

    return detectedInstitutionIds;
  }

  /**
   * Clear integration cache (useful for testing or when mappings change)
   */
  clearCache(): void {
    this.integrationCache.clear();
  }
}
