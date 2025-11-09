/**
 * SyncWalletBalancesUseCase
 *
 * Synchronizes wallet balances from blockchain for all accounts imported via blockchain services.
 * This use case is designed to be called by scheduled cron jobs.
 *
 * Responsibilities:
 * - Find all accounts with wallet addresses (blockchain imports)
 * - Fetch current balances from blockchain for each wallet
 * - Update existing holdings with new balances (preserving hidden state)
 * - Update holdings when balance goes to zero (keeping them for future syncs)
 * - Create new holdings when wallet owns new tokens
 * - Respect rate limits of blockchain APIs
 * - NOTE: Token prices are NOT fetched during sync to improve performance
 *
 * Note: Hidden holdings are updated with new balances but remain hidden.
 * This preserves user intent when they explicitly hide a holding.
 */

import { IntegrationManager } from '@scani/integrations';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { BlockchainServiceManager } from '../external-services/blockchain';
import type { WalletInfo } from '../external-services/blockchain/types';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import { InstitutionBlockchainMappingRepository } from '../repositories/InstitutionBlockchainMappingRepository';
import { AccountService } from '../services/AccountService';
import { HoldingService } from '../services/HoldingService';
import { TokenService } from '../services/TokenService';
import { UserWalletService } from '../services/UserWalletService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:sync-wallet-balances');

export interface SyncWalletBalancesResult {
  /** Total number of wallet accounts found */
  accountsFound: number;
  /** Number of accounts successfully synced */
  accountsSynced: number;
  /** Number of accounts that failed to sync */
  accountsFailed: number;
  /** Total holdings updated */
  holdingsUpdated: number;
  /** Total holdings created */
  holdingsCreated: number;
  /** Total holdings removed (balance = 0) */
  holdingsRemoved: number;
  /** Errors encountered during sync */
  errors: Array<{
    accountId: string;
    accountName: string;
    walletAddress: string;
    error: string;
  }>;
  /** Duration of the operation in milliseconds */
  durationMs: number;
}

/**
 * Sync Wallet Balances Use Case
 */
