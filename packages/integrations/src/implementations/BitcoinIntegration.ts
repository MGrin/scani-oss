/**
 * BitcoinIntegration - Integration for Bitcoin blockchain
 *
 * This integration handles Bitcoin blockchain using RPC authentication.
 * Bitcoin uses public blockchain APIs (blockchain.info) rather than requiring
 * a dedicated RPC endpoint.
 */

import type { ChainConfig } from '../blockchain-services';
import { BitcoinChainService } from '../blockchain-services';
import type {
  ICredentialManager,
  IntegrationAuthType,
  IWalletManager,
  RateLimiter,
} from '../types';
import { BlockchainIntegration } from './BlockchainIntegration';

/**
 * Integration for Bitcoin blockchain
 */
export class BitcoinIntegration extends BlockchainIntegration {
  constructor(
    institutionId: string,
    chainConfig: ChainConfig,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    // Create Bitcoin chain service
    const bitcoinService = new BitcoinChainService(chainConfig, {
      rateLimiter,
    });

    // RPC authentication (Bitcoin uses public API)
    const authConfig = {
      type: 'rpc' as IntegrationAuthType.RPC,
      rpcUrl: 'https://blockchain.info', // Public Bitcoin API
      chainId: 'bitcoin',
    };

    super(institutionId, authConfig, bitcoinService, rateLimiter, credentialManager, walletManager);
  }

  /**
   * Get the chain ID for Bitcoin
   */
  getChainId(): string | number {
    return this.blockchainService.getChainId();
  }

  /**
   * Get the chain name for Bitcoin
   */
  getChainName(): string {
    return this.blockchainService.getChainName();
  }
}
