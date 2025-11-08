/**
 * TronIntegration - Integration for Tron blockchain
 *
 * This integration handles Tron blockchain using RPC authentication.
 * Tron uses TronGrid API for querying blockchain data.
 */

import type { ChainConfig } from '@scani/core/external-services/blockchain';
import { TronChainService } from '@scani/core/external-services/blockchain';
import type {
  ICredentialManager,
  IntegrationAuthType,
  IWalletManager,
  RateLimiter,
} from '../types';
import { BlockchainIntegration } from './BlockchainIntegration';

/**
 * Integration for Tron blockchain
 */
export class TronIntegration extends BlockchainIntegration {
  constructor(
    institutionId: string,
    chainConfig: ChainConfig,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    // Create Tron chain service
    const tronService = new TronChainService(chainConfig, {
      rateLimiter,
    });

    // RPC authentication (Tron uses TronGrid API)
    const authConfig = {
      type: 'rpc' as IntegrationAuthType.RPC,
      rpcUrl: 'https://api.trongrid.io', // TronGrid API
      chainId: 'tron',
    };

    super(institutionId, authConfig, tronService, rateLimiter, credentialManager, walletManager);
  }

  /**
   * Get the chain ID for Tron
   */
  getChainId(): string | number {
    return this.blockchainService.getChainId();
  }

  /**
   * Get the chain name for Tron
   */
  getChainName(): string {
    return this.blockchainService.getChainName();
  }
}