@Service()
export class SyncWalletBalancesUseCase {
  private readonly blockchainService = Container.get(BlockchainServiceManager);
  private readonly integrationManager = Container.get(IntegrationManager);
  private readonly userWalletService = Container.get(UserWalletService);
  private readonly mappingRepository = Container.get(InstitutionBlockchainMappingRepository);
  private readonly accountService = Container.get(AccountService);
  private readonly holdingService = Container.get(HoldingService);
  private readonly tokenService = Container.get(TokenService);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);

  async execute(): Promise<SyncWalletBalancesResult> {
    const startTime = Date.now();
    logger.info('Starting wallet balance sync for all blockchain accounts');

    const errors: SyncWalletBalancesResult['errors'] = [];
    let accountsSynced = 0;
    let accountsFailed = 0;
    let holdingsUpdated = 0;
    let holdingsCreated = 0;
    let holdingsRemoved = 0;

    try {
      // Get crypto token type
      const cryptoTokenType = await this.tokenTypeRepository.findByCode('crypto');

      if (!cryptoTokenType) {
        throw new Error('Token type "crypto" not found');
      }

      // Check if we have any mappings (new system)
      const hasAnyMappings = (await this.mappingRepository.findAllActive()).length > 0;

      if (hasAnyMappings) {
        // Sync new user_wallets format
        logger.debug('Syncing wallets from user_wallets table');
        const newResult = await this.syncUserWallets(cryptoTokenType.id);

        accountsSynced += newResult.accountsSynced;
        accountsFailed += newResult.accountsFailed;
        holdingsUpdated += newResult.holdingsUpdated;
        holdingsCreated += newResult.holdingsCreated;
        holdingsRemoved += newResult.holdingsRemoved;
        errors.push(...newResult.errors);
      }

      // Sync old accounts format (backward compatibility)
      // Find accounts that are NOT migrated (don't have metadata.migrated flag)
      logger.debug('Syncing legacy wallet accounts');
      const legacyResult = await this.syncLegacyAccounts(cryptoTokenType.id);

      accountsSynced += legacyResult.accountsSynced;
      accountsFailed += legacyResult.accountsFailed;
      holdingsUpdated += legacyResult.holdingsUpdated;
      holdingsCreated += legacyResult.holdingsCreated;
      holdingsRemoved += legacyResult.holdingsRemoved;
      errors.push(...legacyResult.errors);

      const totalAccountsFound = accountsSynced + accountsFailed;
      const durationMs = Date.now() - startTime;

      logger.info(
        {
          accountsFound: totalAccountsFound,
          accountsSynced,
          accountsFailed,
          holdingsUpdated,
          holdingsCreated,
          holdingsRemoved,
          durationMs,
        },
        'Wallet balance sync completed'
      );

      return {
        accountsFound: totalAccountsFound,
        accountsSynced,
        accountsFailed,
        holdingsUpdated,
        holdingsCreated,
        holdingsRemoved,
        errors,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          durationMs,
        },
        'Failed to sync wallet balances'
      );

      throw error;
    }
  }

  /**
   * Sync wallets from user_wallets table (new format)
   */
  private async syncUserWallets(cryptoTokenTypeId: string): Promise<{
    accountsSynced: number;
    accountsFailed: number;
    holdingsUpdated: number;
    holdingsCreated: number;
    holdingsRemoved: number;
    errors: SyncWalletBalancesResult['errors'];
  }> {
    const errors: SyncWalletBalancesResult['errors'] = [];
    let accountsSynced = 0;
    let accountsFailed = 0;
    let holdingsUpdated = 0;
    let holdingsCreated = 0;
    let holdingsRemoved = 0;

    // Get all users
    const users = await db.select().from(schema.users);

    for (const user of users) {
      // Get user's wallets
      const userWallets = await this.userWalletService.getUserWallets(user.id);

      for (const userWallet of userWallets) {
        const institutionIds = (userWallet.institutionIds as string[]) || [];

        // Process each institution for this wallet
        for (const institutionId of institutionIds) {
          try {
            const integration = await this.integrationManager.getIntegration(institutionId);

            if (!integration) {
              logger.warn(
                { institutionId, walletAddress: userWallet.walletAddress },
                'Integration not found for institution'
              );
              continue;
            }

            // Get institution
            const [institution] = await db
              .select()
              .from(schema.institutions)
              .where(eq(schema.institutions.id, institutionId))
              .limit(1);

            if (!institution) {
              continue;
            }

            // Find the account for this wallet and institution
            const accounts = await db
              .select()
              .from(schema.accounts)
              .where(
                and(
                  eq(schema.accounts.userId, user.id),
                  eq(schema.accounts.institutionId, institutionId)
                )
              );

            // Filter accounts that have this userWalletId in metadata
            const account = accounts.find((acc) => {
              const metadata = acc.metadata as Record<string, unknown>;
              return metadata?.userWalletId === userWallet.id;
            });

            if (!account) {
              logger.warn(
                { userWalletId: userWallet.id, institutionId },
                'Account not found for user wallet and institution'
              );
              continue;
            }

            logger.debug(
              {
                accountId: account.id,
                walletAddress: userWallet.walletAddress,
                institutionId,
              },
              'Syncing wallet with integration'
            );

            // Fetch holdings from integration
            const holdingsResult = await integration.fetchHoldings(userWallet.walletAddress);

            if (holdingsResult.errors && holdingsResult.errors.length > 0) {
              logger.warn(
                { accountId: account.id, errors: holdingsResult.errors },
                'Errors fetching holdings from integration'
              );
              errors.push({
                accountId: account.id,
                accountName: account.name,
                walletAddress: userWallet.walletAddress,
                error: holdingsResult.errors.join('; '),
              });
              accountsFailed++;
              continue;
            }

            // Get existing holdings for this account
            const existingHoldings = await this.holdingService.findByAccount(
              account.id,
              undefined,
              true
            );

            // Batch fetch all tokens for existing holdings
            const existingTokenIds = existingHoldings.map((h) => h.tokenId);
            const existingTokens = await this.tokenService.getTokensByIds(existingTokenIds);
            const tokensMap = new Map(existingTokens.map((t) => [t.id, t]));

            // Create a map of existing holdings by token symbol
            const existingHoldingsMap = new Map<string, (typeof existingHoldings)[0]>();
            for (const holding of existingHoldings) {
              const token = tokensMap.get(holding.tokenId);
              if (token) {
                existingHoldingsMap.set(token.symbol.toUpperCase(), holding);
              }
            }

            // Process each integration holding
            for (const integrationHolding of holdingsResult.holdings) {
              try {
                // Skip tokens with missing required data
                if (!integrationHolding.symbol || !integrationHolding.balance) {
                  logger.warn(
                    {
                      accountId: account.id,
                      holding: integrationHolding,
                    },
                    'Skipping integration holding with missing symbol or balance'
                  );
                  continue;
                }

                const tokenSymbol = integrationHolding.symbol.toUpperCase();
                const balance = integrationHolding.balance;

                // Map the integration holding to our token format
                const tokenMapping = await integration.mapToken(integrationHolding);

                // Find or create token using service method
                const token = await this.tokenService.findOrCreateTokenFromIntegration(
                  tokenMapping,
                  cryptoTokenTypeId
                );

                const existingHolding = existingHoldingsMap.get(tokenSymbol);
                const wasHidden = existingHolding?.isHidden ?? false;

                if (balance === '0' || parseFloat(balance) === 0) {
                  // For zero balance, update existing holding if it exists
                  if (existingHolding) {
                    await this.holdingService.updateHoldingBalance(existingHolding.id, balance);
                    if (!wasHidden) {
                      holdingsRemoved++;
                    }
                    logger.debug(
                      {
                        accountId: account.id,
                        tokenSymbol,
                        holdingId: existingHolding.id,
                      },
                      'Updated holding with zero balance'
                    );
                  }
                } else {
                  // Update or create holding with non-zero balance
                  if (existingHolding) {
                    await this.holdingService.updateHoldingBalance(existingHolding.id, balance);
                    if (!wasHidden) {
                      holdingsUpdated++;
                    }
                    logger.debug(
                      {
                        accountId: account.id,
                        tokenSymbol,
                        holdingId: existingHolding.id,
                        balance,
                      },
                      'Updated holding balance'
                    );
                  } else {
                    // Create new holding
                    const [newHolding] = await db
                      .insert(schema.holdings)
                      .values({
                        userId: user.id,
                        accountId: account.id,
                        tokenId: token.id,
                        balance,
                        source: 'blockchain',
                        isHidden: false,
                        lastUpdated: new Date(),
                      })
                      .returning();

                    if (newHolding) {
                      holdingsCreated++;
                      logger.debug(
                        {
                          accountId: account.id,
                          tokenSymbol,
                          holdingId: newHolding.id,
                          balance,
                        },
                        'Created new holding'
                      );
                    }
                  }

                  // NOTE: Removed price fetching during sync to speed up the process
                  // Prices will be fetched on-demand when user views their portfolio
                }
              } catch (error) {
                logger.error(
                  {
                    accountId: account.id,
                    tokenSymbol: integrationHolding?.symbol || 'unknown',
                    tokenName: integrationHolding?.name || 'unknown',
                    balance: integrationHolding?.balance || 'unknown',
                    error: error instanceof Error ? error.message : String(error),
                  },
                  'Failed to process integration holding'
                );
              }
            }

            // Update account metadata with last sync time
            const metadata = account.metadata as Record<string, unknown>;
            await this.accountService.updateAccountMetadata(account.id, {
              ...metadata,
              lastSync: new Date().toISOString(),
            });

            accountsSynced++;
          } catch (error) {
            accountsFailed++;
            const errorMessage = error instanceof Error ? error.message : String(error);
            errors.push({
              accountId: 'unknown',
              accountName: `${userWallet.walletAddress.substring(0, 10)}...`,
              walletAddress: userWallet.walletAddress,
              error: errorMessage,
            });
            logger.error(
              {
                userWalletId: userWallet.id,
                institutionId,
                error: errorMessage,
              },
              'Failed to sync user wallet'
            );
          }
        }
      }
    }

    return {
      accountsSynced,
      accountsFailed,
      holdingsUpdated,
      holdingsCreated,
      holdingsRemoved,
      errors,
    };
  }

  /**
   * Sync legacy accounts (old format without migration flag)
   */
  private async syncLegacyAccounts(cryptoTokenTypeId: string): Promise<{
    accountsSynced: number;
    accountsFailed: number;
    holdingsUpdated: number;
    holdingsCreated: number;
    holdingsRemoved: number;
    errors: SyncWalletBalancesResult['errors'];
  }> {
    const errors: SyncWalletBalancesResult['errors'] = [];
    let accountsSynced = 0;
    let accountsFailed = 0;
    let holdingsUpdated = 0;
    let holdingsCreated = 0;
    let holdingsRemoved = 0;

    // Find all wallet accounts that are NOT migrated
    const walletAccounts = await this.accountService.findWalletAccounts();

    // Filter to only non-migrated accounts
    const nonMigratedAccounts = walletAccounts.filter((account) => {
      const metadata = account.metadata as Record<string, unknown>;
      return !metadata?.migrated;
    });

    if (nonMigratedAccounts.length === 0) {
      logger.info('No legacy wallet accounts found');
      return {
        accountsSynced: 0,
        accountsFailed: 0,
        holdingsUpdated: 0,
        holdingsCreated: 0,
        holdingsRemoved: 0,
        errors: [],
      };
    }

    logger.info(
      {
        accountCount: nonMigratedAccounts.length,
      },
      'Found legacy wallet accounts to sync'
    );

    // Process each legacy wallet account
    for (const account of nonMigratedAccounts) {
      const metadata = account.metadata as Record<string, unknown>;
      const walletAddress = metadata.walletAddress as string;
      const chainName = metadata.chainName as string | undefined;

      if (!walletAddress) {
        logger.warn(
          {
            accountId: account.id,
            accountName: account.name,
          },
          'Account has no wallet address in metadata'
        );
        continue;
      }

      try {
        logger.debug(
          {
            accountId: account.id,
            accountName: account.name,
            walletAddress: `${walletAddress.substring(0, 10)}...`,
            chainName,
          },
          'Syncing legacy wallet balances'
        );

        // Fetch wallet balances from blockchain using legacy service
        const walletResult = await this.blockchainService.importWalletAddress(walletAddress);

        if (walletResult.wallets.length === 0) {
          logger.warn(
            {
              accountId: account.id,
              walletAddress: `${walletAddress.substring(0, 10)}...`,
            },
            'No wallet data returned from blockchain'
          );
          accountsFailed++;
          errors.push({
            accountId: account.id,
            accountName: account.name,
            walletAddress,
            error: 'No wallet data returned from blockchain',
          });
          continue;
        }

        // Find the wallet for this specific chain
        let walletInfo: WalletInfo | undefined;
        if (chainName) {
          walletInfo = walletResult.wallets.find((w) => w.chainName === chainName);
        } else {
          walletInfo = walletResult.wallets[0];
        }

        if (!walletInfo) {
          logger.warn(
            {
              accountId: account.id,
              walletAddress: `${walletAddress.substring(0, 10)}...`,
              chainName,
            },
            'Wallet not found for specified chain'
          );
          accountsFailed++;
          errors.push({
            accountId: account.id,
            accountName: account.name,
            walletAddress,
            error: `Wallet not found for chain: ${chainName}`,
          });
          continue;
        }

        // Get existing holdings for this account using service (include hidden ones)
        const existingHoldings = await this.holdingService.findByAccount(
          account.id,
          undefined,
          true
        );

        // Batch fetch all tokens for existing holdings
        const existingTokenIds = existingHoldings.map((h) => h.tokenId);
        const existingTokens = await this.tokenService.getTokensByIds(existingTokenIds);
        const tokensMap = new Map(existingTokens.map((t) => [t.id, t]));

        // Create a map of existing holdings by token symbol
        const existingHoldingsMap = new Map<string, (typeof existingHoldings)[0]>();
        for (const holding of existingHoldings) {
          const token = tokensMap.get(holding.tokenId);
          if (token) {
            existingHoldingsMap.set(token.symbol.toUpperCase(), holding);
          }
        }

        // Process each token balance from blockchain
        for (const tokenBalance of walletInfo.balances) {
          try {
            // Skip tokens with missing required data
            if (!tokenBalance.symbol || !tokenBalance.balance || !tokenBalance.name) {
              logger.warn(
                {
                  accountId: account.id,
                  tokenBalance,
                },
                'Skipping token balance with missing required fields (symbol, name, or balance)'
              );
              continue;
            }

            const tokenSymbol = tokenBalance.symbol.toUpperCase();
            const balance = tokenBalance.balance;

            // Find or create token using service
            const token = await this.tokenService.findOrCreateTokenFromBlockchain({
              symbol: tokenSymbol,
              name: tokenBalance.name,
              decimals: tokenBalance.decimals,
              typeId: cryptoTokenTypeId,
              iconUrl: tokenBalance.iconUrl,
              isNative: tokenBalance.isNative,
              tokenAddress: tokenBalance.tokenAddress,
              chainName: walletInfo.chainName,
              coinGeckoId: tokenBalance.coinGeckoId,
              metadata: tokenBalance.metadata,
            });

            const existingHolding = existingHoldingsMap.get(tokenSymbol);
            const wasHidden = existingHolding?.isHidden ?? false;

            if (balance === '0' || parseFloat(balance) === 0) {
              // For blockchain holdings with zero balance:
              // - Keep the holding for future syncs (balance may increase later)
              // - Preserve hidden state (if user hid it, keep it hidden)
              // - Update the balance to reflect current state
              if (existingHolding) {
                await this.holdingService.updateHoldingBalance(existingHolding.id, balance);
                // Only count as removed if it wasn't already hidden
                if (!wasHidden) {
                  holdingsRemoved++;
                }
                logger.debug(
                  {
                    accountId: account.id,
                    tokenSymbol,
                    holdingId: existingHolding.id,
                    isHidden: wasHidden,
                  },
                  'Updated holding with zero balance (preserving hidden state)'
                );
              }
            } else {
              // Update or create holding with non-zero balance
              if (existingHolding) {
                // Update existing holding using service
                // Keep the hidden state as-is (user may have intentionally hidden it)
                await this.holdingService.updateHoldingBalance(existingHolding.id, balance);

                // Only count as updated if it wasn't hidden
                if (!wasHidden) {
                  holdingsUpdated++;
                }
                logger.debug(
                  {
                    accountId: account.id,
                    tokenSymbol,
                    holdingId: existingHolding.id,
                    balance,
                    isHidden: wasHidden,
                  },
                  'Updated holding balance (preserving hidden state)'
                );
              } else {
                // Create new holding with blockchain source
                const [newHolding] = await db
                  .insert(schema.holdings)
                  .values({
                    userId: account.userId,
                    accountId: account.id,
                    tokenId: token.id,
                    balance,
                    source: 'blockchain',
                    isHidden: wasHidden, // Preserve any previous hidden state
                    lastUpdated: new Date(),
                  })
                  .returning();

                if (!newHolding) {
                  throw new Error('Failed to create holding');
                }

                holdingsCreated++;
                logger.debug(
                  {
                    accountId: account.id,
                    tokenSymbol,
                    holdingId: newHolding.id,
                    balance,
                  },
                  'Created new holding'
                );
              }

              // NOTE: Removed price fetching during sync to speed up the process
              // Prices will be fetched on-demand when user views their portfolio
            }
          } catch (error) {
            logger.error(
              {
                accountId: account.id,
                tokenSymbol: tokenBalance?.symbol || 'unknown',
                tokenName: tokenBalance?.name || 'unknown',
                balance: tokenBalance?.balance || 'unknown',
                tokenAddress: tokenBalance?.tokenAddress || 'unknown',
                error: error instanceof Error ? error.message : String(error),
              },
              'Failed to process token balance'
            );
            // Continue with other tokens even if one fails
          }
        }

        // Update account metadata with last sync time using service
        const updatedMetadata = {
          ...metadata,
          lastSync: new Date().toISOString(),
        };
        await this.accountService.updateAccountMetadata(account.id, updatedMetadata);

        accountsSynced++;
      } catch (error) {
        accountsFailed++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push({
          accountId: account.id,
          accountName: account.name,
          walletAddress,
          error: errorMessage,
        });
        logger.error(
          {
            accountId: account.id,
            accountName: account.name,
            walletAddress: `${walletAddress.substring(0, 10)}...`,
            error: errorMessage,
          },
          'Failed to sync legacy wallet balances'
        );
      }
    }

    return {
      accountsSynced,
      accountsFailed,
      holdingsUpdated,
      holdingsCreated,
      holdingsRemoved,
      errors,
    };
  }
}
