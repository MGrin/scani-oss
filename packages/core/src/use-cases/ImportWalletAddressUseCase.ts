/**
 * ImportWalletAddressUseCase
 *
 * Handles importing a crypto wallet address across multiple blockchains:
 * - Detects which chains the wallet exists on
 * - Fetches all token balances from each chain
 * - Creates institution for each chain (if not exists)
 * - Creates account for each chain with wallet metadata
 * - Creates holdings for each token with non-zero balance
 * - Fetches current token prices
 *
 * Reusable for:
 * - Manual wallet import by users
 * - Cron jobs for periodic balance updates
 * - Background sync operations
 */

import type { ScaniIntegration } from '@scani/integrations';
import { IntegrationManager } from '@scani/integrations';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { BlockchainServiceManager } from '../external-services/blockchain';
import type { WalletInfo } from '../external-services/blockchain/types';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { InstitutionBlockchainMappingRepository } from '../repositories/InstitutionBlockchainMappingRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { IntegrationCredentialsService } from '../services/IntegrationCredentialsService';
import { PricingService } from '../services/PricingService';
import { TokenService } from '../services/TokenService';
import { UserWalletService } from '../services/UserWalletService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:import-wallet');

export interface ImportWalletInput {
  /** Wallet address to import */
  address: string;
  /** Optional display name override */
  displayName?: string;
}

export interface ImportWalletResult {
  /** Created accounts (one per chain) */
  accounts: Array<{
    id: string;
    name: string;
    chainId: string | number;
    chainName: string;
    institutionId: string;
    institutionName: string;
  }>;
  /** Created holdings */
  holdings: Array<{
    id: string;
    accountId: string;
    tokenSymbol: string;
    tokenName: string;
    balance: string;
  }>;
  /** Total number of chains detected */
  chainsDetected: number;
  /** Total number of tokens imported */
  tokensImported: number;
  /** Errors encountered during import */
  errors: Array<{
    chainId: string | number;
    chainName: string;
    error: string;
  }>;
}

/**
 * Import Wallet Address Use Case
 */
