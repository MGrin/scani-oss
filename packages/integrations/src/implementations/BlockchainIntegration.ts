/**
 * BlockchainIntegration - Base class for blockchain integrations
 *
 * This class wraps existing IBlockchainService implementations and adapts them
 * to the ScaniIntegration interface. It provides a unified way to interact with
 * blockchain networks through the integration framework.
 *
 * Supports both EVM and non-EVM chains:
 * - EVM chains (Ethereum, Polygon, etc.) use API_KEY authentication with Etherscan
 * - Non-EVM chains (Bitcoin, Solana, etc.) use RPC authentication
 */

import type { IBlockchainService, TokenBalance } from '@scani/core/external-services/blockchain';
import { ScaniIntegration } from '../base';
import type {
  AuthConfig,
  FetchAccountsResult,
  FetchHoldingsResult,
  ICredentialManager,
  IntegrationHolding,
  IWalletManager,
  RateLimiter,
  TokenMappingResult,
} from '../types';

/**
 * Abstract base class for blockchain integrations
 * Wraps IBlockchainService and adapts it to ScaniIntegration interface
 */
export abstract class BlockchainIntegration extends ScaniIntegration {
  protected readonly blockchainService: IBlockchainService;

  constructor(
    institutionId: string,
    authConfig: AuthConfig,
    blockchainService: IBlockchainService,
    rateLimiter: RateLimiter,
    credentialManager?: ICredentialManager,
    walletManager?: IWalletManager
  ) {
    super(institutionId, authConfig, rateLimiter, credentialManager, walletManager);
    this.blockchainService = blockchainService;
  }

  /**
   * Fetch accounts (wallet addresses) for a blockchain
   *
   * For blockchain integrations, "accounts" are wallet addresses.
   * This method retrieves wallet addresses from the wallet manager.
   */
  async fetchAccounts(credentials?: Record<string, unknown>): Promise<FetchAccountsResult> {
    try {
      // If wallet manager is available and credentials contain userId
      if (this.walletManager && credentials?.userId) {
        const userId = credentials.userId as string;
        const wallets = await this.walletManager.getUserWallets(userId);

        // Filter wallets that are associated with this institution (chain)
        const chainWallets = wallets.filter((wallet) =>
          wallet.institutionIds.includes(this.institutionId)
        );

        const accounts = chainWallets.map((wallet) => ({
          externalId: wallet.walletAddress,
          name: wallet.label || wallet.walletAddress,
          accountType: 'wallet',
          description: `${this.blockchainService.getChainName()} wallet`,
          metadata: {
            walletId: wallet.id,
            chainId: this.blockchainService.getChainId(),
            chainName: this.blockchainService.getChainName(),
          },
          isActive: wallet.isActive,
        }));

        return {
          accounts,
          total: accounts.length,
        };
      }

      // If no wallet manager or credentials, return empty result
      return {
        accounts: [],
        total: 0,
        errors: ['No wallet manager available or missing userId in credentials'],
      };
    } catch (error) {
      return {
        accounts: [],
        total: 0,
        errors: [
          error instanceof Error ? error.message : 'Unknown error fetching blockchain accounts',
        ],
      };
    }
  }

  /**
   * Fetch holdings (token balances) for a specific wallet address
   *
   * @param accountId - The wallet address
   * @param credentials - Optional credentials (not typically needed for public blockchain queries)
   */
  async fetchHoldings(
    accountId: string,
    _credentials?: Record<string, unknown>
  ): Promise<FetchHoldingsResult> {
    try {
      // Validate the address format
      if (!this.blockchainService.isValidAddress(accountId)) {
        return {
          holdings: [],
          total: 0,
          accountId,
          timestamp: new Date(),
          errors: [`Invalid address format for ${this.blockchainService.getChainName()}`],
        };
      }

      // Fetch token balances using the blockchain service
      const balances = await this.executeWithRateLimit(() =>
        this.blockchainService.getTokenBalances(accountId)
      );

      // Convert TokenBalance to IntegrationHolding
      const holdings = balances.map((balance) => this.convertTokenBalance(balance));

      return {
        holdings,
        total: holdings.length,
        accountId,
        timestamp: new Date(),
      };
    } catch (error) {
      return {
        holdings: [],
        total: 0,
        accountId,
        timestamp: new Date(),
        errors: [
          error instanceof Error ? error.message : 'Unknown error fetching blockchain holdings',
        ],
      };
    }
  }

  /**
   * Map a blockchain token to Scani's token format
   *
   * This method converts blockchain-specific token data into the format
   * expected by Scani's token system.
   */
  async mapToken(holding: IntegrationHolding): Promise<TokenMappingResult> {
    const chainId = this.blockchainService.getChainId();
    const chainName = this.blockchainService.getChainName();

    return {
      token: {
        symbol: holding.symbol,
        name: holding.name,
        typeId: '', // Will be set by the service layer (crypto type)
        decimals: holding.decimals,
        iconUrl: holding.iconUrl,
        providerMetadata: JSON.stringify({
          chainId,
          chainName,
          externalId: holding.externalTokenId,
          contractAddress: holding.contractAddress,
          isNative: !holding.contractAddress, // Native tokens don't have contract addresses
          ...holding.metadata,
        }),
      },
      isNew: false, // The service layer will determine if this is a new token
      confidence: 1.0, // High confidence for blockchain data
    };
  }

  /**
   * Convert TokenBalance from blockchain service to IntegrationHolding
   */
  protected convertTokenBalance(balance: TokenBalance): IntegrationHolding {
    return {
      symbol: balance.symbol,
      name: balance.name,
      balance: balance.balance,
      decimals: balance.decimals,
      tokenType: 'crypto',
      externalTokenId: balance.tokenAddress,
      contractAddress: balance.isNative ? undefined : balance.tokenAddress,
      iconUrl: balance.iconUrl,
      metadata: {
        coinGeckoId: balance.coinGeckoId,
        isNative: balance.isNative,
        chainMetadata: balance.metadata,
      },
    };
  }

  /**
   * Check if wallet has any activity on this blockchain
   */
  async hasActivity(address: string): Promise<boolean> {
    try {
      if (!this.blockchainService.isValidAddress(address)) {
        return false;
      }

      // Use hasActivity method if available (EVM chains)
      if (this.blockchainService.hasActivity) {
        return await this.executeWithRateLimit(() => this.blockchainService.hasActivity!(address));
      }

      // Fallback: check if wallet has any token balances
      const balances = await this.executeWithRateLimit(() =>
        this.blockchainService.getTokenBalances(address)
      );
      return balances.length > 0;
    } catch (_error) {
      return false;
    }
  }
}
