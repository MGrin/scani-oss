/**
 * SyncExchangeBalancesUseCase
 *
 * Synchronizes exchange account balances (Binance, Kraken, etc.) for all users.
 * This use case is designed to be called by scheduled cron jobs.
 *
 * Responsibilities:
 * - Find all accounts with exchange credentials (Binance, Kraken, etc.)
 * - Fetch current balances from exchanges for each account
 * - Update existing holdings with new balances (preserving hidden state)
 * - Create new holdings when account owns new tokens
 * - Update holdings when balance goes to zero (keeping them for future syncs)
 * - Respect rate limits of exchange APIs
 * - NOTE: Token prices are NOT fetched during sync to improve performance
 *
 * Note: Hidden holdings are updated with new balances but remain hidden.
 * This preserves user intent when they explicitly hide a holding.
 */

import type { FetchHoldingsResult, ScaniIntegration } from '@scani/integrations';
import { IntegrationManager } from '@scani/integrations';
import { isValidDecimalString } from '@scani/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { withTransaction } from '../database/transaction';
import type { Holding } from '../domain/entities';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import { HoldingRepository, type HoldingWithFullDetails } from '../repositories/HoldingRepository';
import { HoldingService } from '../services/HoldingService';
import { IntegrationCredentialsService } from '../services/IntegrationCredentialsService';
import { TokenService } from '../services/TokenService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:sync-exchange-balances');

export interface SyncExchangeBalancesResult {
  /** Total number of exchange accounts found */
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
    institutionId: string;
    error: string;
  }>;
  /** Duration of the operation in milliseconds */
  durationMs: number;
}

/**
 * Sync Exchange Balances Use Case
 */
