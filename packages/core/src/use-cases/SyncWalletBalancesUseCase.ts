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

import type { FetchHoldingsResult } from '@scani/integrations';
import { IntegrationManager } from '@scani/integrations';
import { isValidDecimalString } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { withTransaction } from '../database/transaction';
import type { Account, Institution, User, UserWallet } from '../domain/entities';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
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
  private readonly integrationManager = Container.get(IntegrationManager);
  private readonly userWalletService = Container.get(UserWalletService);
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

      // Sync wallets from user_wallets table
      logger.debug('Syncing wallets from user_wallets table');
      const result = await this.syncUserWallets(cryptoTokenType.id);

      accountsSynced += result.accountsSynced;
      accountsFailed += result.accountsFailed;
      holdingsUpdated += result.holdingsUpdated;
      holdingsCreated += result.holdingsCreated;
      holdingsRemoved += result.holdingsRemoved;
      errors.push(...result.errors);

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

    // STEP 1: Get all users and their wallets (quick database query)
    const users = await db.select().from(schema.users);

    // STEP 2: Fetch ALL blockchain data first (external API calls, no DB connection held)
    // This is critical for preventing connection exhaustion during slow blockchain API calls
    const walletDataToSync: Array<{
      user: User;
      userWallet: UserWallet;
      institutionId: string;
      institution: Institution;
      account: Account;
      holdingsResult: FetchHoldingsResult;
    }> = [];

    for (const user of users) {
      // Get user's wallets
      const userWallets = await this.userWalletService.getUserWallets(user.id);

      for (const userWallet of userWallets) {
        let institutionIds = (userWallet.institutionIds as string[]) || [];

        // Periodic chain re-detection: check for new chains every 24 hours
        // This discovers activity on chains added after initial import
        const lastDetection = (userWallet as Record<string, unknown>).updatedAt as Date | undefined;
        const hoursSinceDetection = lastDetection
          ? (Date.now() - new Date(lastDetection).getTime()) / (1000 * 60 * 60)
          : 999;

        if (hoursSinceDetection >= 24 && userWallet.walletAddress) {
          try {
            const newChains = await this.integrationManager.detectWalletChains(
              userWallet.walletAddress
            );
            const merged = Array.from(new Set([...institutionIds, ...newChains]));
            if (merged.length > institutionIds.length) {
              logger.info(
                {
                  walletAddress: userWallet.walletAddress.substring(0, 10),
                  oldChains: institutionIds.length,
                  newChains: merged.length,
                },
                'Discovered new chains for wallet'
              );
              await this.userWalletService.updateWallet(userWallet.id, {
                institutionIds: merged,
              });
              institutionIds = merged;
            }
          } catch (error) {
            logger.warn(
              { walletAddress: userWallet.walletAddress.substring(0, 10), error },
              'Chain re-detection failed, using existing chains'
            );
          }
        }

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
              // Auto-create account for newly detected chain
              try {
                const walletAccountType = await db
                  .select()
                  .from(schema.accountTypes)
                  .where(eq(schema.accountTypes.code, 'crypto'))
                  .limit(1);

                if (walletAccountType.length > 0) {
                  const addrShort = userWallet.walletAddress.substring(0, 8);
                  const [newAccount] = await db
                    .insert(schema.accounts)
                    .values({
                      userId: user.id,
                      institutionId,
                      name: `${institution.name} - ${addrShort}`,
                      typeId: walletAccountType[0]!.id,
                      description: `Crypto wallet on ${institution.name}`,
                      metadata: {
                        walletAddress: userWallet.walletAddress,
                        chainName: institution.name,
                        userWalletId: userWallet.id,
                        lastSync: null,
                      },
                      isActive: true,
                    })
                    .returning();

                  if (newAccount) {
                    logger.info(
                      { accountId: newAccount.id, chain: institution.name },
                      'Auto-created account for newly detected chain'
                    );
                    // Use the newly created account — assign to a mutable variable
                    // and fall through to the fetch logic below
                    Object.assign(accounts, [newAccount]);
                  }
                }
              } catch (createErr) {
                logger.warn(
                  { userWalletId: userWallet.id, institutionId, error: createErr },
                  'Failed to auto-create account for chain'
                );
                continue;
              }
            }

            // Re-find account (may have been just created)
            const syncAccount =
              account ||
              accounts.find((acc) => {
                const md = acc.metadata as Record<string, unknown>;
                return md?.userWalletId === userWallet.id;
              });

            if (!syncAccount) {
              continue;
            }

            logger.debug(
              {
                accountId: syncAccount.id,
                walletAddress: userWallet.walletAddress,
                institutionId,
              },
              'Fetching wallet holdings from blockchain'
            );

            // EXTERNAL API CALL - Fetch holdings from blockchain (no DB connection held)
            const holdingsResult = await integration.fetchHoldings(userWallet.walletAddress);

            if (holdingsResult.errors && holdingsResult.errors.length > 0) {
              logger.warn(
                { accountId: syncAccount.id, errors: holdingsResult.errors },
                'Errors fetching holdings from integration'
              );
              errors.push({
                accountId: syncAccount.id,
                accountName: syncAccount.name,
                walletAddress: userWallet.walletAddress,
                error: holdingsResult.errors.join('; '),
              });
              accountsFailed++;
              continue;
            }

            // Store the data for batch processing
            walletDataToSync.push({
              user,
              userWallet,
              institutionId,
              institution,
              account: syncAccount,
              holdingsResult,
            });
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
              'Failed to fetch wallet data'
            );
          }
        }
      }
    }

    // STEP 3: Process ALL updates in a SINGLE TRANSACTION
    // This dramatically reduces connection usage from N*M operations to 1 transaction
    await withTransaction(
      async (tx) => {
        for (const walletData of walletDataToSync) {
          try {
            const { user, institutionId, account, holdingsResult } = walletData;

            const integration = await this.integrationManager.getIntegration(institutionId);
            if (!integration) {
              continue;
            }

            // Get existing holdings for this account (within transaction)
            // IMPORTANT: Include scam tokens to avoid creating duplicates during sync
            // The scam filter is only for display purposes, not for sync operations
            const existingHoldings = await this.holdingService.findByAccount(
              account.id,
              tx,
              true, // includeHidden
              true // includeScamTokens - prevents duplicate holdings for scam tokens
            );

            // Create a map of existing holdings by externalId (or tokenId for legacy holdings without externalId)
            // This allows multiple holdings of the same token if they have different externalIds
            const existingHoldingsMap = new Map<string, (typeof existingHoldings)[0]>();
            for (const holding of existingHoldings) {
              const key = holding.externalId
                ? `${holding.tokenId}:${holding.externalId}`
                : holding.tokenId;
              existingHoldingsMap.set(key, holding);
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

                // Validate balance is a valid decimal string
                if (!isValidDecimalString(balance)) {
                  logger.warn(
                    {
                      accountId: account.id,
                      tokenSymbol,
                      balance,
                    },
                    'Skipping integration holding with invalid balance format'
                  );
                  continue;
                }

                // Map the integration holding to our token format
                const tokenMapping = await integration.mapToken(integrationHolding);

                // Find or create token using blockchain-specific integration mapping method (within transaction)
                const token = await this.tokenService.findOrCreateTokenFromIntegrationMapping(
                  tokenMapping,
                  cryptoTokenTypeId,
                  18,
                  tx
                );

                // Build externalId for blockchain holdings: contract address or symbol
                const walletExternalId =
                  integrationHolding.contractAddress ||
                  integrationHolding.externalTokenId ||
                  integrationHolding.symbol;
                // Look up by externalId first, fall back to tokenId for legacy holdings
                const mapKey = `${token.id}:${walletExternalId}`;
                const existingHolding =
                  existingHoldingsMap.get(mapKey) || existingHoldingsMap.get(token.id);
                const wasHidden = existingHolding?.isHidden ?? false;

                // Event context - only create events if user has baseCurrencyId
                const eventContext = user.baseCurrencyId
                  ? {
                      userId: user.id,
                      baseCurrencyId: user.baseCurrencyId,
                      // Price will be fetched on-demand, use "0" for sync
                    }
                  : undefined;

                if (balance === '0' || parseFloat(balance) === 0) {
                  // For zero balance, update existing holding if it exists
                  if (existingHolding) {
                    if (eventContext) {
                      await this.holdingService.updateHoldingBalanceWithEvent(
                        {
                          holdingId: existingHolding.id,
                          balance,
                          eventContext,
                        },
                        tx
                      );
                    } else {
                      await this.holdingService.updateHoldingBalance(
                        existingHolding.id,
                        balance,
                        tx
                      );
                    }
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
                    if (eventContext) {
                      await this.holdingService.updateHoldingBalanceWithEvent(
                        {
                          holdingId: existingHolding.id,
                          balance,
                          eventContext,
                        },
                        tx
                      );
                    } else {
                      await this.holdingService.updateHoldingBalance(
                        existingHolding.id,
                        balance,
                        tx
                      );
                    }
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
                    // Create new holding via HoldingService with externalId for sync matching
                    const newHolding = await this.holdingService.createHoldingWithEvent(
                      {
                        userId: user.id,
                        accountId: account.id,
                        tokenId: token.id,
                        balance,
                        source: 'blockchain',
                        externalId: walletExternalId,
                        eventContext: eventContext
                          ? { baseCurrencyId: eventContext.baseCurrencyId }
                          : undefined,
                      },
                      tx
                    );

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

            // Update account metadata with last sync time (within transaction)
            const metadata = account.metadata as Record<string, unknown>;
            await this.accountService.updateAccountMetadata(
              account.id,
              {
                ...metadata,
                lastSync: new Date().toISOString(),
              },
              tx
            );

            accountsSynced++;
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(
              {
                accountId: walletData.account.id,
                walletAddress: walletData.userWallet.walletAddress,
                error: errorMessage,
              },
              'Failed to process wallet in transaction'
            );
          }
        }
      },
      {
        name: 'sync-wallet-balances',
        timeout: 120000, // 120s timeout for potentially large sync operations
      }
    );

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
