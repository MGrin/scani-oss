/**
 * ImportPlaidAccountsUseCase
 *
 * Imports accounts and balances from a Plaid connection
 * Creates accounts and holdings (balances) in the database
 */

import { createPlaidIntegration } from '@scani/integrations';
import { isValidDecimalString } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { TokenService } from '../services/TokenService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:import-plaid-accounts');

export interface ImportPlaidAccountsInput {
  /** User ID */
  userId: string;
  /** Plaid item ID */
  plaidItemId: string;
}

export interface ImportPlaidAccountsResult {
  /** Created accounts */
  accounts: Array<{
    id: string;
    name: string;
    accountType: string;
  }>;
  /** Created holdings (balances) */
  holdings: Array<{
    id: string;
    accountId: string;
    tokenSymbol: string;
    balance: string;
  }>;
  /** Total accounts created */
  accountsCreated: number;
  /** Total holdings imported */
  holdingsImported: number;
  /** Errors encountered during import */
  errors: string[];
}

/**
 * Import Plaid Accounts Use Case
 */
@Service()
export class ImportPlaidAccountsUseCase {
  private readonly tokenService = Container.get(TokenService);
  private readonly holdingRepository = Container.get(HoldingRepository);

  async execute(input: ImportPlaidAccountsInput): Promise<ImportPlaidAccountsResult> {
    logger.info(
      { userId: input.userId, plaidItemId: input.plaidItemId },
      'Starting Plaid accounts import'
    );

    const result: ImportPlaidAccountsResult = {
      accounts: [],
      holdings: [],
      accountsCreated: 0,
      holdingsImported: 0,
      errors: [],
    };

    try {
      // Get Plaid item
      const [plaidItem] = await db
        .select()
        .from(schema.plaidItems)
        .where(
          and(
            eq(schema.plaidItems.plaidItemId, input.plaidItemId),
            eq(schema.plaidItems.userId, input.userId)
          )
        )
        .limit(1);

      if (!plaidItem) {
        throw new Error('Plaid item not found');
      }

      // Create integration instance
      const integration = createPlaidIntegration(plaidItem.institutionId);

      // Fetch accounts
      const accountsResult = await integration.fetchAccounts({
        accessToken: plaidItem.plaidAccessToken,
      });

      if (accountsResult.errors && accountsResult.errors.length > 0) {
        result.errors.push(...accountsResult.errors);
      }

      // Process each account
      for (const account of accountsResult.accounts) {
        try {
          // Find or create account type
          const [accountType] = await db
            .select()
            .from(schema.accountTypes)
            .where(eq(schema.accountTypes.code, account.accountType))
            .limit(1);

          if (!accountType) {
            result.errors.push(`Account type ${account.accountType} not found`);
            continue;
          }

          // Check if account already exists
          const [scaniAccountResult] = await db
            .select()
            .from(schema.accounts)
            .where(
              and(
                eq(schema.accounts.userId, input.userId),
                eq(schema.accounts.institutionId, plaidItem.institutionId),
                eq(schema.accounts.name, account.name)
              )
            )
            .limit(1);

          let scaniAccount = scaniAccountResult;

          if (!scaniAccount) {
            // Create new account
            const [newAccount] = await db
              .insert(schema.accounts)
              .values({
                userId: input.userId,
                institutionId: plaidItem.institutionId,
                name: account.name,
                typeId: accountType.id,
                description: account.description,
                isActive: account.isActive ?? true,
                metadata: {
                  ...((account.metadata as Record<string, unknown>) || {}),
                  plaidAccountId: account.externalId,
                  lastSync: new Date().toISOString(),
                },
              })
              .returning();

            if (!newAccount) {
              result.errors.push(`Failed to create account for ${account.name}`);
              continue;
            }

            scaniAccount = newAccount;
            result.accountsCreated++;

            // Create Plaid account mapping
            await db.insert(schema.plaidAccountMappings).values({
              plaidItemId: plaidItem.id,
              scaniAccountId: scaniAccount.id,
              plaidAccountId: account.externalId,
              mask: (account.metadata?.mask as string) || null,
              officialName: (account.metadata?.officialName as string) || null,
              isActive: true,
            });

            logger.info(
              { accountId: scaniAccount.id, plaidAccountId: account.externalId },
              'Created account with Plaid mapping'
            );
          } else {
            // Update existing account metadata with lastSync timestamp
            const updatedMetadata = {
              ...(scaniAccount.metadata && typeof scaniAccount.metadata === 'object'
                ? scaniAccount.metadata
                : {}),
              lastSync: new Date().toISOString(),
            };

            await db
              .update(schema.accounts)
              .set({
                metadata: updatedMetadata,
                updatedAt: new Date(),
              })
              .where(eq(schema.accounts.id, scaniAccount.id));

            logger.debug({ accountId: scaniAccount.id }, 'Updated account lastSync timestamp');
          }

          if (!scaniAccount) {
            result.errors.push(`Failed to create or find account for ${account.name}`);
            continue;
          }

          result.accounts.push({
            id: scaniAccount.id,
            name: scaniAccount.name,
            accountType: account.accountType,
          });

          // Fetch holdings (balances) for this account
          const holdingsResult = await integration.fetchHoldings(account.externalId, {
            accessToken: plaidItem.plaidAccessToken,
          });

          if (holdingsResult.errors && holdingsResult.errors.length > 0) {
            result.errors.push(...holdingsResult.errors);
          }

          // Process holdings
          for (const holding of holdingsResult.holdings) {
            try {
              if (!isValidDecimalString(holding.balance)) {
                logger.warn({ holding }, 'Invalid balance value, skipping');
                continue;
              }

              // Map token
              const tokenMapping = await integration.mapToken(holding);

              // Determine token type from holding
              // For bank accounts (depository/credit/loan), tokenType will be 'fiat'
              // For investment accounts, tokenType may be undefined - default to 'fiat'
              // This allows investment accounts to potentially hold stocks, ETFs, or other securities
              const tokenTypeCode = holding.tokenType || 'fiat';

              // Get token type from database
              const [tokenType] = await db
                .select()
                .from(schema.tokenTypes)
                .where(eq(schema.tokenTypes.code, tokenTypeCode))
                .limit(1);

              if (!tokenType) {
                throw new Error(`Token type '${tokenTypeCode}' not found`);
              }

              // Create or get token using integration mapping
              const token = await this.tokenService.findOrCreateTokenFromIntegration(
                tokenMapping,
                tokenType.id,
                holding.decimals || 2 // Use decimals from holding, default to 2 for fiat
              );

              // Check if holding already exists
              const existingHolding = await this.holdingRepository.findByAccountAndToken(
                scaniAccount.id,
                token.id,
                input.userId
              );

              let createdHolding: Awaited<ReturnType<typeof this.holdingRepository.create>>;
              if (existingHolding) {
                // Update existing holding
                await this.holdingRepository.update(existingHolding.id, {
                  balance: holding.balance,
                });
                createdHolding = existingHolding;
                logger.debug({ holdingId: existingHolding.id }, 'Updated existing holding');
              } else {
                // Create new holding
                createdHolding = await this.holdingRepository.create({
                  userId: input.userId,
                  accountId: scaniAccount.id,
                  tokenId: token.id,
                  balance: holding.balance,
                  isHidden: false,
                });
              }

              result.holdings.push({
                id: createdHolding.id,
                accountId: scaniAccount.id,
                tokenSymbol: token.symbol,
                balance: holding.balance,
              });

              result.holdingsImported++;
            } catch (error) {
              logger.error(
                { accountId: scaniAccount.id, holding, error },
                'Failed to create holding'
              );
              result.errors.push(
                `Failed to create holding for ${holding.symbol}: ${error instanceof Error ? error.message : 'Unknown error'}`
              );
            }
          }
        } catch (error) {
          logger.error({ account, error }, 'Failed to process account');
          result.errors.push(
            `Failed to process account ${account.name}: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      // Update last sync time
      await db
        .update(schema.plaidItems)
        .set({
          lastSuccessfulSync: new Date(),
          lastBalanceSync: new Date(),
        })
        .where(eq(schema.plaidItems.id, plaidItem.id));

      logger.info(
        {
          userId: input.userId,
          accountsCreated: result.accountsCreated,
          holdingsImported: result.holdingsImported,
        },
        'Plaid accounts import completed'
      );

      return result;
    } catch (error) {
      logger.error({ userId: input.userId, error }, 'Failed to import Plaid accounts');
      throw error;
    }
  }
}
