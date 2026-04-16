/**
 * ImportIbkrAccountsUseCase
 *
 * Handles importing Interactive Brokers accounts after Flex Query credential validation:
 * - Creates a portfolio account in the database
 * - Fetches positions and cash balances via Flex Query
 * - Creates holdings for each position and cash balance
 *
 * This use case is called after the user validates their IBKR Flex Query credentials
 */

import { IntegrationManager } from '@scani/integrations';
import { isValidDecimalString } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { withTransaction } from '../database/transaction';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { HoldingService } from '../services/HoldingService';
import { IntegrationCredentialsService } from '../services/IntegrationCredentialsService';
import { PricingService } from '../services/PricingService';
import { TokenService } from '../services/TokenService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:import-ibkr-accounts');

export interface ImportIbkrAccountsInput {
  userId: string;
  institutionId: string;
}

export interface ImportIbkrAccountsResult {
  accounts: Array<{
    id: string;
    name: string;
    accountType: string;
  }>;
  holdings: Array<{
    id: string;
    accountId: string;
    tokenId: string;
    tokenSymbol: string;
    balance: string;
  }>;
  accountsCreated: number;
  tokensImported: number;
  errors: Array<{
    accountType: string;
    error: string;
  }>;
}

@Service()
export class ImportIbkrAccountsUseCase {
  private readonly integrationManager = Container.get(IntegrationManager);
  private readonly integrationCredentialsService = Container.get(IntegrationCredentialsService);
  private readonly tokenService = Container.get(TokenService);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly holdingService = Container.get(HoldingService);
  private readonly pricingService = Container.get(PricingService);

  async execute(input: ImportIbkrAccountsInput): Promise<ImportIbkrAccountsResult> {
    logger.info(
      { userId: input.userId, institutionId: input.institutionId },
      'Starting IBKR accounts import'
    );

    const result: ImportIbkrAccountsResult = {
      accounts: [],
      holdings: [],
      accountsCreated: 0,
      tokensImported: 0,
      errors: [],
    };

    try {
      // STEP 1: Fetch all external data (no DB connections held)
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, input.userId))
        .limit(1);

      if (!user) {
        throw new Error('User not found');
      }

      const credentials = await this.integrationCredentialsService.getDecryptedCredentials(
        input.userId,
        input.institutionId
      );

      if (!credentials) {
        throw new Error('No credentials found for this institution');
      }

      const integration = await this.integrationManager.getIntegration(input.institutionId);
      if (!integration) {
        throw new Error(`Integration not found for institution: ${input.institutionId}`);
      }

      // Fetch accounts from IBKR (returns single portfolio account)
      logger.debug('Fetching accounts from IBKR Flex Query');
      const accountsResult = await integration.fetchAccounts(credentials);

      if (accountsResult.errors && accountsResult.errors.length > 0) {
        logger.warn({ errors: accountsResult.errors }, 'Errors fetching IBKR accounts');
      }

      if (accountsResult.accounts.length === 0) {
        logger.warn('No accounts returned from IBKR');
        return result;
      }

      // Fetch holdings for each account
      interface AccountWithHoldings {
        accountInfo: (typeof accountsResult.accounts)[0];
        holdingsResult: Awaited<ReturnType<typeof integration.fetchHoldings>>;
      }

      const accountsWithHoldings: AccountWithHoldings[] = [];

