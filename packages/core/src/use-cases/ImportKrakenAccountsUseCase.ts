/**
 * ImportKrakenAccountsUseCase
 *
 * Handles importing Kraken accounts after API key validation:
 * - Creates a spot trading account in the database
 * - Fetches and creates holdings for the account
 * - Stores integration credentials
 *
 * This use case is called after the user validates their Kraken API keys
 */

import { IntegrationManager } from '@scani/integrations';
import { isValidDecimalString } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { withTransaction } from '../database/transaction';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { IntegrationCredentialsService } from '../services/IntegrationCredentialsService';
import { TokenService } from '../services/TokenService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:import-kraken-accounts');

export interface ImportKrakenAccountsInput {
  /** User ID */
  userId: string;
  /** Institution ID (usually 'kraken') */
  institutionId: string;
}

export interface ImportKrakenAccountsResult {
  /** Created accounts */
  accounts: Array<{
    id: string;
    name: string;
    accountType: string;
  }>;
  /** Created holdings */
  holdings: Array<{
    id: string;
    accountId: string;
    tokenSymbol: string;
    balance: string;
  }>;
  /** Total accounts created */
  accountsCreated: number;
  /** Total tokens imported */
  tokensImported: number;
  /** Errors encountered during import */
  errors: Array<{
    accountType: string;
    error: string;
  }>;
}

/**
 * Import Kraken Accounts Use Case
 */
@Service()
export class ImportKrakenAccountsUseCase {
  private readonly integrationManager = Container.get(IntegrationManager);
  private readonly integrationCredentialsService = Container.get(IntegrationCredentialsService);
  private readonly tokenService = Container.get(TokenService);
  private readonly holdingRepository = Container.get(HoldingRepository);

  async execute(input: ImportKrakenAccountsInput): Promise<ImportKrakenAccountsResult> {
    logger.info(
      { userId: input.userId, institutionId: input.institutionId },
      'Starting Kraken accounts import'
    );

    const result: ImportKrakenAccountsResult = {
      accounts: [],
      holdings: [],
      accountsCreated: 0,
      tokensImported: 0,
      errors: [],
    };

    try {
      // STEP 1: Fetch all external data (no DB connections held)
      // Get user
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, input.userId))
        .limit(1);

      if (!user) {
        throw new Error('User not found');
      }

      // Get integration credentials
      const credentials = await this.integrationCredentialsService.getDecryptedCredentials(
        input.userId,
        input.institutionId
      );

      if (!credentials) {
        throw new Error('No credentials found for this institution');
      }

      // Get integration
      const integration = await this.integrationManager.getIntegration(input.institutionId);
      if (!integration) {
        throw new Error(`Integration not found for institution: ${input.institutionId}`);
      }

      // Fetch accounts from Kraken API (external call)
      logger.debug('Fetching accounts from Kraken API');
      const accountsResult = await integration.fetchAccounts(credentials);

      if (accountsResult.errors && accountsResult.errors.length > 0) {
        logger.warn({ errors: accountsResult.errors }, 'Errors fetching accounts');
      }

      if (accountsResult.accounts.length === 0) {
        logger.warn('No accounts returned from Kraken');
        return result;
      }

      // Fetch holdings for all accounts (external API calls)
      interface AccountWithHoldings {
        accountInfo: (typeof accountsResult.accounts)[0];
        holdingsResult: Awaited<ReturnType<typeof integration.fetchHoldings>>;
      }

      const accountsWithHoldings: AccountWithHoldings[] = [];

      for (const accountInfo of accountsResult.accounts) {
        logger.debug({ accountType: accountInfo.accountType }, 'Fetching holdings from Kraken API');

        const holdingsResult = await integration.fetchHoldings(accountInfo.externalId, credentials);

        if (holdingsResult.errors && holdingsResult.errors.length > 0) {
          result.errors.push({
            accountType: accountInfo.accountType,
            error: holdingsResult.errors.join(', '),
          });
        }

        accountsWithHoldings.push({ accountInfo, holdingsResult });
      }