@Service()
export class SyncExchangeBalancesUseCase {
  private readonly integrationManager = Container.get(IntegrationManager);
  private readonly integrationCredentialsService = Container.get(IntegrationCredentialsService);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly holdingService = Container.get(HoldingService);
  private readonly tokenService = Container.get(TokenService);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);

  async execute(): Promise<SyncExchangeBalancesResult> {
    const startTime = Date.now();
    logger.info('Starting exchange balance sync for all exchange accounts');

    const errors: SyncExchangeBalancesResult['errors'] = [];
    let accountsSynced = 0;
    let accountsFailed = 0;
    let holdingsUpdated = 0;
    let holdingsCreated = 0;
    let holdingsRemoved = 0;

    try {
      // STEP 1: Fetch ALL external data first (no DB connections held during API calls)

      // Get crypto token type
      const cryptoTokenType = await this.tokenTypeRepository.findByCode('crypto');

      if (!cryptoTokenType) {
        throw new Error('Token type "crypto" not found');
      }

      // Query database for exchange institutions
      const exchangeNames = ['Binance', 'Kraken'];
      logger.debug({ exchangeNames }, 'Looking for exchange institutions');

      const exchangeInstitutions = await db
        .select()
        .from(schema.institutions)
        .where(inArray(schema.institutions.name, exchangeNames));

      if (exchangeInstitutions.length === 0) {
        logger.warn({ exchangeNames }, 'No exchange institutions found in database');
        return {
          accountsFound: 0,
          accountsSynced: 0,
          accountsFailed: 0,
          holdingsUpdated: 0,
          holdingsCreated: 0,
          holdingsRemoved: 0,
          errors: [],
          durationMs: Date.now() - startTime,
        };
      }

      logger.debug(
        { institutionsFound: exchangeInstitutions.length },
        'Found exchange institutions in database'
      );

      // Structure to hold all fetched data
      interface AccountHoldingsData {
        account: {
          id: string;
          userId: string;
          institutionId: string;
          name: string | null;
          metadata: unknown;
        };
        userId: string;
        userBaseCurrencyId: string | null;
        institutionId: string;
        integration: ScaniIntegration;
        holdingsResult: FetchHoldingsResult;
        existingHoldingsWithDetails: HoldingWithFullDetails[];
      }

      const allAccountHoldingsData: AccountHoldingsData[] = [];

      // Fetch data for all institutions and accounts
      for (const institution of exchangeInstitutions) {
        try {
          const institutionId = institution.id;
          const institutionName = institution.name;

          logger.debug({ institutionId, institutionName }, 'Processing exchange institution');

          // Get integration
          let integration = await this.integrationManager.getIntegration(institutionId);

          if (!integration) {
            logger.debug(
              { institutionId, institutionName },
              'Integration not found by UUID, trying static name'
            );
            integration = await this.integrationManager.getIntegration(
              institutionName.toLowerCase()
            );
          }

          if (!integration) {
            logger.warn(
              { institutionId, institutionName },
              'Integration not found for institution, skipping'
            );
            continue;
          }

          // Find all users with credentials for this institution
          const credentials = await db
            .select()
            .from(schema.userIntegrationCredentials)
            .where(eq(schema.userIntegrationCredentials.institutionId, institutionId));

          if (credentials.length === 0) {
            logger.debug({ institutionId }, 'No credentials found for institution');
            continue;
          }

          logger.debug(
            { institutionId, credentialsCount: credentials.length },
            'Found credentials for institution'
          );

          // Sync accounts for each user
          for (const userCredential of credentials) {
            // Get user's accounts for this institution
            const accounts = await db
              .select()
              .from(schema.accounts)
              .where(
                and(
                  eq(schema.accounts.userId, userCredential.userId),
                  eq(schema.accounts.institutionId, institutionId),
                  eq(schema.accounts.isActive, true)
                )
              );

            if (accounts.length === 0) {
              logger.debug(
                { userId: userCredential.userId, institutionId },
                'No accounts found for user'
              );
              continue;
            }

            logger.debug(
              { userId: userCredential.userId, accountsCount: accounts.length },
              'Syncing accounts for user'
            );

            // Get decrypted credentials
            const decryptedCredentials =
              await this.integrationCredentialsService.getDecryptedCredentials(
                userCredential.userId,
                institutionId
              );

            if (!decryptedCredentials) {
              logger.warn(
                { userId: userCredential.userId, institutionId },
                'Failed to decrypt credentials'
              );
              continue;
            }

            // Fetch holdings for all accounts (external API calls)
            for (const account of accounts) {
              try {
                // Get account type from metadata
                const accountType =
                  account.metadata &&
                  typeof account.metadata === 'object' &&
                  'accountType' in account.metadata
                    ? (account.metadata.accountType as string)
                    : 'SPOT';

                const accountUid =
                  account.metadata &&
                  typeof account.metadata === 'object' &&
                  'uid' in account.metadata
                    ? (account.metadata.uid as string)
                    : 'binance-api-account';

                const externalId = `${accountType}_${accountUid}`;

                logger.debug(
                  { accountId: account.id, externalId },
                  'Fetching holdings from external API'
                );

                // Fetch current holdings from exchange (EXTERNAL API CALL)
                const holdingsResult = await integration.fetchHoldings(
                  externalId,
                  decryptedCredentials
                );

                if (holdingsResult.errors && holdingsResult.errors.length > 0) {
                  logger.warn({ errors: holdingsResult.errors }, 'Errors fetching holdings');
                  errors.push({
                    accountId: account.id,
                    accountName: account.name || 'Unknown',
                    institutionId,
                    error: holdingsResult.errors.join(', '),
                  });
                  accountsFailed++;
                  continue;
                }

                // Get existing holdings for this account with token data
                const existingHoldingsWithDetails =
                  await this.holdingRepository.findByUserWithFullDetails(
                    userCredential.userId,
                    account.id,
                    undefined,
                    true // includeHidden so we can update them
                  );

                // Get user's baseCurrencyId for event context
                const [user] = await db
                  .select({ baseCurrencyId: schema.users.baseCurrencyId })
                  .from(schema.users)
                  .where(eq(schema.users.id, userCredential.userId))
                  .limit(1);

                // Store all data for batch processing
                allAccountHoldingsData.push({
                  account,
                  userId: userCredential.userId,
                  userBaseCurrencyId: user?.baseCurrencyId ?? null,
                  institutionId,
                  integration,
                  holdingsResult,
                  existingHoldingsWithDetails,
                });
              } catch (error) {
                accountsFailed++;
                logger.error(
                  {
                    accountId: account.id,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  'Failed to fetch holdings for account'
                );
                errors.push({
                  accountId: account.id,
                  accountName: account.name || 'Unknown',
                  institutionId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
          }
        } catch (error) {
          logger.error(
            {
              institutionId: institution.id,
              institutionName: institution.name,
              error: error instanceof Error ? error.message : String(error),
            },
            'Failed to process institution'
          );
        }
      }

      // STEP 2: Process ALL database operations in single transaction
      await withTransaction(
        async (tx) => {
          for (const accountData of allAccountHoldingsData) {
            try {
              const { account, integration, holdingsResult, existingHoldingsWithDetails } =
                accountData;

              // Create a map of symbol -> holding for easier lookup
              const existingBySymbol = new Map<string, Holding>(
                existingHoldingsWithDetails.map((h) => [h.token.symbol, h.holding])
              );

              // Process each fetched holding
              for (const holding of holdingsResult.holdings) {
                try {
                  // Validate balance
                  if (!isValidDecimalString(holding.balance)) {
                    logger.warn(
                      { symbol: holding.symbol, balance: holding.balance },
                      'Invalid balance, skipping'
                    );
                    continue;
                  }

                  // Check if balance is zero
                  const isZeroBalance = parseFloat(holding.balance) === 0;

                  // Map token
                  const tokenMapping = await integration.mapToken(holding);

                  // Get or create token
                  const token = await this.tokenService.findOrCreateTokenFromIntegration(
                    tokenMapping,
                    cryptoTokenType.id,
                    8,
                    tx
                  );

                  // Check if holding already exists
                  const existing = existingBySymbol.get(token.symbol);

                  if (existing) {
                    // Update existing holding
                    if (existing.balance !== holding.balance) {
                      await this.holdingService.updateHoldingBalanceWithEvent(
                        {
                          holdingId: existing.id,
                          balance: holding.balance,
                          eventContext: accountData.userBaseCurrencyId
                            ? {
                                userId: account.userId,
                                baseCurrencyId: accountData.userBaseCurrencyId,
                              }
                            : undefined,
                        },
                        tx
                      );

                      if (isZeroBalance) {
                        holdingsRemoved++;
                        logger.debug(
                          { holdingId: existing.id, symbol: token.symbol },
                          'Updated holding balance to zero'
                        );
                      } else {
                        holdingsUpdated++;
                        logger.debug(
                          {
                            holdingId: existing.id,
                            symbol: token.symbol,
                            oldBalance: existing.balance,
                            newBalance: holding.balance,
                          },
                          'Updated holding balance'
                        );
                      }
                    }
                  } else if (!isZeroBalance) {
                    // Create new holding only if balance is not zero
                    const newHolding = await this.holdingService.createHoldingWithEvent(
                      {
                        userId: account.userId,
                        accountId: account.id,
                        tokenId: token.id,
                        balance: holding.balance,
                        source: 'sync_exchange_balances',
                        eventContext: accountData.userBaseCurrencyId
                          ? {
                              baseCurrencyId: accountData.userBaseCurrencyId,
                            }
                          : undefined,
                      },
                      tx
                    );

                    holdingsCreated++;
                    logger.debug(
                      { holdingId: newHolding.id, symbol: token.symbol },
                      'Created new holding'
                    );
                  }
                } catch (error) {
                  logger.error(
                    {
                      symbol: holding.symbol,
                      error: error instanceof Error ? error.message : String(error),
                    },
                    'Failed to process holding'
                  );
                  // Continue with next holding
                }
              }

              // Update account metadata with lastSync timestamp
              const updatedMetadata = {
                ...(account.metadata && typeof account.metadata === 'object'
                  ? account.metadata
                  : {}),
                lastSync: new Date().toISOString(),
              };

              await tx
                .update(schema.accounts)
                .set({
                  metadata: updatedMetadata,
                  updatedAt: new Date(),
                })
                .where(eq(schema.accounts.id, account.id));

              accountsSynced++;
              logger.debug({ accountId: account.id }, 'Successfully synced account');
            } catch (error) {
              accountsFailed++;
              logger.error(
                {
                  accountId: accountData.account.id,
                  error: error instanceof Error ? error.message : String(error),
                },
                'Failed to sync account'
              );
              errors.push({
                accountId: accountData.account.id,
                accountName: accountData.account.name || 'Unknown',
                institutionId: accountData.institutionId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        },
        { name: 'syncExchangeBalances', timeout: 120000 }
      );

      const accountsFound = accountsSynced + accountsFailed;
      const durationMs = Date.now() - startTime;

      logger.info(
        {
          accountsFound,
          accountsSynced,
          accountsFailed,
          holdingsUpdated,
          holdingsCreated,
          holdingsRemoved,
          errorCount: errors.length,
          durationMs,
        },
        'Exchange balance sync completed'
      );

      return {
        accountsFound,
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
        'Exchange balance sync failed'
      );
      throw error;
    }
  }
}
