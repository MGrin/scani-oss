/**
 * SolanaIntegration - Integration for Solana blockchain
 *
 * This integration handles Solana blockchain using RPC authentication.
 * Solana uses public RPC endpoints for querying blockchain data.
 */

import type { ChainConfig } from '../blockchain-services';
import { SolanaChainService } from '../blockchain-services';
import type {
  ICredentialManager,
  IntegrationAuthType,
  IWalletManager,
  RateLimiter,
} from '../types';
import { BlockchainIntegration } from './BlockchainIntegration';

/**
 * Integration for Solana blockchain
 */
export class SolanaIntegration extends BlockchainIntegration {
  constructor(
    institutionId: string,
    chainConfig: ChainConfig,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    // Create Solana chain service
    const solanaService = new SolanaChainService(chainConfig, {
      rateLimiter,
    });

    // RPC authentication (Solana uses public RPC)
    const authConfig = {
      type: 'rpc' as IntegrationAuthType.RPC,
      rpcUrl: 'https://api.mainnet-beta.solana.com', // Public Solana RPC
      chainId: 'solana',
    };

    super(institutionId, authConfig, solanaService, rateLimiter, credentialManager, walletManager);
  }

  /**
   * Get the chain ID for Solana
   */
  getChainId(): string | number {
    return this.blockchainService.getChainId();
  }

  /**
   * Get the chain name for Solana
   */
  getChainName(): string {
    return this.blockchainService.getChainName();
  }
}
