/**
 * ImportExchangeAccountsUseCase
 *
 * Generic use case for importing exchange accounts after API key validation.
 * Works with any exchange integration (Binance, Kraken, Coinbase, Bybit, etc.):
 * - Creates accounts in the database
 * - Fetches and creates holdings (skipping zero balances)
 * - Warms up prices so the UI shows values immediately
 * - Zeros out stale holdings not present in the exchange response
 *
 * Replaces the exchange-specific ImportBinanceAccountsUseCase,
 * ImportKrakenAccountsUseCase, etc. with a single reusable implementation.
 */

import { IntegrationManager } from '@scani/integrations';
import { isValidDecimalString } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { withTransaction } from '../database/transaction';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { HoldingService } from '../services/HoldingService';
import { IntegrationCredentialsService } from '../services/IntegrationCredentialsService';
import { PricingService } from '../services/PricingService';
import { TokenService } from '../services/TokenService';
import { createComponentLogger } from '../utils/logger';

const logger = createComponentLogger('use-case:import-exchange-accounts');

export interface ImportExchangeAccountsInput {
  userId: string;
  institutionId: string;
}

export interface ImportExchangeAccountsResult {
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
export class ImportExchangeAccountsUseCase {
  private readonly integrationManager = Container.get(IntegrationManager);
  private readonly integrationCredentialsService = Container.get(IntegrationCredentialsService);
  private readonly tokenService = Container.get(TokenService);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly holdingService = Container.get(HoldingService);
  private readonly pricingService = Container.get(PricingService);

