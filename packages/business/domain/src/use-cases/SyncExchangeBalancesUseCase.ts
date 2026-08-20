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

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import { ProviderError } from '@scani/providers/core/errors';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { HoldingSnapshot, ProviderContext } from '@scani/providers/core/types';
import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { deriveBalancesAsOf, withBalancesAsOf } from '../lib/balances-as-of';
import { TokenTypeRepository } from '../repositories/EnumRepositories';
import { HoldingRepository, type HoldingWithFullDetails } from '../repositories/HoldingRepository';
import { InstitutionRepository } from '../repositories/InstitutionRepository';
import {
  EXCHANGE_BALANCE_SYNC_SOURCE,
  ExpiredCredentialsError,
  HoldingsSyncHelper,
  IntegrationCredentialsService,
  WalletDiscoveryService,
} from '../services';

const logger = createComponentLogger('use-case:sync-exchange-balances');

export interface SyncExchangeBalancesResult {
  /** Total number of exchange accounts found */
  accountsFound: number;
  /** Number of accounts successfully synced */
  accountsSynced: number;
  /** Number of accounts that failed to sync */
  accountsFailed: number;
  /** Credentials skipped because the provider refused us and its window has
   *  not passed (SC-279). Reported so "we did not sync" and "we deliberately
   *  did not ask" are different numbers in the same summary. */
  credentialsBlocked: number;
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
/**
 * Is the provider still refusing this credential? (SC-279)
 *
 * Extracted so the decision can be tested without booting the whole sync —
 * the use case reads the global `db` directly, so the branch is otherwise
 * only reachable through an integration harness, and this is the branch whose
 * absence kept an IBKR lockout alive for four hours.
 *
 * The contract is stronger than backoff: while this returns true the caller
 * must not contact the provider for this credential AT ALL. For a lockout the
 * attempt is itself the harm.
 */
export function isSyncBlocked(
  credential: { syncBlockedUntil: Date | null },
  now: Date = new Date()
): boolean {
  return (
    credential.syncBlockedUntil !== null && credential.syncBlockedUntil.getTime() > now.getTime()
  );
}

@Service()
export class SyncExchangeBalancesUseCase {
  private readonly walletDiscovery = Container.get(WalletDiscoveryService);
  private readonly integrationCredentialsService = Container.get(IntegrationCredentialsService);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly holdingsSyncHelper = Container.get(HoldingsSyncHelper);
  private readonly institutionRepository = Container.get(InstitutionRepository);

