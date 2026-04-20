/**
 * TonIntegration - Integration for TON (The Open Network) blockchain
 *
 * This integration handles TON blockchain using RPC authentication.
 * TON uses Toncenter API for querying blockchain data.
 */

import type { ChainConfig } from '../blockchain-services';
import { TonChainService } from '../blockchain-services';
import type {
  ICredentialManager,
  IntegrationAuthType,
  IWalletManager,
  RateLimiter,
} from '../types';
import { BlockchainIntegration } from './BlockchainIntegration';

/**
 * Integration for TON blockchain
 */
export class TonIntegration extends BlockchainIntegration {
  constructor(
    institutionId: string,
    chainConfig: ChainConfig,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    // Create TON chain service
    const tonService = new TonChainService(chainConfig, {
      rateLimiter,
    });

    // RPC authentication (TON uses Toncenter API)
    const authConfig = {
      type: 'rpc' as IntegrationAuthType.RPC,
      rpcUrl: 'https://toncenter.com/api/v2', // Toncenter API
      chainId: 'ton',
    };

    super(institutionId, authConfig, tonService, rateLimiter, credentialManager, walletManager);
  }

  /**
   * Get the chain ID for TON
   */
  getChainId(): string | number {
    return this.blockchainService.getChainId();
  }

  /**
   * Get the chain name for TON
   */
  getChainName(): string {
    return this.blockchainService.getChainName();
  }
}
