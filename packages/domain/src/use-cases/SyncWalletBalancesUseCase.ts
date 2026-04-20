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

import { db } from '@scani/db/connection';
import type { Account, Institution, User, UserWallet } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import type { FetchHoldingsResult } from '@scani/integrations';
import { IntegrationManager } from '@scani/integrations';
import { createComponentLogger } from '@scani/logging';
import { integrationCircuitBreaker, isValidDecimalString, withRetry } from '@scani/shared';
import Decimal from 'decimal.js';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import { AccountService } from '../services/AccountService';
import { HoldingService } from '../services/HoldingService';
import { TokenService } from '../services/TokenService';
import { UserWalletService } from '../services/UserWalletService';

const logger = createComponentLogger('use-case:sync-wallet-balances');

/** Page size for user iteration. Keeps peak memory bounded regardless of scale. */
const USER_PAGE_SIZE = 100;

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
  // Constructor injection — same rationale as ImportWalletAddressUseCase.
  constructor(
    private readonly integrationManager: IntegrationManager = Container.get(IntegrationManager),
    private readonly userWalletService: UserWalletService = Container.get(UserWalletService),
    private readonly accountService: AccountService = Container.get(AccountService),
    private readonly holdingService: HoldingService = Container.get(HoldingService),
    private readonly tokenService: TokenService = Container.get(TokenService),
    private readonly tokenTypeRepository: TokenTypeRepository = Container.get(TokenTypeRepository)
  ) {}

  async execute(): Promise<SyncWalletBalancesResult> {
    const startTime = Date.now();
    logger.info('Starting wallet balance sync for all blockchain accounts');

    // Fast-path: if no user has imported a wallet, skip the entire sync so
    // the scheduled job does zero DB + Redis work. Keeps Upstash free-tier
    // command count low while the app has only a handful of users.
    const [walletCountRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.userWallets);
    if (!walletCountRow || walletCountRow.count === 0) {
      logger.info({}, 'No user wallets found; skipping blockchain sync');
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

    // STEP 1 & 2 combined: iterate users in pages (keyset pagination on id)
    // and fetch blockchain data incrementally. This keeps peak memory bounded
    // regardless of user count, which matters once the user base grows beyond
    // a few hundred.
    const walletDataToSync: Array<{
      user: User;
      userWallet: UserWallet;
      institutionId: string;
      institution: Institution;
      account: Account;
      holdingsResult: FetchHoldingsResult;
    }> = [];

    // Keyset pagination cursor (id is uuid; lexicographic ordering is fine here).
    let cursor: string | null = null;
    type UserRow = typeof schema.users.$inferSelect;
    let pageUsers: UserRow[] = [];

    do {
      const query = cursor
        ? db
            .select()
            .from(schema.users)
            .where(gt(schema.users.id, cursor))
            .orderBy(asc(schema.users.id))
            .limit(USER_PAGE_SIZE)
        : db.select().from(schema.users).orderBy(asc(schema.users.id)).limit(USER_PAGE_SIZE);

      pageUsers = await query;
      if (pageUsers.length === 0) break;
      cursor = pageUsers[pageUsers.length - 1]?.id ?? null;

      for (const user of pageUsers) {
        // Get user's wallets
        const userWallets = await this.userWalletService.getUserWallets(user.id);

        // Pre-fetch the user's wallet-backed accounts once per user so we can
        // cheaply tell which `user_wallet` rows still have any accounts and
        // skip orphan rows. `AccountService.deleteAccount` hard-deletes the
        // wallet row when its last account is removed, but older rows from
        // before that fix landed may still exist — this is the belt-and-
        // suspenders layer that keeps them out of the sync loop regardless.
        const userAccounts = await db
          .select()
          .from(schema.accounts)
          .where(eq(schema.accounts.userId, user.id));
        const walletIdsWithAccounts = new Set<string>();
        for (const acc of userAccounts) {
          const meta = acc.metadata as Record<string, unknown> | null;
          const wid = meta?.userWalletId as string | undefined;
          if (wid) walletIdsWithAccounts.add(wid);
        }

        for (const userWallet of userWallets) {
          if (!walletIdsWithAccounts.has(userWallet.id)) {
            logger.debug(
              { userWalletId: userWallet.id },
              'Skipping orphan user_wallet with no associated accounts'
            );
            continue;
          }

          const institutionIds = (userWallet.institutionIds as string[]) || [];

          // NOTE: periodic chain re-detection was removed intentionally.
          //
          // The previous implementation ran `detectWalletChains` every 24
          // hours and merged any newly-detected chains into the wallet's
          // `institutionIds`. That created a bug where any chain the user
          // had explicitly deleted (via account deletion) would silently
          // come back after 24 hours, because re-detect would find it
          // and re-add it to the wallet, and the inner-loop auto-create
          // block would then resurrect the account.
          //
          // There's no way to distinguish "user removed this chain on
          // purpose" from "user has never seen this chain" without an
          // exclusion history, which would need a schema change. Until
          // we add that history, chain discovery is strictly an import-
          // time operation: the user re-imports the same wallet address
          // (idempotent via `findByUserAndAddress`) and the import flow
          // detects and merges any new chains into the existing wallet
          // row. See `ImportWalletAddressUseCase.executeWithIntegrations`.

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

              // Find the account that actually backs this (wallet, institution)
              // pair. If none exists, the user explicitly deleted it — DO NOT
              // resurrect it. The previous code auto-created a fresh account
              // here, which silently undid user deletions every time the sync
              // ran. If the user wants this chain back, they can re-import
              // the wallet address (the import flow merges new chains into
              // the existing wallet row idempotently).
              const syncAccount = accounts.find((acc) => {
                const metadata = acc.metadata as Record<string, unknown>;
                return metadata?.userWalletId === userWallet.id;
              });

              if (!syncAccount) {
                logger.debug(
                  {
                    userWalletId: userWallet.id,
                    institutionId,
                    walletAddress: userWallet.walletAddress.substring(0, 10),
                  },
                  'No account for this wallet+institution — skipping (user likely deleted it)'
                );
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

              // Circuit breaker: if this integration has been failing repeatedly,
              // bail out immediately instead of stacking up retries + backoffs.
              // Prevents one bad provider (e.g. a rate-limited exchange) from
              // blowing up the whole cron run's wall-clock time.
              if (!integrationCircuitBreaker.isAvailable(institutionId)) {
                logger.warn(
                  { institutionId, accountId: syncAccount.id },
                  'Integration circuit open — skipping wallet fetch'
                );
                accountsFailed++;
                continue;
              }

              // EXTERNAL API CALL - Fetch holdings from blockchain (no DB connection held).
              // Retries transient failures (network, 5xx, 429) with backoff.
              let holdingsResult: FetchHoldingsResult;
              try {
                holdingsResult = await withRetry(
                  () => integration.fetchHoldings(userWallet.walletAddress),
                  {
                    onRetry: (attempt, err) => {
                      logger.warn(
                        {
                          attempt,
                          accountId: syncAccount.id,
                          walletAddress: userWallet.walletAddress,
                          error: err instanceof Error ? err.message : String(err),
                        },
                        'Retrying wallet fetch after transient failure'
                      );
                    },
                  }
                );
                integrationCircuitBreaker.recordSuccess(institutionId);
              } catch (fetchErr) {
                integrationCircuitBreaker.recordFailure(institutionId);
                throw fetchErr;
              }

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
      } // end for (user of pageUsers)
    } while (pageUsers.length === USER_PAGE_SIZE);

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
                const { token } = await this.tokenService.findOrCreateTokenFromIntegrationMapping(
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

                if (new Decimal(balance).isZero()) {
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