      // STEP 2: Process ALL database operations in single transaction
      await withTransaction(
        async (tx) => {
          // Get institution from database
          const [institution] = await tx
            .select()
            .from(schema.institutions)
            .where(eq(schema.institutions.id, input.institutionId))
            .limit(1);

          if (!institution) {
            throw new Error(`Institution not found: ${input.institutionId}`);
          }

          // Get crypto account type
          const [cryptoAccountType] = await tx
            .select()
            .from(schema.accountTypes)
            .where(eq(schema.accountTypes.code, 'crypto'))
            .limit(1);

          if (!cryptoAccountType) {
            throw new Error('Crypto account type not found');
          }

          // Get crypto token type
          const [cryptoType] = await tx
            .select()
            .from(schema.tokenTypes)
            .where(eq(schema.tokenTypes.code, 'crypto'))
            .limit(1);

          if (!cryptoType) {
            throw new Error('Crypto token type not found');
          }

          // Create accounts and import holdings for each account type
          for (const { accountInfo, holdingsResult } of accountsWithHoldings) {
            try {
              // Check if account already exists
              const existingAccounts = await tx
                .select()
                .from(schema.accounts)
                .where(
                  and(
                    eq(schema.accounts.userId, input.userId),
                    eq(schema.accounts.institutionId, input.institutionId)
                  )
                );

              const existing = existingAccounts.find(
                (acc) =>
                  acc.metadata &&
                  typeof acc.metadata === 'object' &&
                  'accountType' in acc.metadata &&
                  acc.metadata.accountType === accountInfo.accountType
              );

              let accountId: string;

              if (existing) {
                accountId = existing.id;
                logger.debug(
                  { accountId, accountType: accountInfo.accountType },
                  'Account already exists'
                );
              } else {
                // Create new account with lastSync timestamp in metadata
                const accountMetadata = {
                  ...(accountInfo.metadata || {}),
                  lastSync: new Date().toISOString(),
                };

                const [newAccount] = await tx
                  .insert(schema.accounts)
                  .values({
                    userId: input.userId,
                    institutionId: input.institutionId,
                    typeId: cryptoAccountType.id,
                    name: accountInfo.name,
                    description: accountInfo.description,
                    metadata: accountMetadata,
                    isActive: true,
                  })
                  .returning();

                if (!newAccount) {
                  throw new Error('Failed to create account');
                }

                accountId = newAccount.id;
                result.accountsCreated++;
                result.accounts.push({
                  id: accountId,
                  name: accountInfo.name,
                  accountType: accountInfo.accountType,
                });
                logger.info(
                  { accountId, accountType: accountInfo.accountType },
                  'Created new account'
                );
              }

              // Import holdings (already fetched from external API)
              for (const holding of holdingsResult.holdings) {
                try {
                  // Map token
                  const tokenMapping = await integration.mapToken(holding);

                  // Create or get token
                  const token = await this.tokenService.findOrCreateTokenFromIntegration(
                    tokenMapping,
                    cryptoType.id,
                    8,
                    tx
                  );

                  // Validate balance
                  if (!isValidDecimalString(holding.balance)) {
                    logger.warn({ balance: holding.balance }, 'Invalid balance, skipping');
                    continue;
                  }

                  // Check if holding already exists
                  const existingHolding = await this.holdingRepository.findByAccountAndToken(
                    accountId,
                    token.id,
                    input.userId,
                    undefined,
                    tx
                  );

                  if (existingHolding) {
                    // Update existing holding
                    await this.holdingRepository.update(
                      existingHolding.id,
                      {
                        balance: holding.balance,
                      },
                      tx
                    );
                    logger.debug({ holdingId: existingHolding.id }, 'Updated existing holding');
                  } else {
                    // Create new holding
                    const newHolding = await this.holdingRepository.create(
                      {
                        userId: input.userId,
                        accountId,
                        tokenId: token.id,
                        balance: holding.balance,
                        isHidden: false,
                      },
                      tx
                    );

                    result.holdings.push({
                      id: newHolding.id,
                      accountId,
                      tokenSymbol: token.symbol,
                      balance: holding.balance,
                    });
                    result.tokensImported++;
                    logger.debug(
                      { holdingId: newHolding.id, symbol: token.symbol },
                      'Created new holding'
                    );
                  }
                } catch (error) {
                  logger.error(
                    { error: error instanceof Error ? error.message : String(error) },
                    'Failed to import holding'
                  );
                  result.errors.push({
                    accountType: accountInfo.accountType,
                    error: `Failed to import ${holding.symbol}: ${error instanceof Error ? error.message : String(error)}`,
                  });
                }
              }

              // Update account metadata with lastSync timestamp for existing accounts
              // (New accounts already have lastSync set during creation)
              if (existing) {
                const updatedMetadata = {
                  ...(existing.metadata && typeof existing.metadata === 'object'
                    ? existing.metadata
                    : {}),
                  lastSync: new Date().toISOString(),
                };

                await tx
                  .update(schema.accounts)
                  .set({
                    metadata: updatedMetadata,
                    updatedAt: new Date(),
                  })
                  .where(eq(schema.accounts.id, accountId));

                logger.debug({ accountId }, 'Updated account lastSync timestamp');
              }
            } catch (error) {
              logger.error(
                {
                  accountType: accountInfo.accountType,
                  error: error instanceof Error ? error.message : String(error),
                },
                'Failed to import account'
              );
              result.errors.push({
                accountType: accountInfo.accountType,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        },
        { name: 'importKrakenAccounts', timeout: 60000 }
      );

      logger.info(
        {
          accountsCreated: result.accountsCreated,
          tokensImported: result.tokensImported,
          errorCount: result.errors.length,
        },
        'Kraken accounts import completed'
      );

      return result;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to import Kraken accounts'
      );
      throw error;
    }
  }
}