  async execute(input: ImportExchangeAccountsInput): Promise<ImportExchangeAccountsResult> {
    logger.info(
      { userId: input.userId, institutionId: input.institutionId },
      'Starting exchange accounts import'
    );

    const result: ImportExchangeAccountsResult = {
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

      // Fetch accounts from exchange API
      const accountsResult = await integration.fetchAccounts(credentials);

      if (accountsResult.errors && accountsResult.errors.length > 0) {
        logger.warn({ errors: accountsResult.errors }, 'Errors fetching accounts');
      }

      if (accountsResult.accounts.length === 0) {
        logger.warn('No accounts returned from exchange');
        return result;
      }

      // Fetch holdings for all accounts (external API calls)
      interface AccountWithHoldings {
        accountInfo: (typeof accountsResult.accounts)[0];
        holdingsResult: Awaited<ReturnType<typeof integration.fetchHoldings>>;
      }

      const accountsWithHoldings: AccountWithHoldings[] = [];

      for (const accountInfo of accountsResult.accounts) {
        const holdingsResult = await integration.fetchHoldings(accountInfo.externalId, credentials);

        if (holdingsResult.errors && holdingsResult.errors.length > 0) {
          result.errors.push({
            accountType: accountInfo.accountType,
            error: holdingsResult.errors.join(', '),
          });
        }

        accountsWithHoldings.push({ accountInfo, holdingsResult });
      }

      // Derive a source tag from the institution name for holding tracking
      const [institution] = await db
        .select()
        .from(schema.institutions)
        .where(eq(schema.institutions.id, input.institutionId))
        .limit(1);
      const sourceTag = `import_${(institution?.name || 'exchange').toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

      // STEP 2: Process ALL database operations in single transaction
      await withTransaction(
        async (tx) => {
          if (!institution) {
            throw new Error(`Institution not found: ${input.institutionId}`);
          }

          const [cryptoAccountType] = await tx
            .select()
            .from(schema.accountTypes)
            .where(eq(schema.accountTypes.code, 'crypto'))
            .limit(1);

          if (!cryptoAccountType) {
            throw new Error('Crypto account type not found');
          }

          const [cryptoType] = await tx
            .select()
            .from(schema.tokenTypes)
            .where(eq(schema.tokenTypes.code, 'crypto'))
            .limit(1);

          if (!cryptoType) {
            throw new Error('Crypto token type not found');
          }

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
              } else {
                const [newAccount] = await tx
                  .insert(schema.accounts)
                  .values({
                    userId: input.userId,
                    institutionId: input.institutionId,
                    typeId: cryptoAccountType.id,
                    name: accountInfo.name,
                    description: accountInfo.description,
                    metadata: {
                      ...(accountInfo.metadata || {}),
                      lastSync: new Date().toISOString(),
                    },
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
              }

              // Import holdings
              for (const holding of holdingsResult.holdings) {
                try {
                  const tokenMapping = await integration.mapToken(holding);
                  const { token } = await this.tokenService.findOrCreateTokenFromIntegration(
                    tokenMapping,
                    cryptoType.id,
                    8,
                    tx
                  );

                  if (!isValidDecimalString(holding.balance)) {
                    continue;
                  }

                  const isZeroBalance = parseFloat(holding.balance) === 0;
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
                    // Update existing holding (including setting balance to 0)
                    await this.holdingService.updateHoldingBalanceWithEvent(
                      {
                        holdingId: existingHolding.id,
                        balance: holding.balance,
                        eventContext: user.baseCurrencyId
                          ? { userId: input.userId, baseCurrencyId: user.baseCurrencyId }
                          : undefined,
                      },
                      tx
                    );
                  } else if (!isZeroBalance) {
                    // Only create new holdings for non-zero balances
                    const newHolding = await this.holdingService.createHoldingWithEvent(
                      {
                        userId: input.userId,
                        accountId,
                        tokenId: token.id,
                        balance: holding.balance,
                        source: sourceTag,
                        externalId,
                        eventContext: user.baseCurrencyId
                          ? { baseCurrencyId: user.baseCurrencyId }
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
                  }
                } catch (error) {
                  result.errors.push({
                    accountType: accountInfo.accountType,
                    error: `Failed to import ${holding.symbol}: ${error instanceof Error ? error.message : String(error)}`,
                  });
                }
              }

              // Zero out stale holdings not in the exchange response
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
                for (const eh of existingHoldings) {
                  if (eh.source !== sourceTag) continue;
                  if (eh.externalId && seenExternalIds.has(eh.externalId)) continue;
                  if (eh.balance === '0') continue;

                  await this.holdingService.updateHoldingBalanceWithEvent(
                    {
                      holdingId: eh.id,
                      balance: '0',
                      eventContext: user.baseCurrencyId
                        ? { userId: input.userId, baseCurrencyId: user.baseCurrencyId }
                        : undefined,
                    },
                    tx
                  );
                }
              } catch {
                // Non-critical
              }

              // Update lastSync for existing accounts
              if (existing) {
                await tx
                  .update(schema.accounts)
                  .set({
                    metadata: {
                      ...(existing.metadata && typeof existing.metadata === 'object'
                        ? existing.metadata
                        : {}),
                      lastSync: new Date().toISOString(),
                    },
                    updatedAt: new Date(),
                  })
                  .where(eq(schema.accounts.id, accountId));
              }
            } catch (error) {
              result.errors.push({
                accountType: accountInfo.accountType,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        },
        { name: 'importExchangeAccounts', timeout: 60000 }
      );

      logger.info(
        {
          accountsCreated: result.accountsCreated,
          tokensImported: result.tokensImported,
          errorCount: result.errors.length,
        },
        'Exchange accounts import completed'
      );

      // Warm up prices so the UI shows values immediately
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
            logger.info({ tokenCount: tokens.length }, 'Warming prices for exchange tokens');
            const WARM_UP_BUDGET_MS = 15_000;
            const work = this.pricingService.getTokenPrices(tokens, baseCurrencySymbol, new Date());
            const timeout = new Promise<Map<string, string>>((resolve) =>
              setTimeout(() => resolve(new Map()), WARM_UP_BUDGET_MS)
            );
            await Promise.race([work, timeout]);
          }
        } catch (error) {
          logger.warn(
            { error: error instanceof Error ? error.message : String(error) },
            'Exchange token price warm-up failed (non-fatal)'
          );
        }
      }

      return result;
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Failed to import exchange accounts'
      );
      throw error;
    }
  }
}
