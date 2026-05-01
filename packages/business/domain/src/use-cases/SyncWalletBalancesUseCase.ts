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
import { createComponentLogger } from '@scani/logging';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { HoldingSnapshot, ProviderContext } from '@scani/providers/core/types';
import { integrationCircuitBreaker, withRetry } from '@scani/rate-limiter';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import {
  AccountService,
  HoldingQueryService,
  HoldingsSyncHelper,
  UserWalletService,
  WalletDiscoveryService,
} from '../services';

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
    private readonly userWalletService: UserWalletService = Container.get(UserWalletService),
    private readonly accountService: AccountService = Container.get(AccountService),
    private readonly holdingQueryService: HoldingQueryService = Container.get(HoldingQueryService),
    private readonly tokenTypeRepository: TokenTypeRepository = Container.get(TokenTypeRepository),
    private readonly walletDiscovery: WalletDiscoveryService = Container.get(
      WalletDiscoveryService
    ),
    private readonly holdingsSyncHelper: HoldingsSyncHelper = Container.get(HoldingsSyncHelper)
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
      snapshots: HoldingSnapshot[];
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
              // Resolve the DB institutionId to the static institutionCode
              // the @scani/providers registry dispatches by ('ethereum',
              // 'bitcoin', etc.).
              const institutionCode =
                await this.walletDiscovery.resolveInstitutionCode(institutionId);
              const provider = institutionCode
                ? Container.get(ProviderRegistry).getBalanceFetcher(institutionCode)
                : null;

              if (!institutionCode || !provider) {
                logger.warn(
                  { institutionId, institutionCode, walletAddress: userWallet.walletAddress },
                  'No registered balance provider for this institution'
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
              let snapshots: HoldingSnapshot[];
              try {
                const ctx = makeProviderCtx({
                  institutionCode,
                  userId: user.id,
                  institutionId,
                  walletAddress: userWallet.walletAddress,
                });
                snapshots = await withRetry(() => provider.fetchBalances(ctx), {
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
                });
                integrationCircuitBreaker.recordSuccess(institutionId);
              } catch (fetchErr) {
                integrationCircuitBreaker.recordFailure(institutionId);
                throw fetchErr;
              }

              walletDataToSync.push({
                user,
                userWallet,
                institutionId,
                institution,
                account: syncAccount,
                snapshots,
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
            const { user, account, snapshots } = walletData;

            // Include hidden + scam-flagged holdings so the dedup map sees
            // every existing row; otherwise the helper would create
            // duplicates for tokens the user has explicitly hidden.
            const existingHoldings = await this.holdingQueryService.findByAccount(
              account.id,
              tx,
              true,
              true
            );

            const result = await this.holdingsSyncHelper.processSnapshotsForAccount({
              account,
              userId: user.id,
              userBaseCurrencyId: user.baseCurrencyId ?? null,
              snapshots,
              cryptoTokenTypeId,
              tokenTypeMap: { crypto: cryptoTokenTypeId },
              existingHoldings,
              staleStrategy: 'preserve',
              dedupStrategy: 'externalId',
              sourceTag: 'blockchain',
              defaultDecimals: 18,
              respectHiddenForCounts: true,
              skipUnchangedUpdates: false,
              // Recurring sync — refresh balances on existing holdings
              // only. Adding new tokens requires the user to re-import
              // the wallet and pick them in the review step.
              updateOnly: true,
              tx,
            });
            holdingsUpdated += result.updated;
            holdingsCreated += result.created;
            holdingsRemoved += result.removed;

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

/**
 * Build a provider context for a wallet-side balance fetch. Wallet
 * "credentials" are just the public address — we synthesize a
 * `resolveCredentials` callback that returns it. The synthetic USD
 * baseCurrency is fine here because chain providers don't actually
 * inspect baseCurrency — they return native-coin balances and ERC-20s
 * which the orchestrator prices later via PricingService.
 */
function makeProviderCtx(input: {
  institutionCode: string;
  userId: string;
  institutionId: string;
  walletAddress: string;
}): ProviderContext & {
  institutionCode: string;
  credentialsRef: NonNullable<ProviderContext['credentialsRef']>;
  resolveCredentials: NonNullable<ProviderContext['resolveCredentials']>;
} {
  return {
    baseCurrency: SYNTHETIC_BASE_CURRENCY,
    timestamp: new Date(),
    userId: input.userId,
    institutionCode: input.institutionCode,
    credentialsRef: { userId: input.userId, institutionId: input.institutionId },
    resolveCredentials: async () => ({ walletAddress: input.walletAddress }),
  };
}

/**
 * Synthetic baseCurrency for provider contexts that don't actually
 * consult it (chain-side balance fetches). Keeping it module-scoped
 * avoids re-allocating per call.
 */
const SYNTHETIC_BASE_CURRENCY: ProviderContext['baseCurrency'] = {
  id: 'synthetic-usd',
  symbol: 'USD',
  name: 'United States Dollar',
  typeId: 'fiat',
  decimals: 2,
  iconUrl: null,
  providerMetadata: {},
  isScamProbability: 0,
  isActive: true,
  marketSegment: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