  async execute(): Promise<SyncExchangeBalancesResult> {
    const startTime = Date.now();
    logger.info('Starting exchange balance sync for all exchange accounts');

    const errors: SyncExchangeBalancesResult['errors'] = [];
    let accountsSynced = 0;
    let accountsFailed = 0;
    let credentialsBlocked = 0;
    let holdingsUpdated = 0;
    let holdingsCreated = 0;
    let holdingsRemoved = 0;

    try {
      // STEP 1: Fetch ALL external data first (no DB connections held during API calls)

      // Get token types (crypto for exchanges, fiat/stock for brokers like IBKR)
      const cryptoTokenType = await this.tokenTypeRepository.findByCode('crypto');
      const fiatTokenType = await this.tokenTypeRepository.findByCode('fiat');
      const stockTokenType = await this.tokenTypeRepository.findByCode('stock');

      if (!cryptoTokenType) {
        throw new Error('Token type "crypto" not found');
      }

      const tokenTypeMap: Record<string, string> = {
        crypto: cryptoTokenType.id,
        fiat: fiatTokenType?.id ?? cryptoTokenType.id,
        stock: stockTokenType?.id ?? cryptoTokenType.id,
      };

      // Self-maintaining selection: institutions a user connected that aren't
      // blockchain wallets. See InstitutionRepository.findSyncableInstitutions.
      const exchangeInstitutions = await this.institutionRepository.findSyncableInstitutions();

      if (exchangeInstitutions.length === 0) {
        logger.info('No credentialed non-wallet institutions to sync');
        return {
          accountsFound: 0,
          accountsSynced: 0,
          accountsFailed: 0,
          credentialsBlocked: 0,
          holdingsUpdated: 0,
          holdingsCreated: 0,
          holdingsRemoved: 0,
          errors: [],
          durationMs: Date.now() - startTime,
        };
      }

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
        snapshots: HoldingSnapshot[];
        existingHoldingsWithDetails: HoldingWithFullDetails[];
      }

      const allAccountHoldingsData: AccountHoldingsData[] = [];

      // Fetch data for all institutions and accounts
      for (const institution of exchangeInstitutions) {
        try {
          const institutionId = institution.id;
          const institutionName = institution.name;

          logger.debug({ institutionId, institutionName }, 'Processing exchange institution');

          // Resolve the institutionCode the new @scani/providers
          // registry dispatches by, then pull the BalanceProvider.
          const institutionCode =
            (await this.walletDiscovery.resolveInstitutionCode(institutionId)) ??
            institutionName.toLowerCase();
          const provider = Container.get(ProviderRegistry).getBalanceFetcher(institutionCode);

          if (!provider) {
            logger.warn(
              { institutionId, institutionName, institutionCode },
              'No registered balance provider for institution, skipping'
            );
            continue;
          }

          // Find all users with credentials for this institution
          const credentials = await db
            .select()
            .from(schema.userIntegrationCredentials)
            .where(
              and(
                eq(schema.userIntegrationCredentials.institutionId, institutionId),
                // `isActive = false` is how a credential is disconnected
                // (IntegrationCredentialsService.deleteCredentials). Every
                // other read path already filters on it; this one did not,
                // so a disconnected integration was still contacted hourly.
                eq(schema.userIntegrationCredentials.isActive, true)
              )
            );

          if (credentials.length === 0) {
            logger.debug({ institutionId }, 'No credentials found for institution');
            continue;
          }

          logger.debug(
            { institutionId, credentialsCount: credentials.length },
            'Found credentials for institution'
          );

          // Sync accounts for each user — credentials within an
          // institution are independent, so process them in bounded
          // concurrency batches instead of strictly one user at a time.
          const CREDENTIAL_CONCURRENCY = 8;
          const processCredential = async (
            userCredential: (typeof credentials)[number]
          ): Promise<void> => {
            // A provider that refused us with a window attached must not be
            // contacted again inside it (SC-279). For IBKR Flex 1025 the
            // attempt IS the harm: the lockout is triggered by repeated
            // failure, so an hourly retry refreshes the counter that has to
            // age out — the schedule was what sustained it. Skipping is the
            // whole remedy, and it is deliberately checked before anything
            // reads credentials or touches the network.
            if (isSyncBlocked(userCredential)) {
              credentialsBlocked++;
              logger.warn(
                {
                  credentialsId: userCredential.id,
                  institutionId,
                  blockedUntil: userCredential.syncBlockedUntil?.toISOString(),
                  lastError: userCredential.syncLastError,
                  failureCount: userCredential.syncFailureCount,
                },
                'Skipping credential — provider refused us and the window has not passed'
              );
              return;
            }

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
              return;
            }

            logger.debug(
              { userId: userCredential.userId, accountsCount: accounts.length },
              'Syncing accounts for user'
            );

            // Get decrypted credentials. ExpiredCredentialsError must be
            // caught here (per-user), not at the institution scope — otherwise
            // one user's expired token aborts balance sync for every remaining
            // user on the same institution for the rest of this cron run.
            let decryptedCredentials: Record<string, unknown> | null;
            try {
              decryptedCredentials =
                await this.integrationCredentialsService.getDecryptedCredentials(
                  userCredential.userId,
                  institutionId
                );
            } catch (error) {
              if (error instanceof ExpiredCredentialsError) {
                logger.warn(
                  {
                    userId: userCredential.userId,
                    institutionId,
                    expiresAt: error.expiresAt,
                  },
                  'Skipping user: integration credentials expired'
                );
                return;
              }
              throw error;
            }

            if (!decryptedCredentials) {
              logger.warn(
                { userId: userCredential.userId, institutionId },
                'Failed to decrypt credentials'
              );
              return;
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
                    : `${institutionName.toLowerCase()}-api-account`;

                const externalId = `${accountType}_${accountUid}`;

                logger.debug(
                  { accountId: account.id, externalId },
                  'Fetching holdings from external API'
                );

                // Fetch current holdings from exchange (EXTERNAL API CALL)
                // Timeout after 30 seconds to prevent hanging on unresponsive APIs.
                const ctx = makeProviderCtx({
                  institutionCode,
                  userId: userCredential.userId,
                  institutionId,
                  decryptedCredentials,
                });
                const snapshots = await Promise.race([
                  provider.fetchBalances(ctx),
                  new Promise<HoldingSnapshot[]>((_, reject) =>
                    setTimeout(
                      () => reject(new Error(`API timeout fetching ${institutionName} holdings`)),
                      30_000
                    )
                  ),
                ]);

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

                allAccountHoldingsData.push({
                  account,
                  userId: userCredential.userId,
                  userBaseCurrencyId: user?.baseCurrencyId ?? null,
                  institutionId,
                  snapshots,
                  existingHoldingsWithDetails,
                });

                // The provider answered, so whatever it was refusing is over
                // (SC-279). The lockout is per token, not per account, so one
                // success is enough to clear it. The repository only writes
                // when there is something to clear, so this is a no-op on the
                // overwhelming majority of hourly runs.
                if (
                  userCredential.syncBlockedUntil ||
                  userCredential.syncLastError ||
                  userCredential.syncFailureCount > 0
                ) {
                  await this.integrationCredentialsService
                    .clearSyncRefusal(userCredential.id)
                    .catch(() => {
                      /* bookkeeping must never fail a successful sync */
                    });
                }
              } catch (error) {
                accountsFailed++;
                const message = error instanceof Error ? error.message : String(error);
                logger.error(
                  { accountId: account.id, error: message },
                  'Failed to fetch holdings for account'
                );

                // Put the refusal in the ROW, not only in the log (SC-279).
                // `import_last_error` was null and `import_status` was
                // `enqueued` while IBKR was actively refusing us, so admin,
                // the UI and a human triaging all saw a healthy integration —
                // instance 14 of the absence-vs-refusal class. `sync_*` rather
                // than `import_*` because the reconciler abandons a credential
                // on `import_retry_count`, and an hourly balance failure must
                // not spend that budget.
                const retryAfterMs =
                  error instanceof ProviderError ? error.retryAfterMs : undefined;
                await this.integrationCredentialsService
                  .recordSyncRefusal(
                    userCredential.id,
                    message,
                    retryAfterMs ? new Date(Date.now() + retryAfterMs) : null
                  )
                  .catch((writeError: unknown) => {
                    // Never let bookkeeping mask the sync failure itself.
                    logger.warn(
                      {
                        credentialsId: userCredential.id,
                        error:
                          writeError instanceof Error ? writeError.message : String(writeError),
                      },
                      'Could not record sync refusal on the credential row'
                    );
                  });

                errors.push({
                  accountId: account.id,
                  accountName: account.name || 'Unknown',
                  institutionId,
                  error: message,
                });
              }
            }
          };

          for (let i = 0; i < credentials.length; i += CREDENTIAL_CONCURRENCY) {
            await Promise.all(
              credentials.slice(i, i + CREDENTIAL_CONCURRENCY).map(processCredential)
            );
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
              const { account, snapshots, existingHoldingsWithDetails } = accountData;
              const existingHoldings = existingHoldingsWithDetails.map((h) => h.holding);

              const result = await this.holdingsSyncHelper.processSnapshotsForAccount({
                account: { id: account.id, userId: account.userId },
                userId: account.userId,
                userBaseCurrencyId: accountData.userBaseCurrencyId,
                snapshots,
                cryptoTokenTypeId: cryptoTokenType.id,
                tokenTypeMap,
                existingHoldings,
                staleStrategy: 'zero',
                dedupStrategy: 'tokenId',
                sourceTag: EXCHANGE_BALANCE_SYNC_SOURCE,
                defaultDecimals: 8,
                respectHiddenForCounts: false,
                skipUnchangedUpdates: true,
                // Exchange sync auto-creates new tokens (a deposit on
                // the exchange should appear in the user's portfolio).
                // Only the wallet recurring sync is locked down.
                updateOnly: false,
                arrival: 'auto_discovered',
                tx,
              });
              holdingsUpdated += result.updated;
              holdingsCreated += result.created;
              holdingsRemoved += result.removed;

              // Two claims, deliberately separate (SC-384). `lastSync` is when
              // we reached the source; `balancesAsOf` is the moment the
              // source's answer describes, and exists only when a provider
              // told us they differ. For every live-balance venue that is
              // never, and `withBalancesAsOf` clears the key rather than
              // leaving yesterday's explanation attached to today's figures.
              const updatedMetadata = {
                ...withBalancesAsOf(account.metadata, deriveBalancesAsOf(snapshots)),
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
          credentialsBlocked,
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
        credentialsBlocked,
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

/**
 * Build a provider context for a CEX-side balance fetch. Pulls
 * decrypted credentials through a synchronous resolver — they're
 * already decrypted at this point (the use case loads them once per
 * user-credential row).
 */
function makeProviderCtx(input: {
  institutionCode: string;
  userId: string;
  institutionId: string;
  decryptedCredentials: Record<string, unknown>;
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
    resolveCredentials: async () =>
      input.decryptedCredentials as Awaited<
        ReturnType<NonNullable<ProviderContext['resolveCredentials']>>
      >,
  };
}

const SYNTHETIC_BASE_CURRENCY: ProviderContext['baseCurrency'] = {
  id: 'synthetic-usd',
  symbol: 'USD',
  name: 'United States Dollar',
  typeId: 'fiat',
  decimals: 2,
  iconUrl: null,
  providerMetadata: {},
  isScamProbability: 0,
  scamScoreVersion: null,
  scamScoreSource: 'heuristic',
  isActive: true,
  marketSegment: null,
  lookalikeOf: null,
  unpriceableUntil: null,
  lastPricingAttemptAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
