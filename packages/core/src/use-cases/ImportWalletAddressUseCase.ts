/**
 * ImportWalletAddressUseCase
 *
 * Handles importing a crypto wallet address across multiple blockchains:
 * - Detects which chains the wallet exists on
 * - Fetches all token balances from each chain
 * - Creates institution for each chain (if not exists)
 * - Creates account for each chain with wallet metadata
 * - Creates holdings for each token with non-zero balance
 * - Fetches token prices for the imported holdings (best-effort) so the
 *   success response reflects real USD values instead of zeroes that
 *   trickle in over the next 30 minutes from the pricing cron.
 *
 * Reusable for:
 * - Manual wallet import by users
 * - Cron jobs for periodic balance updates
 * - Background sync operations
 */

import type { ScaniIntegration } from '@scani/integrations';
import { IntegrationManager } from '@scani/integrations';
import { isValidDecimalString } from '@scani/shared';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../database/connection';
import * as schema from '../database/schema';
import { withTransaction } from '../database/transaction';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { InstitutionBlockchainMappingRepository } from '../repositories/InstitutionBlockchainMappingRepository';
import { TokenRepository } from '../repositories/TokenRepository';
import { HoldingService } from '../services/HoldingService';
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
  /** Human-readable label for the imported wallet (displayName or shortened address) */
  walletLabel: string;
  /** Created accounts (one per chain) */
  accounts: Array<{
    id: string;
    name: string;
    chainId: string | number;
    chainName: string;
    institutionId: string;
    institutionName: string;
  }>;
  /** Created holdings — enriched for the post-import review UI */
  holdings: Array<{
    id: string;
    accountId: string;
    accountName: string;
    chainName: string;
    tokenId: string;
    tokenSymbol: string;
    tokenName: string;
    tokenIconUrl: string | null;
    /**
     * True if THIS import was the first time our system ever saw this token.
     * The UI uses this to decide whether to offer "Mark as scam" (new tokens
     * only — existing tokens' scam classification is owned by the system,
     * not individual users) versus a plain "Delete" / "Hide" action.
     */
    tokenIsNew: boolean;
    /**
     * Current scam probability on the token record. For newly-created tokens
     * this is the score from `ScamTokenDetectionService`; for existing
     * tokens it's whatever's already stored.
     */
    tokenScamProbability: number;
    balance: string;
    /** Price of one unit of this token in the user's base currency, or null if unavailable */
    priceInBaseCurrency: string | null;
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
  private readonly integrationManager = Container.get(IntegrationManager);
  private readonly userWalletService = Container.get(UserWalletService);
  private readonly integrationCredentialsService = Container.get(IntegrationCredentialsService);
  private readonly mappingRepository = Container.get(InstitutionBlockchainMappingRepository);
  private readonly tokenService = Container.get(TokenService);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly holdingService = Container.get(HoldingService);
  private readonly pricingService = Container.get(PricingService);

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

    // Use integration-based approach
    logger.debug('Using integration-based wallet import');
    return await this.executeWithIntegrations(input, userId, user.baseCurrencyId);
  }

  /**
   * Execute wallet import using new integration-based approach
   */
  private async executeWithIntegrations(
    input: ImportWalletInput,
    userId: string,
    baseCurrencyId: string | null
  ): Promise<ImportWalletResult> {
    logger.info(
      {
        userId,
        address: `${input.address.substring(0, 10)}...${input.address.substring(input.address.length - 4)}`,
      },
      'Starting wallet import with integrations'
    );

    // STEP 1: Quick metadata queries (no long-running operations, no transaction)
    logger.debug(
      {
        userId,
        address: `${input.address.substring(0, 10)}...`,
      },
      'Detecting wallet chains with integrations'
    );

    const detectedInstitutionIds = await this.integrationManager.detectWalletChains(input.address);

    logger.info(
      {
        userId,
        detectedInstitutionsCount: detectedInstitutionIds.length,
        institutionIds: detectedInstitutionIds,
      },
      'Wallet chain detection completed'
    );

    if (detectedInstitutionIds.length === 0) {
      logger.warn(
        {
          userId,
          address: `${input.address.substring(0, 10)}...`,
          addressLength: input.address.length,
        },
        'No institutions detected for wallet - wallet may not exist on any configured chains or has no activity'
      );
      return {
        walletLabel: this.computeWalletLabel(input.displayName, input.address),
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

    logger.info(
      { userId, institutionCount: detectedInstitutionIds.length },
      'Processing institutions for wallet import'
    );

    // STEP 2: Fetch ALL blockchain data (SLOW external API calls, no DB connection held)
    const blockchainData: Array<{
      institutionId: string;
      institution: typeof schema.institutions.$inferSelect;
      chainId: string;
      integration: ScaniIntegration;
      holdingsResult: Awaited<ReturnType<ScaniIntegration['fetchHoldings']>>;
      tokenMappings: Array<{
        holding: Awaited<ReturnType<ScaniIntegration['fetchHoldings']>>['holdings'][0];
        tokenMapping: Awaited<ReturnType<ScaniIntegration['mapToken']>>;
      }>;
      existingAccount: typeof schema.accounts.$inferSelect | null;
      accountName: string;
      error?: string;
    }> = [];

    const errors: ImportWalletResult['errors'] = [];

    for (const institutionId of detectedInstitutionIds) {
      try {
        logger.debug({ userId, institutionId }, 'Starting to process institution');

        const integration = await this.integrationManager.getIntegration(institutionId);

        if (!integration) {
          const error = {
            chainId: institutionId,
            chainName: 'Unknown',
            error: 'Integration not found',
          };
          errors.push(error);
          logger.warn({ userId, institutionId }, 'Integration not found for institution');
          continue;
        }

        // Get institution details
        const [institution] = await db
          .select()
          .from(schema.institutions)
          .where(eq(schema.institutions.id, institutionId))
          .limit(1);

        if (!institution) {
          const error = {
            chainId: institutionId,
            chainName: 'Unknown',
            error: 'Institution not found',
          };
          errors.push(error);
          logger.warn({ userId, institutionId }, 'Institution not found in database');
          continue;
        }

        // Get mapping to find chain info
        const mapping = await this.mappingRepository.findByInstitutionId(institutionId);

        if (!mapping) {
          const error = {
            chainId: institutionId,
            chainName: institution.name,
            error: 'Chain mapping not found',
          };
          errors.push(error);
          logger.warn(
            { userId, institutionId, institutionName: institution.name },
            'Chain mapping not found for institution'
          );
          continue;
        }

        logger.info(
          {
            userId,
            institutionId,
            institutionName: institution.name,
            chainId: mapping.chainId,
          },
          'Fetching blockchain holdings (SLOW external API call)'
        );

        // Check for existing account
        const accountName = this.generateAccountName(
          institution.name,
          input.displayName || input.address
        );

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

        const existingAccount: typeof schema.accounts.$inferSelect | null =
          existingAccounts.length > 0 ? existingAccounts[0]! : null;

        // EXTERNAL API CALL - Fetch holdings from blockchain (5-30 seconds each)
        const holdingsResult = await integration.fetchHoldings(input.address);

        logger.info(
          {
            userId,
            institutionId,
            institutionName: institution.name,
            holdingsCount: holdingsResult.holdings.length,
            errorsCount: holdingsResult.errors?.length || 0,
          },
          'Holdings fetched from blockchain'
        );

        if (holdingsResult.errors && holdingsResult.errors.length > 0) {
          logger.warn(
            {
              userId,
              institutionId: institution.id,
              errors: holdingsResult.errors,
            },
            'Errors fetching holdings from integration'
          );
        }

        // Map all tokens from external API (no DB connection held)
        const tokenMappings: Array<{
          holding: (typeof holdingsResult.holdings)[0];
          tokenMapping: Awaited<ReturnType<typeof integration.mapToken>>;
        }> = [];

        for (const holding of holdingsResult.holdings) {
          // Skip tokens with missing required data
          if (!holding.symbol || !holding.balance) {
            logger.warn(
              {
                userId,
                institutionName: institution.name,
                holding,
              },
              'Skipping holding with missing symbol or balance'
            );
            continue;
          }

          // Validate balance is a valid decimal string
          if (!isValidDecimalString(holding.balance)) {
            logger.warn(
              {
                userId,
                institutionName: institution.name,
                tokenSymbol: holding.symbol,
                balance: holding.balance,
              },
              'Skipping holding with invalid balance format'
            );
            continue;
          }

          try {
            // Map the integration holding to our token format (external API call)
            const tokenMapping = await integration.mapToken(holding);
            tokenMappings.push({ holding, tokenMapping });
          } catch (error) {
            logger.error(
              {
                userId,
                tokenSymbol: holding.symbol,
                institutionName: institution.name,
                error: error instanceof Error ? error.message : String(error),
              },
              'Failed to map token, skipping'
            );
          }
        }

        logger.info(
          {
            userId,
            institutionId,
            institutionName: institution.name,
            holdingsToProcess: tokenMappings.length,
          },
          'Token mappings prepared'
        );

        blockchainData.push({
          institutionId,
          institution,
          chainId: mapping.chainId,
          integration,
          holdingsResult,
          tokenMappings,
          existingAccount,
          accountName,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;

        logger.error(
          {
            userId,
            institutionId,
            error: errorMessage,
            stack: errorStack,
          },
          'Failed to fetch blockchain data for institution'
        );
        errors.push({
          chainId: institutionId,
          chainName: 'Unknown',
          error: errorMessage,
        });
      }
    }

    logger.info(
      { userId, institutionsWithData: blockchainData.length },
      'All blockchain data fetched, starting database transaction'
    );

    // STEP 3: ALL database operations in a SINGLE TRANSACTION
    const result = await withTransaction(
      async (tx) => {
        const accounts: ImportWalletResult['accounts'] = [];
        const holdings: ImportWalletResult['holdings'] = [];

        for (const chainData of blockchainData) {
          try {
            const {
              institutionId,
              institution,
              chainId,
              tokenMappings,
              existingAccount,
              accountName,
            } = chainData;

            let accountId: string;

            // Create or update account (within transaction)
            if (existingAccount) {
              accountId = existingAccount.id;
              await tx
                .update(schema.accounts)
                .set({
                  metadata: {
                    walletAddress: input.address,
                    chainId,
                    chainName: institution.name,
                    displayName: input.displayName,
                    lastSync: new Date().toISOString(),
                    userWalletId: userWallet.id,
                    migrated: true,
                  },
                  updatedAt: new Date(),
                })
                .where(eq(schema.accounts.id, accountId));

              logger.info(
                {
                  userId,
                  accountId,
                  userWalletId: userWallet.id,
                  institutionName: institution.name,
                },
                'Updated existing account with user_wallet_id'
              );
            } else {
              const [newAccount] = await tx
                .insert(schema.accounts)
                .values({
                  userId,
                  institutionId: institution.id,
                  name: accountName,
                  typeId: walletAccountType.id,
                  description: `Crypto wallet on ${institution.name}`,
                  metadata: {
                    walletAddress: input.address,
                    chainId,
                    chainName: institution.name,
                    displayName: input.displayName,
                    lastSync: new Date().toISOString(),
                    userWalletId: userWallet.id,
                    migrated: true,
                  },
                  isActive: true,
                })
                .returning();

              if (!newAccount) {
                throw new Error('Failed to create account');
              }

              accountId = newAccount.id;
              logger.info(
                {
                  userId,
                  accountId,
                  userWalletId: userWallet.id,
                  institutionName: institution.name,
                },
                'Created new account with user_wallet_id'
              );
            }

            // Store/update credentials if needed (within transaction)
            try {
              const existingCredentials = await this.integrationCredentialsService.getCredentials(
                userId,
                institution.id
              );

              if (!existingCredentials) {
                await this.integrationCredentialsService.storeCredentials(
                  userId,
                  institution.id,
                  { type: 'public_rpc' },
                  'rpc'
                );

                logger.debug(
                  { institutionId: institution.id },
                  'Stored public RPC credentials marker'
                );
              }
            } catch (error) {
              logger.debug(
                {
                  institutionId: institution.id,
                  error: error instanceof Error ? error.message : String(error),
                },
                'Failed to store credentials (non-critical)'
              );
            }

            // Process all holdings (within transaction)
            for (const { holding, tokenMapping } of tokenMappings) {
              try {
                logger.debug(
                  {
                    userId,
                    institutionName: institution.name,
                    tokenSymbol: holding.symbol,
                    balance: holding.balance,
                  },
                  'Processing holding'
                );

                // Find or create token (within transaction).
                // `wasCreated` tells us whether this import was the first
                // time the system encountered this token — used downstream
                // so the UI can offer "Mark as scam" for genuinely new
                // tokens only.
                const { token, wasCreated: tokenIsNew } =
                  await this.tokenService.findOrCreateTokenFromIntegrationMapping(
                    tokenMapping,
                    cryptoTokenType.id,
                    18, // Default decimals for EVM chains
                    tx
                  );

                logger.debug(
                  {
                    userId,
                    tokenId: token.id,
                    tokenSymbol: token.symbol,
                    tokenIsNew,
                    institutionName: institution.name,
                  },
                  'Token resolved'
                );

                // Check if holding already exists (within transaction, including hidden ones)
                const existingHolding = await this.holdingRepository.findByAccountAndToken(
                  accountId,
                  token.id,
                  userId,
                  undefined, // excludeId
                  tx, // transaction
                  true // includeHidden
                );

                if (existingHolding) {
                  // Update existing holding and unhide if it was hidden (within transaction)
                  await this.holdingService.updateHoldingWithEvent(
                    existingHolding.id,
                    {
                      balance: holding.balance,
                      isHidden: false, // Unhide if balance is non-zero
                      lastUpdated: new Date(),
                    },
                    baseCurrencyId
                      ? {
                          userId,
                          baseCurrencyId,
                        }
                      : undefined,
                    tx
                  );

                  logger.info(
                    {
                      userId,
                      holdingId: existingHolding.id,
                      tokenSymbol: token.symbol,
                      balance: holding.balance,
                      institutionName: institution.name,
                    },
                    'Updated existing holding'
                  );

                  holdings.push({
                    id: existingHolding.id,
                    accountId,
                    accountName,
                    chainName: institution.name,
                    tokenId: token.id,
                    tokenSymbol: token.symbol,
                    tokenName: token.name,
                    tokenIconUrl: token.iconUrl ?? null,
                    // Force-false: if the user already has a holding in this
                    // account for this token, the token is definitionally not
                    // new to the system.
                    tokenIsNew: false,
                    tokenScamProbability: token.isScamProbability ?? 0,
                    balance: holding.balance,
                    priceInBaseCurrency: null, // Enriched after warm-up
                  });
                } else {
                  // Create new holding (within transaction)
                  const newHolding = await this.holdingService.createHoldingWithEvent(
                    {
                      userId,
                      accountId,
                      tokenId: token.id,
                      balance: holding.balance,
                      source: 'blockchain',
                      eventContext: baseCurrencyId
                        ? {
                            baseCurrencyId,
                          }
                        : undefined,
                    },
                    tx
                  );

                  logger.info(
                    {
                      userId,
                      holdingId: newHolding.id,
                      tokenSymbol: token.symbol,
                      balance: holding.balance,
                      institutionName: institution.name,
                    },
                    'Created new holding'
                  );

                  holdings.push({
                    id: newHolding.id,
                    accountId,
                    accountName,
                    chainName: institution.name,
                    tokenId: token.id,
                    tokenSymbol: token.symbol,
                    tokenName: token.name,
                    tokenIconUrl: token.iconUrl ?? null,
                    tokenIsNew,
                    tokenScamProbability: token.isScamProbability ?? 0,
                    balance: holding.balance,
                    priceInBaseCurrency: null, // Enriched after warm-up
                  });
                }
              } catch (error) {
                logger.error(
                  {
                    userId,
                    tokenSymbol: holding?.symbol || 'unknown',
                    tokenName: holding?.name || 'unknown',
                    balance: holding?.balance || 'unknown',
                    institutionName: institution.name,
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                  },
                  'Failed to create holding for token'
                );
              }
            }

            logger.info(
              {
                userId,
                institutionId,
                institutionName: institution.name,
                holdingsCreated: holdings.length,
                holdingsProcessed: tokenMappings.length,
              },
              'Completed processing holdings for institution'
            );

            accounts.push({
              id: accountId,
              name: accountName,
              chainId,
              chainName: institution.name,
              institutionId: institution.id,
              institutionName: institution.name,
            });
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(
              {
                userId,
                institutionId: chainData.institutionId,
                error: errorMessage,
              },
              'Failed to process institution in transaction'
            );
            errors.push({
              chainId: chainData.institutionId,
              chainName: chainData.institution.name,
              error: errorMessage,
            });
          }
        }

        return { accounts, holdings };
      },
      {
        name: 'importWallet',
        timeout: 120000, // 120 seconds for large imports
      }
    );

    // Fetch prices for the newly imported tokens so the success response
    // reflects real USD values, rather than zeroes that only populate 0–30
    // minutes later when the pricing cron next runs.
    //
    // This is deliberately outside the transaction — it's best-effort, so
    // a rate-limited provider or a slow external API won't roll back the
    // user's import. If it fails or times out, the existing pricing cron
    // still picks the tokens up on its next scheduled run.
    //
    // `PricingService.getTokenPrices()` does two things we need:
    //   1. Fetches fresh prices from CoinGecko / DeFiLlama / etc., with
    //      internal rate limiting, deduplication, retries, and circuit
    //      breaking.
    //   2. Persists the results to `token_prices` via bulkUpsert, which
    //      is what the holdings query reads when rendering the UI.
    const prices = await this.warmTokenPricesForImport(userId, result.holdings);

    // Enrich holdings with prices from the warm-up pass
    const enrichedHoldings = result.holdings.map((h) => {
      const price = prices.get(h.tokenId);
      return {
        ...h,
        priceInBaseCurrency: price && price !== '0' ? price : null,
      };
    });

    // Compute wallet label: displayName > shortened address
    const walletLabel = this.computeWalletLabel(input.displayName, input.address);

    const finalResult: ImportWalletResult = {
      walletLabel,
      accounts: result.accounts,
      holdings: enrichedHoldings,
      chainsDetected: detectedInstitutionIds.length,
      tokensImported: result.holdings.length,
      errors,
    };

    logger.info(
      {
        userId,
        institutionsDetected: detectedInstitutionIds.length,
        accountsCreated: result.accounts.length,
        holdingsCreated: result.holdings.length,
        errorsCount: errors.length,
        success: result.accounts.length > 0 || result.holdings.length > 0,
      },
      'Wallet import completed with integrations'
    );

    return finalResult;
  }

  /**
   * Fetch and persist prices for the tokens we just imported so the UI
   * lands on the holdings list with real USD values rather than zeroes.
   *
   * Best-effort: any error here is logged but not rethrown. The import
   * itself has already committed. The whole pass is bounded by a timeout
   * so a rate-limited pricing provider can't make the import response
   * hang indefinitely — if the warm-up hasn't finished in WARM_UP_BUDGET_MS,
   * we return and the pricing cron picks up the slack on its next run.
   */
  private async warmTokenPricesForImport(
    userId: string,
    importedHoldings: ImportWalletResult['holdings']
  ): Promise<Map<string, string>> {
    const emptyPrices = new Map<string, string>();
    if (importedHoldings.length === 0) return emptyPrices;

    // Hard cap on how long we're willing to delay the import response to
    // warm prices. Chosen so a ~50-token wallet with healthy providers
    // comfortably finishes, but a stuck / rate-limited provider can't
    // make the user wait forever.
    const WARM_UP_BUDGET_MS = 15_000;

    const work = (async (): Promise<Map<string, string>> => {
      const uniqueTokenIds = Array.from(new Set(importedHoldings.map((h) => h.tokenId)));
      const tokens = await this.tokenRepository.findByIds(uniqueTokenIds);

      if (tokens.length === 0) return emptyPrices;

      // Resolve base currency once so prices are stored against the right
      // reference token. Fall back to USD — PricingService handles the
      // symbol lookup internally.
      const [user] = await db
        .select({ baseCurrencyId: schema.users.baseCurrencyId })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);

      let baseCurrencySymbol = 'USD';
      if (user?.baseCurrencyId) {
        const [baseToken] = await db
          .select({ symbol: schema.tokens.symbol })
          .from(schema.tokens)
          .where(eq(schema.tokens.id, user.baseCurrencyId))
          .limit(1);
        if (baseToken?.symbol) {
          baseCurrencySymbol = baseToken.symbol;
        }
      }

      logger.info(
        { userId, tokenCount: tokens.length, baseCurrencySymbol },
        'Warming prices for imported tokens'
      );

      const prices = await this.pricingService.getTokenPrices(
        tokens,
        baseCurrencySymbol,
        new Date()
      );

      const pricedCount = Array.from(prices.values()).filter((p) => p && p !== '0').length;

      logger.info(
        {
          userId,
          tokenCount: tokens.length,
          pricedCount,
          unpricedCount: tokens.length - pricedCount,
        },
        'Token price warm-up completed'
      );

      return prices;
    })();

    const timeout = new Promise<Map<string, string>>((resolve) => {
      setTimeout(() => {
        logger.warn(
          { userId, budgetMs: WARM_UP_BUDGET_MS },
          'Token price warm-up exceeded time budget — returning early, cron will backfill'
        );
        resolve(emptyPrices);
      }, WARM_UP_BUDGET_MS);
    });

    try {
      return await Promise.race([work, timeout]);
    } catch (error) {
      // Swallow — the cron will backfill later and the user still has a
      // successful import. We just lose the "see values immediately" UX.
      logger.warn(
        {
          userId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Token price warm-up failed (non-fatal — cron will backfill)'
      );
      return emptyPrices;
    }
  }

  /**
   * Compute the human-readable wallet label for the import result.
   * Priority: displayName (which may be ENS-resolved by the frontend) > shortened address.
   */
  private computeWalletLabel(displayName: string | undefined, address: string): string {
    if (displayName) return displayName;
    if (address.length > 20) {
      return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
    }
    return address;
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