@Service()
export class ImportWalletAddressUseCase {
  private readonly blockchainService = Container.get(BlockchainServiceManager);
  private readonly integrationManager = Container.get(IntegrationManager);
  private readonly userWalletService = Container.get(UserWalletService);
  private readonly integrationCredentialsService = Container.get(IntegrationCredentialsService);
  private readonly mappingRepository = Container.get(InstitutionBlockchainMappingRepository);
  private readonly pricingService = Container.get(PricingService);
  private readonly tokenService = Container.get(TokenService);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);

  async execute(input: ImportWalletInput, userId: string): Promise<ImportWalletResult> {
    logger.info(
      {
        userId,
        address: `${input.address.substring(0, 10)}...`,
      },
      'Starting wallet import'
    );

    // Get user info
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);

    if (!user) {
      throw new Error('User not found');
    }

    // Try new integration-based approach first
    try {
      const hasAnyMappings = (await this.mappingRepository.findAllActive()).length > 0;

      if (hasAnyMappings) {
        logger.debug('Using new integration-based wallet import');
        return await this.executeWithIntegrations(input, userId, user);
      }
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Integration-based import failed, falling back to legacy approach'
      );
    }

    // Fall back to legacy BlockchainServiceManager approach
    logger.debug('Using legacy blockchain service manager wallet import');
    return await this.executeWithLegacyService(input, userId, user);
  }

  /**
   * Execute wallet import using new integration-based approach
   */
  private async executeWithIntegrations(
    input: ImportWalletInput,
    userId: string,
    user: typeof schema.users.$inferSelect
  ): Promise<ImportWalletResult> {
    // Detect which chains (institutions) this wallet exists on
    const detectedInstitutionIds = await this.integrationManager.detectWalletChains(input.address);

    if (detectedInstitutionIds.length === 0) {
      logger.warn({ address: input.address }, 'No institutions detected for wallet');
      return {
        accounts: [],
        holdings: [],
        chainsDetected: 0,
        tokensImported: 0,
        errors: [],
      };
    }

    // Check if user_wallet already exists
    let userWallet = await this.userWalletService.getWalletByAddress(userId, input.address);

    if (!userWallet) {
      // Create new user_wallet entry
      userWallet = await this.userWalletService.createWallet({
        userId,
        walletAddress: input.address,
        institutionIds: detectedInstitutionIds,
        label: input.displayName,
        isActive: true,
      });

      logger.info(
        { walletId: userWallet.id, institutionIds: detectedInstitutionIds },
        'Created user wallet entry'
      );
    } else {
      // Update existing wallet with new institution IDs
      const existingIds = (userWallet.institutionIds as string[]) || [];
      const mergedIds = Array.from(new Set([...existingIds, ...detectedInstitutionIds]));

      if (mergedIds.length > existingIds.length) {
        userWallet = await this.userWalletService.updateWallet(userWallet.id, {
          institutionIds: mergedIds,
        });

        logger.info(
          { walletId: userWallet.id, institutionIds: mergedIds },
          'Updated user wallet with new institutions'
        );
      }
    }

    // Process each institution (chain)
    const accounts: ImportWalletResult['accounts'] = [];
    const holdings: ImportWalletResult['holdings'] = [];
    const errors: ImportWalletResult['errors'] = [];

    // Get account type for crypto wallets
    const [walletAccountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'crypto'))
      .limit(1);

    if (!walletAccountType) {
      throw new Error('Account type "crypto" not found');
    }

    // Get crypto token type
    const [cryptoTokenType] = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'crypto'))
      .limit(1);

    if (!cryptoTokenType) {
      throw new Error('Token type "crypto" not found');
    }

    for (const institutionId of detectedInstitutionIds) {
      try {
        const integration = await this.integrationManager.getIntegration(institutionId);

        if (!integration) {
          errors.push({
            chainId: institutionId,
            chainName: 'Unknown',
            error: 'Integration not found',
          });
          continue;
        }

        // Get institution details
        const [institution] = await db
          .select()
          .from(schema.institutions)
          .where(eq(schema.institutions.id, institutionId))
          .limit(1);

        if (!institution) {
          errors.push({
            chainId: institutionId,
            chainName: 'Unknown',
            error: 'Institution not found',
          });
          continue;
        }

        // Get mapping to find chain info
        const mapping = await this.mappingRepository.findByInstitutionId(institutionId);

        if (!mapping) {
          errors.push({
            chainId: institutionId,
            chainName: institution.name,
            error: 'Chain mapping not found',
          });
          continue;
        }

        const result = await this.processWalletWithIntegration(
          integration,
          input.address,
          userWallet.id,
          userId,
          user.baseCurrencyId || '',
          walletAccountType.id,
          cryptoTokenType.id,
          institution,
          mapping.chainId,
          input.displayName
        );

        accounts.push(result.account);
        holdings.push(...result.holdings);
      } catch (error) {
        logger.error(
          {
            institutionId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to process wallet on institution'
        );
        errors.push({
          chainId: institutionId,
          chainName: 'Unknown',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    logger.info(
      {
        userId,
        institutionsDetected: detectedInstitutionIds.length,
        accountsCreated: accounts.length,
        holdingsCreated: holdings.length,
        errors: errors.length,
      },
      'Wallet import completed with integrations'
    );

    return {
      accounts,
      holdings,
      chainsDetected: detectedInstitutionIds.length,
      tokensImported: holdings.length,
      errors,
    };
  }

  /**
   * Execute wallet import using legacy BlockchainServiceManager
   */
  private async executeWithLegacyService(
    input: ImportWalletInput,
    userId: string,
    user: typeof schema.users.$inferSelect
  ): Promise<ImportWalletResult> {
    // Import wallet address across all chains
    const walletResult = await this.blockchainService.importWalletAddress(input.address);

    if (walletResult.wallets.length === 0) {
      logger.warn({ address: input.address }, 'No wallets detected on any chain');
      return {
        accounts: [],
        holdings: [],
        chainsDetected: 0,
        tokensImported: 0,
        errors: [],
      };
    }

    // Process each wallet (one per chain)
    const accounts: ImportWalletResult['accounts'] = [];
    const holdings: ImportWalletResult['holdings'] = [];
    const errors: ImportWalletResult['errors'] = [];

    // Get account type for crypto wallets
    const [walletAccountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'crypto'))
      .limit(1);

    if (!walletAccountType) {
      throw new Error('Account type "crypto" not found');
    }

    // Get crypto token type
    const [cryptoTokenType] = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'crypto'))
      .limit(1);

    if (!cryptoTokenType) {
      throw new Error('Token type "crypto" not found');
    }

    for (const wallet of walletResult.wallets) {
      try {
        const result = await this.processWallet(
          wallet,
          userId,
          user.baseCurrencyId || '',
          walletAccountType.id,
          cryptoTokenType.id,
          input.displayName
        );
        accounts.push(result.account);
        holdings.push(...result.holdings);
      } catch (error) {
        logger.error(
          {
            chainId: wallet.chainId,
            chainName: wallet.chainName,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to process wallet on chain'
        );
        errors.push({
          chainId: wallet.chainId,
          chainName: wallet.chainName,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    logger.info(
      {
        userId,
        chainsDetected: walletResult.wallets.length,
        accountsCreated: accounts.length,
        holdingsCreated: holdings.length,
        errors: errors.length,
      },
      'Wallet import completed'
    );

    return {
      accounts,
      holdings,
      chainsDetected: walletResult.wallets.length,
      tokensImported: holdings.length,
      errors,
    };
  }

  /**
   * Process a wallet using integration-based approach
   */
  private async processWalletWithIntegration(
    integration: ScaniIntegration,
    walletAddress: string,
    userWalletId: string,
    userId: string,
    baseCurrencyId: string,
    walletAccountTypeId: string,
    cryptoTokenTypeId: string,
    institution: typeof schema.institutions.$inferSelect,
    chainId: string,
    displayNameOverride?: string
  ): Promise<{
    account: ImportWalletResult['accounts'][0];
    holdings: ImportWalletResult['holdings'];
  }> {
    // Fetch holdings from the integration
    const holdingsResult = await integration.fetchHoldings(walletAddress);

    if (holdingsResult.errors && holdingsResult.errors.length > 0) {
      logger.warn(
        { institutionId: institution.id, errors: holdingsResult.errors },
        'Errors fetching holdings from integration'
      );
    }

    // Generate account name
    const accountName = this.generateAccountName(
      institution.name,
      displayNameOverride || walletAddress
    );

    // Check if account already exists for this institution and address
    const existingAccounts = await db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, userId),
          eq(schema.accounts.institutionId, institution.id),
          eq(schema.accounts.name, accountName)
        )
      )
      .limit(1);

    let accountId: string;
    if (existingAccounts.length > 0 && existingAccounts[0]) {
      // Update existing account metadata with user_wallet_id and migrated flag
      accountId = existingAccounts[0].id;
      await db
        .update(schema.accounts)
        .set({
          metadata: {
            walletAddress,
            chainId,
            chainName: institution.name,
            displayName: displayNameOverride,
            lastSync: new Date().toISOString(),
            userWalletId, // NEW: Reference to user_wallet
            migrated: true, // NEW: Mark as migrated
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.accounts.id, accountId));

      logger.debug({ accountId, userWalletId }, 'Updated existing account with user_wallet_id');
    } else {
      // Create new account with user_wallet_id in metadata
      const [newAccount] = await db
        .insert(schema.accounts)
        .values({
          userId,
          institutionId: institution.id,
          name: accountName,
          typeId: walletAccountTypeId,
          description: `Crypto wallet on ${institution.name}`,
          metadata: {
            walletAddress,
            chainId,
            chainName: institution.name,
            displayName: displayNameOverride,
            lastSync: new Date().toISOString(),
            userWalletId, // NEW: Reference to user_wallet
            migrated: true, // NEW: Mark as migrated
          },
          isActive: true,
        })
        .returning();

      if (!newAccount) {
        throw new Error('Failed to create account');
      }

      accountId = newAccount.id;
      logger.debug({ accountId, userWalletId }, 'Created new account with user_wallet_id');
    }

    // Store/update credentials if needed (for now, just mark as stored for RPC-based chains)
    // Most blockchain integrations don't need credentials, but we store a marker
    try {
      const existingCredentials = await this.integrationCredentialsService.getCredentials(
        userId,
        institution.id
      );

      if (!existingCredentials) {
        await this.integrationCredentialsService.storeCredentials(
          userId,
          institution.id,
          { type: 'public_rpc' }, // Empty credentials for public blockchain access
          'rpc'
        );

        logger.debug({ institutionId: institution.id }, 'Stored public RPC credentials marker');
      }
    } catch (error) {
      // Non-critical error - continue processing
      logger.debug(
        {
          institutionId: institution.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to store credentials (non-critical)'
      );
    }

    // Create holdings for each token
    const holdings: ImportWalletResult['holdings'] = [];

    for (const holding of holdingsResult.holdings) {
      try {
        // Skip tokens with missing required data
        if (!holding.symbol || !holding.balance) {
          logger.warn(
            {
              institutionName: institution.name,
              holding,
            },
            'Skipping holding with missing symbol or balance'
          );
          continue;
        }

        // Map the integration holding to our token format
        const tokenMapping = await integration.mapToken(holding);

        // Find or create token using service method
        const token = await this.tokenService.findOrCreateTokenFromIntegration(
          tokenMapping,
          cryptoTokenTypeId
        );

        // Check if holding already exists (including hidden ones)
        const existingHolding = await this.holdingRepository.findByAccountAndToken(
          accountId,
          token.id,
          userId,
          undefined,
          undefined,
          true // Include hidden holdings
        );

        if (existingHolding) {
          // Update existing holding and unhide if it was hidden
          await db
            .update(schema.holdings)
            .set({
              balance: holding.balance,
              isHidden: false, // Unhide if balance is non-zero
              lastUpdated: new Date(),
            })
            .where(eq(schema.holdings.id, existingHolding.id));

          holdings.push({
            id: existingHolding.id,
            accountId,
            tokenSymbol: token.symbol,
            tokenName: token.name,
            balance: holding.balance,
          });
        } else {
          // Create new holding with blockchain source
          const [newHolding] = await db
            .insert(schema.holdings)
            .values({
              userId,
              accountId,
              tokenId: token.id,
              balance: holding.balance,
              source: 'blockchain', // Mark as blockchain-sourced
              isHidden: false,
              lastUpdated: new Date(),
            })
            .returning();

          if (!newHolding) {
            throw new Error('Failed to create holding');
          }

          holdings.push({
            id: newHolding.id,
            accountId,
            tokenSymbol: token.symbol,
            tokenName: token.name,
            balance: holding.balance,
          });
        }

        // Try to fetch current price (non-blocking)
        if (baseCurrencyId) {
          try {
            const baseCurrencyToken = await this.tokenService.getTokenById(baseCurrencyId);
            if (baseCurrencyToken) {
              await this.pricingService.getTokenPrice(token, baseCurrencyToken.symbol, new Date());
            }
          } catch (error) {
            logger.debug(
              {
                tokenSymbol: token.symbol,
                error: error instanceof Error ? error.message : String(error),
              },
              'Failed to fetch token price (non-critical)'
            );
          }
        }
      } catch (error) {
        logger.error(
          {
            tokenSymbol: holding?.symbol || 'unknown',
            tokenName: holding?.name || 'unknown',
            balance: holding?.balance || 'unknown',
            institutionName: institution.name,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to create holding for token'
        );
        // Continue with other tokens even if one fails
      }
    }

    return {
      account: {
        id: accountId,
        name: accountName,
        chainId,
        chainName: institution.name,
        institutionId: institution.id,
        institutionName: institution.name,
      },
      holdings,
    };
  }

  /**
   * Process a single wallet on a specific chain
   */
  private async processWallet(
    wallet: WalletInfo,
    userId: string,
    baseCurrencyId: string,
    walletAccountTypeId: string,
    cryptoTokenTypeId: string,
    displayNameOverride?: string
  ): Promise<{
    account: ImportWalletResult['accounts'][0];
    holdings: ImportWalletResult['holdings'];
  }> {
    // Find or create institution for this chain
    const institution = await this.findOrCreateInstitution(wallet.chainName);

    // Generate account name
    const accountName = this.generateAccountName(
      wallet.chainName,
      displayNameOverride || wallet.displayName || wallet.address
    );

    // Check if account already exists for this chain and address
    const existingAccounts = await db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, userId),
          eq(schema.accounts.institutionId, institution.id),
          eq(schema.accounts.name, accountName)
        )
      )
      .limit(1);

    let accountId: string;
    if (existingAccounts.length > 0 && existingAccounts[0]) {
      // Update existing account metadata
      accountId = existingAccounts[0].id;
      await db
        .update(schema.accounts)
        .set({
          metadata: {
            walletAddress: wallet.address,
            chainId: wallet.chainId,
            chainName: wallet.chainName,
            displayName: wallet.displayName,
            lastSync: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.accounts.id, accountId));
    } else {
      // Create new account
      const [newAccount] = await db
        .insert(schema.accounts)
        .values({
          userId,
          institutionId: institution.id,
          name: accountName,
          typeId: walletAccountTypeId,
          description: `Crypto wallet on ${wallet.chainName}`,
          metadata: {
            walletAddress: wallet.address,
            chainId: wallet.chainId,
            chainName: wallet.chainName,
            displayName: wallet.displayName,
            lastSync: new Date().toISOString(),
          },
          isActive: true,
        })
        .returning();

      if (!newAccount) {
        throw new Error('Failed to create account');
      }

      accountId = newAccount.id;
    }

    // Create holdings for each token
    const holdings: ImportWalletResult['holdings'] = [];

    for (const tokenBalance of wallet.balances) {
      try {
        // Skip tokens with missing required data
        if (!tokenBalance.symbol || !tokenBalance.balance || !tokenBalance.name) {
          logger.warn(
            {
              chainName: wallet.chainName,
              tokenBalance,
            },
            'Skipping token balance with missing required fields (symbol, name, or balance)'
          );
          continue;
        }

        // Find or create token
        const token = await this.findOrCreateToken(
          tokenBalance,
          cryptoTokenTypeId,
          wallet.chainName
        );

        // Check if holding already exists (including hidden ones)
        const existingHolding = await this.holdingRepository.findByAccountAndToken(
          accountId,
          token.id,
          userId,
          undefined,
          undefined,
          true // Include hidden holdings
        );

        if (existingHolding) {
          // Update existing holding and unhide if it was hidden
          await db
            .update(schema.holdings)
            .set({
              balance: tokenBalance.balance,
              isHidden: false, // Unhide if balance is non-zero
              lastUpdated: new Date(),
            })
            .where(eq(schema.holdings.id, existingHolding.id));

          holdings.push({
            id: existingHolding.id,
            accountId,
            tokenSymbol: token.symbol,
            tokenName: token.name,
            balance: tokenBalance.balance,
          });
        } else {
          // Create new holding with blockchain source
          const [newHolding] = await db
            .insert(schema.holdings)
            .values({
              userId,
              accountId,
              tokenId: token.id,
              balance: tokenBalance.balance,
              source: 'blockchain', // Mark as blockchain-sourced
              isHidden: false,
              lastUpdated: new Date(),
            })
            .returning();

          if (!newHolding) {
            throw new Error('Failed to create holding');
          }

          holdings.push({
            id: newHolding.id,
            accountId,
            tokenSymbol: token.symbol,
            tokenName: token.name,
            balance: tokenBalance.balance,
          });
        }

        // Try to fetch current price (non-blocking)
        if (baseCurrencyId) {
          try {
            await this.pricingService.getTokenPrice(token, baseCurrencyId, new Date());
          } catch (error) {
            logger.debug(
              {
                tokenSymbol: token.symbol,
                error: error instanceof Error ? error.message : String(error),
              },
              'Failed to fetch token price (non-critical)'
            );
          }
        }
      } catch (error) {
        logger.error(
          {
            tokenSymbol: tokenBalance?.symbol || 'unknown',
            tokenName: tokenBalance?.name || 'unknown',
            balance: tokenBalance?.balance || 'unknown',
            tokenAddress: tokenBalance?.tokenAddress || 'unknown',
            chainName: wallet.chainName,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to create holding for token'
        );
        // Continue with other tokens even if one fails
      }
    }

    return {
      account: {
        id: accountId,
        name: accountName,
        chainId: wallet.chainId,
        chainName: wallet.chainName,
        institutionId: institution.id,
        institutionName: institution.name,
      },
      holdings,
    };
  }

  /**
   * Find or create institution for a blockchain
   */
  private async findOrCreateInstitution(
    chainName: string
  ): Promise<typeof schema.institutions.$inferSelect> {
    // Try to find existing institution by name
    const [existing] = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.name, chainName))
      .limit(1);

    if (existing) {
      return existing;
    }

    // Get crypto_wallet institution type
    const [walletType] = await db
      .select()
      .from(schema.institutionTypes)
      .where(eq(schema.institutionTypes.code, 'crypto_wallet'))
      .limit(1);

    if (!walletType) {
      throw new Error('Institution type "crypto_wallet" not found');
    }

    // Create new institution
    const [newInstitution] = await db
      .insert(schema.institutions)
      .values({
        name: chainName,
        typeId: walletType.id,
        description: `${chainName} blockchain`,
        isActive: true,
      })
      .returning();

    if (!newInstitution) {
      throw new Error('Failed to create institution');
    }

    return newInstitution;
  }

  /**
   * Find or create token
   */
  private async findOrCreateToken(
    tokenBalance: WalletInfo['balances'][0],
    cryptoTokenTypeId: string,
    chainName: string
  ): Promise<typeof schema.tokens.$inferSelect> {
    // Validate required fields
    if (!tokenBalance.symbol || !tokenBalance.name) {
      throw new Error('Token balance missing required fields: symbol or name');
    }

    // Try to find existing token by symbol and type
    const existing = await this.tokenRepository.findBySymbolAndType(
      tokenBalance.symbol,
      cryptoTokenTypeId
    );

    if (existing) {
      // Update metadata if we have new information
      if (tokenBalance.iconUrl || tokenBalance.coinGeckoId) {
        const metadata = JSON.parse(existing.providerMetadata || '{}');
        const updated = {
          ...metadata,
          ...(tokenBalance.iconUrl && { iconUrl: tokenBalance.iconUrl }),
          ...(tokenBalance.coinGeckoId && { coinGeckoId: tokenBalance.coinGeckoId }),
          ...(tokenBalance.metadata && { chainMetadata: tokenBalance.metadata }),
        };

        await db
          .update(schema.tokens)
          .set({
            providerMetadata: JSON.stringify(updated),
            updatedAt: new Date(),
          })
          .where(eq(schema.tokens.id, existing.id));
      }
      return existing;
    }

    // Create new token
    const [newToken] = await db
      .insert(schema.tokens)
      .values({
        symbol: tokenBalance.symbol.toUpperCase(),
        name: tokenBalance.name,
        typeId: cryptoTokenTypeId,
        decimals: tokenBalance.decimals,
        iconUrl: tokenBalance.iconUrl || null,
        providerMetadata: JSON.stringify({
          isNative: tokenBalance.isNative,
          tokenAddress: tokenBalance.tokenAddress,
          chain: chainName,
          ...(tokenBalance.coinGeckoId && { coinGeckoId: tokenBalance.coinGeckoId }),
          ...(tokenBalance.metadata && { chainMetadata: tokenBalance.metadata }),
        }),
        isActive: true,
      })
      .returning();

    if (!newToken) {
      throw new Error('Failed to create token');
    }

    return newToken;
  }

  /**
   * Generate account name from chain and display name
   */
  private generateAccountName(chainName: string, displayName: string): string {
    // If display name is a hex address (0x...), Bitcoin address, Tron address (T...),
    // or Solana address, shorten it
    const isEthereumAddress = /^0x[0-9a-fA-F]{40}$/.test(displayName);
    const isTronAddress = /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(displayName);
    const isBitcoinAddress =
      /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(displayName) || // Bitcoin P2PKH/P2SH
      /^bc1[a-z0-9]{39,59}$/.test(displayName); // Bitcoin Bech32
    const isSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(displayName);

    const isAddress = isEthereumAddress || isTronAddress || isBitcoinAddress || isSolanaAddress;

    if (isAddress && displayName.length > 20) {
      const shortened = `${displayName.substring(0, 6)}...${displayName.substring(displayName.length - 4)}`;
      return `${chainName} - ${shortened}`;
    }

    return `${chainName} - ${displayName}`;
  }
}
