/**
 * ImportExchangeAccountsUseCase
 *
 * Generic use case for importing exchange accounts after API key validation.
 * Works with any exchange integration (Binance, Kraken, Coinbase, Bybit, etc.):
 * - Creates accounts in the database
 * - Fetches and creates holdings (skipping zero balances for new entries)
 * - Respects token types from integrations (crypto, fiat, stock)
 * - Warms up prices for ALL touched tokens so the UI shows values immediately
 * - Zeros out stale holdings not present in the exchange response
 */

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { BlockchainIntegration, IntegrationManager } from '@scani/integrations';
import { createComponentLogger } from '@scani/logging';
import { isValidDecimalString } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { HoldingService } from '../services/HoldingService';
import { IntegrationCredentialsService } from '../services/IntegrationCredentialsService';
import { PricingService } from '../services/PricingService';
import { TokenService } from '../services/TokenService';

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
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
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

    // Track ALL token IDs touched during import (new + updated) for pricing warm-up
    const allTouchedTokenIds = new Set<string>();

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

      // Exchange-import only knows how to talk to exchange/broker integrations.
      // When `institution_blockchain_mappings` resolves the same institutionId
      // to a BlockchainIntegration, the fetchAccounts contract (needs
      // walletManager + `credentials.userId`) can't be satisfied from this
      // path — wallet-import is the correct producer. Fail fast with a
      // classified-unrecoverable message so BullMQ doesn't retry.
      if (integration instanceof BlockchainIntegration) {
        throw new Error(
          `Exchange-import targeted a blockchain-type institution (${input.institutionId}). Use wallet-import to sync on-chain holdings.`
        );
      }

      const accountsResult = await integration.fetchAccounts(credentials);

      // Same policy as IBKR: empty accounts ⇒ fail the job loudly with the
      // real upstream reason. Previously we logged a warning and returned
      // an empty result, which marked the job "completed" and left the
      // user on a no-holdings page with no diagnostic.
      if (accountsResult.accounts.length === 0) {
        const reason =
          accountsResult.errors && accountsResult.errors.length > 0
            ? accountsResult.errors.join('; ')
            : 'Exchange returned no accounts';
        logger.error({ errors: accountsResult.errors }, 'Exchange accounts import failed');
        throw new Error(`Exchange import failed: ${reason}`);
      }

      if (accountsResult.errors && accountsResult.errors.length > 0) {
        logger.warn({ errors: accountsResult.errors }, 'Partial errors fetching accounts');
        result.errors.push(
          ...accountsResult.errors.map((e) => ({ accountType: 'unknown', error: e }))
        );
      }

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

      // Same policy as IBKR: if every holdings fetch failed (zero actual
      // holdings AND errors recorded), the import produced nothing
      // useful — fail the job loudly so the user sees the real provider
      // error instead of a "success with 1 account / 0 tokens" mystery.
      const totalHoldings = accountsWithHoldings.reduce(
        (sum, a) => sum + a.holdingsResult.holdings.length,
        0
      );
      if (totalHoldings === 0 && result.errors.length > 0) {
        const reason = result.errors.map((e) => e.error).join('; ');
        logger.error({ errors: result.errors }, 'Exchange import produced no holdings');
        throw new Error(`Exchange import failed: ${reason}`);
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

          // Fetch all token types so we can respect holding.tokenType
          const cryptoTokenType = await this.tokenTypeRepository.findByCode('crypto');
          const fiatTokenType = await this.tokenTypeRepository.findByCode('fiat');
          const stockTokenType = await this.tokenTypeRepository.findByCode('stock');

          if (!cryptoTokenType) {
            throw new Error('Crypto token type not found');
          }

          const tokenTypeMap: Record<string, string> = {
            crypto: cryptoTokenType.id,
            ...(fiatTokenType && { fiat: fiatTokenType.id }),
            ...(stockTokenType && { stock: stockTokenType.id }),
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

              // Build seenExternalIds from ALL holdings BEFORE processing,
              // so the stale-holdings cleanup works correctly even when we
              // skip zero-balance holdings during import.
              const seenExternalIds = new Set(
                holdingsResult.holdings.map((h) => h.externalTokenId || h.symbol)
              );

              // Import holdings
              for (const holding of holdingsResult.holdings) {
                try {
                  // Validate balance BEFORE creating tokens — don't pollute DB
                  // with orphan tokens for invalid/zero balances
                  if (!isValidDecimalString(holding.balance)) {
                    continue;
                  }
                  const isZeroBalance = parseFloat(holding.balance) === 0;

                  // Skip zero-balance holdings entirely (no token, no holding)
                  if (isZeroBalance) {
                    continue;
                  }

                  const tokenMapping = await integration.mapToken(holding);

                  // Use the token type from the integration (crypto, fiat, stock)
                  const holdingTokenType = holding.tokenType || 'crypto';
                  const tokenTypeId = tokenTypeMap[holdingTokenType] || cryptoTokenType.id;
                  const defaultDecimals = holdingTokenType === 'fiat' ? 2 : 8;

                  const { token } = await this.tokenService.findOrCreateTokenFromIntegration(
                    tokenMapping,
                    tokenTypeId,
                    defaultDecimals,
                    tx
                  );

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
                          ? { userId: input.userId, baseCurrencyId: user.baseCurrencyId }
                          : undefined,
                      },
                      tx
                    );
                    allTouchedTokenIds.add(token.id);
                  } else {
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
                    allTouchedTokenIds.add(token.id);
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
              } catch (error) {
                logger.warn(
                  {
                    error: error instanceof Error ? error.message : String(error),
                    accountId,
                  },
                  'Failed to cleanup stale holdings'
                );
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

      // Warm up prices for ALL touched tokens (new + updated) so UI shows values
      if (allTouchedTokenIds.size > 0) {
        try {
          const tokens = await this.tokenRepository.findByIds([...allTouchedTokenIds]);
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