      for (const accountInfo of accountsResult.accounts) {
        logger.debug(
          { accountType: accountInfo.accountType },
          'Fetching holdings from IBKR Flex Query'
        );

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
          const [institution] = await tx
            .select()
            .from(schema.institutions)
            .where(eq(schema.institutions.id, input.institutionId))
            .limit(1);

          if (!institution) {
            throw new Error(`Institution not found: ${input.institutionId}`);
          }

          // Get investment account type (for broker accounts)
          const [investmentAccountType] = await tx
            .select()
            .from(schema.accountTypes)
            .where(eq(schema.accountTypes.code, 'investment'))
            .limit(1);

          if (!investmentAccountType) {
            throw new Error('Investment account type not found');
          }

          // Pre-fetch token types for fiat and stock
          const fiatTokenType = await this.tokenTypeRepository.findByCode('fiat');
          const stockTokenType = await this.tokenTypeRepository.findByCode('stock');

          if (!fiatTokenType || !stockTokenType) {
            throw new Error('Required token types (fiat, stock) not found');
          }

          const tokenTypeMap: Record<string, string> = {
            fiat: fiatTokenType.id,
            stock: stockTokenType.id,
          };

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
                const accountMetadata = {
                  ...(accountInfo.metadata || {}),
                  lastSync: new Date().toISOString(),
                };

                const [newAccount] = await tx
                  .insert(schema.accounts)
                  .values({
                    userId: input.userId,
                    institutionId: input.institutionId,
                    typeId: investmentAccountType.id,
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
                  'Created new IBKR account'
                );
              }

              // Import holdings
              for (const holding of holdingsResult.holdings) {
                try {
                  const tokenMapping = await integration.mapToken(holding);

                  // Determine the correct token type based on the holding's tokenType
                  const holdingTokenType = holding.tokenType || 'stock';
                  const tokenTypeId = tokenTypeMap[holdingTokenType] || stockTokenType.id;

                  // Dedup: IBKR provides bare symbols (e.g., "XEQT") but DB may have
                  // suffixed variants (e.g., "XEQT.TO"). Try fuzzy match first.
                  if (holdingTokenType === 'stock' && !holding.symbol.includes('.')) {
                    const existingSuffixed = await this.tokenRepository.findBySymbolPrefixAndType(
                      holding.symbol,
                      tokenTypeId,
                      tx
                    );
                    if (existingSuffixed) {
                      // Update the mapping to use the existing suffixed symbol
                      tokenMapping.token.symbol = existingSuffixed.symbol;
                      logger.info(
                        {
                          ibkrSymbol: holding.symbol,
                          matchedSymbol: existingSuffixed.symbol,
                        },
                        'Matched IBKR bare symbol to existing suffixed token'
                      );
                    }
                  }

                  const { token } = await this.tokenService.findOrCreateTokenFromIntegration(
                    tokenMapping,
                    tokenTypeId,
                    2,
                    tx
                  );

                  if (!isValidDecimalString(holding.balance)) {
                    logger.warn({ balance: holding.balance }, 'Invalid balance, skipping');
                    continue;
                  }

                  const externalId = holding.externalTokenId || holding.symbol;
                  const existingHolding =
                    await this.holdingRepository.findByAccountTokenAndExternalId(
                      accountId,
                      token.id,
                      externalId,
                      input.userId,
                      tx,
                      true
                    );

                  if (existingHolding) {
                    await this.holdingService.updateHoldingBalanceWithEvent(
                      {
                        holdingId: existingHolding.id,
                        balance: holding.balance,
                        eventContext: user.baseCurrencyId
                          ? {
                              userId: input.userId,
                              baseCurrencyId: user.baseCurrencyId,
                            }
                          : undefined,
                      },
                      tx
                    );
                    logger.debug(
                      { holdingId: existingHolding.id, externalId },
                      'Updated existing holding'
                    );
                  } else {
                    const newHolding = await this.holdingService.createHoldingWithEvent(
                      {
                        userId: input.userId,
                        accountId,
                        tokenId: token.id,
                        balance: holding.balance,
                        source: 'import_ibkr',
                        externalId,
                        eventContext: user.baseCurrencyId
                          ? {
                              baseCurrencyId: user.baseCurrencyId,
                            }
                          : undefined,
                      },
                      tx
                    );

                    result.holdings.push({
                      id: newHolding.id,
                      accountId,
                      tokenId: token.id,
                      tokenSymbol: token.symbol,
                      balance: holding.balance,
                    });
                    result.tokensImported++;
                    logger.debug(
                      { holdingId: newHolding.id, symbol: token.symbol },
                      'Created new IBKR holding'
                    );
                  }
                } catch (error) {
                  logger.error(
                    {
                      error: error instanceof Error ? error.message : String(error),
                    },
                    'Failed to import IBKR holding'
                  );
                  result.errors.push({
                    accountType: accountInfo.accountType,
                    error: `Failed to import ${holding.symbol}: ${error instanceof Error ? error.message : String(error)}`,
                  });
                }
              }

              // Zero out holdings not present in IBKR response
              try {
                const existingHoldings = await this.holdingRepository.findByAccount(
                  accountId,
                  tx,
                  true,
                  true
                );
                const seenExternalIds = new Set(
                  holdingsResult.holdings.map((h) => h.externalTokenId || h.symbol)
                );
                for (const existingH of existingHoldings) {
                  if (existingH.source !== 'import_ibkr') continue;
                  if (existingH.externalId && seenExternalIds.has(existingH.externalId)) continue;
                  if (existingH.balance === '0') continue;

                  await this.holdingService.updateHoldingBalanceWithEvent(
                    {
                      holdingId: existingH.id,
                      balance: '0',
                      eventContext: user.baseCurrencyId
                        ? { userId: input.userId, baseCurrencyId: user.baseCurrencyId }
                        : undefined,
                    },
                    tx
                  );
                  logger.info(
                    { holdingId: existingH.id, externalId: existingH.externalId },
                    'Zeroed out holding not present in IBKR response'
                  );
                }
              } catch (error) {
                logger.warn(
                  { error: error instanceof Error ? error.message : String(error) },
                  'Failed to zero out stale holdings (non-critical)'
                );
              }

              // Update account metadata with lastSync timestamp for existing accounts
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
              }
            } catch (error) {
              logger.error(
                {
                  accountType: accountInfo.accountType,
                  error: error instanceof Error ? error.message : String(error),
                },
                'Failed to import IBKR account'
              );
              result.errors.push({
                accountType: accountInfo.accountType,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        },
        { name: 'importIbkrAccounts', timeout: 60000 }
      );

      logger.info(
        {
          accountsCreated: result.accountsCreated,
          tokensImported: result.tokensImported,
          errorCount: result.errors.length,
        },
        'IBKR accounts import completed'
      );

      // Warm up prices for imported tokens so the UI shows values immediately
      // instead of waiting for the pricing cron. Best-effort with timeout.
      if (result.holdings.length > 0) {
        try {
          const tokenIds = [...new Set(result.holdings.map((h) => h.tokenId))];
          const tokens = await this.tokenRepository.findByIds(tokenIds);

          if (tokens.length > 0) {
            let baseCurrencySymbol = 'USD';
            if (user.baseCurrencyId) {
              const baseToken = await this.tokenRepository.findById(user.baseCurrencyId);
              if (baseToken) baseCurrencySymbol = baseToken.symbol;
            }

            logger.info(
              { tokenCount: tokens.length, baseCurrencySymbol },
              'Warming prices for IBKR imported tokens'
            );

            const WARM_UP_BUDGET_MS = 15_000;
            const work = this.pricingService.getTokenPrices(tokens, baseCurrencySymbol, new Date());
            const timeout = new Promise<Map<string, string>>((resolve) =>
              setTimeout(() => resolve(new Map()), WARM_UP_BUDGET_MS)
            );

            const prices = await Promise.race([work, timeout]);
            const pricedCount = Array.from(prices.values()).filter((p) => p && p !== '0').length;

            logger.info(
              { pricedCount, total: tokens.length },
              'IBKR token price warm-up completed'
            );
          }
        } catch (error) {
          logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'IBKR token price warm-up failed (non-fatal — cron will backfill)'
          );
        }
      }

      return result;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to import IBKR accounts'
      );
      throw error;
    }
  }
}
