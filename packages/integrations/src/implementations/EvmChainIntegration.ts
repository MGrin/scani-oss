/**
 * EvmChainIntegration - Integration for EVM-compatible blockchains
 *
 * This integration handles all EVM-compatible chains (Ethereum, Polygon, Arbitrum, etc.)
 * using the unified Etherscan V2 API. It uses API_KEY authentication.
 *
 * Supported chains include:
 * - Ethereum, Polygon, BSC, Avalanche, Arbitrum, Optimism, Base
 * - And 30+ other EVM chains supported by Etherscan V2 API
 */

import type { ChainConfig } from '../blockchain-services';
import { EvmChainService } from '../blockchain-services';
import type {
  ICredentialManager,
  IntegrationAuthType,
  IWalletManager,
  RateLimiter,
} from '../types';
import { BlockchainIntegration } from './BlockchainIntegration';

/**
 * Integration for EVM-compatible blockchains
 */
export class EvmChainIntegration extends BlockchainIntegration {
  constructor(
    institutionId: string,
    chainConfig: ChainConfig,
    apiKey: string,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    // Create EVM chain service
    const evmService = new EvmChainService(chainConfig, {
      apiKey,
      rateLimiter,
    });

    // API_KEY authentication for Etherscan
    const authConfig = {
      type: 'api_key' as IntegrationAuthType.API_KEY,
      apiKey,
      baseUrl: chainConfig.explorerApiUrl || 'https://api.etherscan.io/v2/api',
    };

    super(institutionId, authConfig, evmService, rateLimiter, credentialManager, walletManager);
  }

  /**
   * Get the chain ID for this EVM chain
   */
  getChainId(): string | number {
    return this.blockchainService.getChainId();
  }

  /**
   * Get the chain name for this EVM chain
   */
  getChainName(): string {
    return this.blockchainService.getChainName();
  }
}
