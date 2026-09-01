/**
 * TransactionImportCoordinator
 *
 * Entry point for the `transaction-import` BullMQ processor. Given a
 * (userId, accountId, source) tuple:
 *   1. resolve the account + its credentials,
 *   2. map the source tag to a `@scani/providers` institution code,
 *   3. dispatch via `TransactionRouter` → registry's
 *      `TransactionsProvider.fetchTransactions(...)` →
 *      `TransactionEvent[]`,
 *   4. resolve identities + holdings via
 *      `TokenService.findOrCreateByIdentity` (the federated identity
 *      flow); persist as `NewHoldingTransaction[]`,
 *   5. update `holding_coverage`,
 *   6. run opening-balance reconciliation,
 *   7. report a summary so the processor can write it to user_jobs.
 *
 * Dispatch flows through `Container.get(ProviderRegistry).getTransactionsFetcher(institutionCode)`.
 */

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { ProviderError } from '@scani/providers/core/errors';
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import {
  describeMergedCoverageRows,
  HoldingCoverageRepository,
} from '../../repositories/HoldingCoverageRepository';
import {
  describeMergedRows,
  HoldingTransactionRepository,
} from '../../repositories/HoldingTransactionRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { OpeningBalanceReconciliationService } from '../holdings/OpeningBalanceReconciliationService';
import { IntegrationCredentialsService } from '../users/IntegrationCredentialsService';
import { TransactionRouter, type TransactionRouterResult } from './TransactionRouter';
import { NON_EVM_WALLET_SOURCES } from './transaction-source';
import { CEX_SOURCE_TO_INSTITUTION, isWalletDerivedSource } from './transaction-sources';

export interface TransactionImportInput {
  userId: string;
  accountId: string;
  /** Ingester source tag: 'etherscan', 'kraken-api', 'binance-api', … */
  source: string;
  /** Optional incremental-ingest cutoff. When omitted, full history. */
  since?: Date;
}

export interface TransactionImportResult {
  source: string;
  accountId: string;
  transactions: number;
  observations: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  hasCompleteTxHistory: boolean;
  warnings: string[];
  /** Always 'ok' when this resolves — anything else throws. */
  status: 'ok';
}

/**
 * Classified, known-unrecoverable failure thrown by the coordinator.
 * The processor wraps this in a BullMQ `UnrecoverableError` so the job
 * fails immediately (no retry budget burned) and is surfaced to the
 * user in /jobs as a failure with the original message.
 */
export class TransactionImportUnrecoverableError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'no-credentials'
      | 'no-ingester'
      | 'unsupported-source'
      | 'unsupported-chain'
      | 'missing-account-metadata'
      | 'missing-env'
  ) {
    super(message);
    this.name = 'TransactionImportUnrecoverableError';
  }
}

/**
 * EVM chain id → institution code mapping for the chains the new
 * Etherscan provider claims. Mirrors `ETHERSCAN_CHAINS` in
 * `@scani/providers/providers/etherscan/chains.ts`. A duplicate-of-
 * truth here is awkward but cheap; the only alternative is reaching
 * into the providers package's catalog at runtime, and a small inline
 * map keeps the coordinator decoupled from any one provider's
 * internal data structures.
 */
const EVM_CHAIN_ID_TO_INSTITUTION: Record<string, string> = {
  '1': 'ethereum',
  '56': 'bsc',
  '137': 'polygon',
  '43114': 'avalanche',
  '42161': 'arbitrum',
  '10': 'optimism',
  '8453': 'base',
  '250': 'fantom',
  '25': 'cronos',
  '42170': 'arbitrum-nova',
  '324': 'zksync-era',
  '534352': 'scroll',
  '59144': 'linea',
  '81457': 'blast',
  '5000': 'mantle',
  '204': 'opbnb',
  '100': 'gnosis',
  '42220': 'celo',
  '1284': 'moonbeam',
  '1285': 'moonriver',
};

/**
 * Map a source tag to the institution code the provider registry filter
 * dispatches by. CEX sources are static; EVM sources read the chain id
 * from `account.metadata.chainId`; non-EVM wallet sources are their own
 * institution code.
 *
 * The non-EVM branch reads `NON_EVM_WALLET_SOURCES`, which is derived
 * from the chain→source map `sourceForChainId` answers with. That is
 * deliberate and is the whole of SC-364: while the two lists were held
 * apart, a chain could be given a source tag with no branch here, and
 * the nightly sync would stop skipping the account cleanly and start
 * failing on it with `unsupported-source` instead. Derivation makes the
 * two halves impossible to land separately.
 */
export function resolveInstitutionCode(source: string, accountMetadata: unknown): string {
  if (source in CEX_SOURCE_TO_INSTITUTION) {
    return CEX_SOURCE_TO_INSTITUTION[source]!;
  }
  if (source === 'etherscan') {
    const meta = (accountMetadata ?? {}) as { chainId?: string | number };
    const chainId = meta.chainId;
    if (chainId === undefined || chainId === null) {
      throw new TransactionImportUnrecoverableError(
        'Account metadata missing chainId; cannot run EVM tx import.',
        'missing-account-metadata'
      );
    }
    const key = typeof chainId === 'number' ? String(chainId) : chainId;
    const institutionCode = EVM_CHAIN_ID_TO_INSTITUTION[key];
    if (!institutionCode) {
      throw new TransactionImportUnrecoverableError(
        `Chain ${chainId} is not a known active EVM chain.`,
        'unsupported-chain'
      );
    }
    return institutionCode;
  }
  if (NON_EVM_WALLET_SOURCES.has(source)) return source;
  throw new TransactionImportUnrecoverableError(
    `No provider wired for source '${source}'`,
    'unsupported-source'
  );
}

/**
 * The address a wallet-derived import must read, taken from the account
 * rather than from the credential row (SC-331).
 *
 * `user_integration_credentials` is UNIQUE on (user_id, institution_id),
 * so a user with three Ethereum wallets has exactly one Ethereum
 * credential and therefore one surviving address. Every Ethereum account
 * then imported whichever address won that row. In production every EVM
 * outflow carried the same `from`: a far smaller set of distinct on-chain
 * events fanned across every account on every wallet, so most of the rows
 * were copies of a transfer the account they sat on had never made.
 *
 * The balance side never had this bug because it does exactly what this
 * does — `SyncWalletBalancesUseCase.makeProviderCtx` synthesizes the
 * credential from the wallet's own address. This is that fix applied to
 * the transaction side.
 *
 * Absent metadata throws rather than falling back to the credential: the
 * fallback IS the bug, and it fails silently, by importing one real
 * wallet's real history onto another wallet's account.
 */
export function resolveImportWalletAddress(
  source: string,
  accountId: string,
  accountMetadata: unknown
): string | undefined {
  if (!isWalletDerivedSource(source)) return undefined;
  const meta = (accountMetadata ?? {}) as { walletAddress?: unknown };
  const walletAddress = typeof meta.walletAddress === 'string' ? meta.walletAddress.trim() : '';
  if (!walletAddress) {
    throw new TransactionImportUnrecoverableError(
      `Account ${accountId} has no metadata.walletAddress; refusing to run a wallet import that would read whichever address the shared ${source} credential happens to hold.`,
      'missing-account-metadata'
    );
  }
  return walletAddress;
}

@Service()
export class TransactionImportCoordinator {
  private readonly logger = createComponentLogger('service:TransactionImportCoordinator');

  // Class-field DI per the project's typedi conventions (see CLAUDE.md).
  private readonly holdingTransactionRepo = Container.get(HoldingTransactionRepository);
  private readonly observationRepo = Container.get(HoldingBalanceObservationRepository);
  private readonly coverageRepo = Container.get(HoldingCoverageRepository);
  private readonly reconciliation = Container.get(OpeningBalanceReconciliationService);
  private readonly credentialsService = Container.get(IntegrationCredentialsService);
  private readonly tokenRepo = Container.get(TokenRepository);
  private readonly router = Container.get(TransactionRouter);

  async execute(input: TransactionImportInput): Promise<TransactionImportResult> {
    try {
      return await this.run(input);
    } catch (error) {
      await this.retractCompleteHistoryClaim(input.accountId, input.source);
      throw error;
    }
  }

  /**
   * A run that failed must not leave the previous run's "we have the
   * whole ledger" claim standing (SC-168).
   *
   * `has_complete_tx_history` is written only by `persistAndReport`, on
   * the success path, so before this every throw above it left the flag
   * at whatever the last success wrote. SC-149 made that flag drive cost
   * basis, which turned a stale note into a confident figure computed
   * from data we know we could not read — six weeks of it on a Bybit
   * account whose importer failed on every run.
   *
   * Fired on *any* failure rather than only a terminal one, for two
   * reasons. The flag already means "as far as we know", and after a
   * failed attempt we do not know; an attempt that then succeeds writes
   * the claim straight back within the same job, so a transient blip is
   * a no-op end to end. And terminality lives in `WorkerClient`, which
   * is deliberately domain-free — routing it back here would buy a
   * strictly weaker guarantee (the flag would keep asserting
   * completeness for the whole retry window) for more machinery.
   *
   * Its own failure is swallowed: this is bookkeeping about a failure,
   * and it must not replace the failure the caller needs to see.
   */
  private async retractCompleteHistoryClaim(accountId: string, source: string): Promise<void> {
    try {
      const retracted = await this.coverageRepo.retractCompleteHistoryClaim(accountId, source);
      if (retracted > 0) {
        this.logger.warn(
          { accountId, source, holdings: retracted },
          'Import failed — retracted the complete-history claim it can no longer support'
        );
      }
    } catch (error) {
      this.logger.error(
        { accountId, source, error: error instanceof Error ? error.message : error },
        'Could not retract the complete-history claim after a failed import'
      );
    }
  }

  private async run(input: TransactionImportInput): Promise<TransactionImportResult> {
    const { userId, accountId, source, since } = input;

    // Fetch the account to confirm ownership and pick up its institutionId
    // (needed for credential lookup + identity dispatch).
    const accountRow = await db
      .select({
        id: schema.accounts.id,
        userId: schema.accounts.userId,
        institutionId: schema.accounts.institutionId,
        metadata: schema.accounts.metadata,
      })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .limit(1);
    const account = accountRow[0];
    if (!account) {
      throw new Error(`TransactionImport: account ${accountId} not found`);
    }
    if (account.userId !== userId) {
      throw new Error(`TransactionImport: account ${accountId} does not belong to user ${userId}`);
    }

    const institutionCode = resolveInstitutionCode(source, account.metadata);
    return this.runViaRegistry(
      userId,
      accountId,
      account.institutionId,
      source,
      institutionCode,
      resolveImportWalletAddress(source, accountId, account.metadata),
      since
    );
  }

  /**
   * Fetch transactions through the registry, materialize identities
   * + holdings, and persist. Throws when no provider claims the
   * institution code (which would only happen if a CEX was added to
   * the registry but its source tag wasn't added to
   * `CEX_SOURCE_TO_INSTITUTION` above).
   */
  private async runViaRegistry(
    userId: string,
    accountId: string,
    institutionId: string,
    source: string,
    institutionCode: string,
    walletAddress: string | undefined,
    since?: Date
  ): Promise<TransactionImportResult> {
    if (!this.router.hasProviderFor(institutionCode)) {
      throw new TransactionImportUnrecoverableError(
        `No transactions provider registered for institutionCode '${institutionCode}' (source='${source}'). Provider boot wiring may have skipped it.`,
        'no-ingester'
      );
    }

    // Validate creds exist + are non-expired before we burn an HTTP
    // call. The provider's `resolveCredentials` callback (which
    // delegates back to IntegrationCredentialsService) would also
    // throw, but that error fires deep inside the provider call
    // stack. Pre-checking here gives a cleaner unrecoverable failure.
    let creds: Record<string, unknown> | null = null;
    try {
      creds = await this.credentialsService.getDecryptedCredentials(userId, institutionId);
    } catch (error) {
      this.logger.warn(
        { institutionId, error: error instanceof Error ? error.message : error },
        'Credentials fetch failed'
      );
    }
    if (!creds) {
      throw new TransactionImportUnrecoverableError(
        `No stored credentials for institution ${institutionId}; reconnect the integration to re-run.`,
        'no-credentials'
      );
    }

    // Use USD as the provider context base currency. The tx import
    // path doesn't care about base currency for identity/holding
    // resolution — it only matters for `priceNative` events, where
    // the quote token comes from the event's `priceNative.quoteIdentity`
    // rather than the context. We still need a Token row though.
    const usdToken = await this.tokenRepo.findBySymbol('USD');
    if (!usdToken) {
      throw new Error('TransactionImport: USD token not seeded');
    }

    let routerResult: TransactionRouterResult;
    try {
      routerResult = await this.router.run({
        userId,
        accountId,
        institutionId,
        institutionCode,
        source,
        since,
        baseCurrency: usdToken,
        resolveCredentials: async (ref) => {
          const fresh = await this.credentialsService.getDecryptedCredentials(
            ref.userId,
            ref.institutionId
          );
          if (!fresh) {
            throw new Error(`No credentials for ${ref.userId}/${ref.institutionId}`);
          }
          // Pin the address to this account's wallet. Everything else the
          // credential holds (the user's own Etherscan API key, for one) is
          // per-institution and stays. See `resolveWalletAddress` (SC-331).
          return walletAddress ? { ...fresh, walletAddress, address: walletAddress } : fresh;
        },
      });
    } catch (error) {
      // Deliberately re-thrown unwrapped. `ProviderError` carries the
      // provider's own `kind`, and the processor reads it to decide retry
      // policy (SC-166) — wrapping it here would erase the one field that
      // decision is made from.
      this.logger.error(
        {
          source,
          institutionCode,
          accountId,
          kind: error instanceof ProviderError ? error.kind : undefined,
          error: error instanceof Error ? error.message : error,
        },
        'Provider fetchTransactions threw — the processor classifies it'
      );
      throw error;
    }

    return this.persistAndReport(userId, accountId, source, routerResult, since);
  }

  /**
   * Persist router output and return a compact summary. Result is
   * meant to be stored verbatim on the user_jobs row.
   */
  private async persistAndReport(
    _userId: string,
    accountId: string,
    source: string,
    result: TransactionRouterResult,
    since?: Date
  ): Promise<TransactionImportResult> {
    if (result.transactions.length > 0) {
      const written = await this.holdingTransactionRepo.bulkUpsert(result.transactions);
      // `bulkUpsert` must collapse rows sharing (holdingId, source,
      // externalId) — Postgres refuses a statement carrying the conflict
      // key twice — and until SC-349 the collapse was reported to nobody.
      // SC-341 lost 13 legs that way while all nine import jobs reported
      // `status: 'ok'`, `warnings: []` and `hasCompleteTxHistory: true`.
      //
      // It stays a warning rather than a failure: a source genuinely
      // re-sending one event inside one batch is legitimate, and throwing
      // would break correct imports. It also deliberately does not touch
      // `hasCompleteTxHistory` — retracting a standing claim on what may
      // be a legitimate merge is the same silent downgrade of cost basis
      // that `completenessIsClaimed` below exists to prevent.
      const merged = describeMergedRows(written.merges);
      if (merged) {
        result.warnings.push(
          `${source}: ${merged} If this source's externalId is not unique per event, those rows are lost.`
        );
      }
    }
    if (result.observations.length > 0) {
      await this.observationRepo.bulkAppend(result.observations);
    }

    // Coverage metadata — one row per holding touched in this run.
    // Every emitted tx carries a holdingId (enforced by
    // `TransactionRouter.materializeEvents`), so the set is derivable
    // without a secondary lookup.
    const uniqueHoldings = new Set<string>();
    for (const t of result.transactions) uniqueHoldings.add(t.holdingId);
    for (const o of result.observations) uniqueHoldings.add(o.holdingId);

    // What this run is entitled to state per holding: which source spoke,
    // and whether it believes it read the whole ledger.
    //
    // NOT the tx bounds. `result.firstEventAt` / `lastEventAt` are a
    // single min/max over every event in the run, across every holding —
    // a summary of the RUN, which is the right thing to report on the
    // user_jobs row below and the wrong thing to write to a holding. A
    // run importing BTC held since 2021 alongside a token first seen last
    // week used to stamp 2021 on both (SC-308). The bounds are derived
    // per holding from the ledger by `bulkUpsert` above; passing null
    // here is not a gap, because `LEAST`/`GREATEST` ignore nulls and so
    // leave that derivation standing.
    //
    // An incremental run makes NO completeness claim (see
    // `upsertManyFromIngester`) — `hasCompleteTxHistory` is false there
    // because the caller asked for a window, not because the ledger is
    // short, and passing that through would retract a full import's claim
    // every night.
    //
    // UNLESS THE PROVIDER RETRACTED, which is a different `false` and the
    // reason `historyRetractions` is carried separately from the boolean
    // (SC-395). "I was only asked for a window" is silence about the whole
    // ledger; "Kraken's own running balance does not add up over the
    // entries it returned" is evidence about it, and evidence outranks the
    // window the caller happened to choose. Kraken's audit is built to be
    // safe inside one: the first entry of an asset seeds the balance chain
    // rather than being checked against zero, and both legs of a two-legged
    // operation are stamped within 4.5ms of each other, so a `since`
    // boundary lands either side of a pair and never between it.
    const coverage = await this.coverageRepo.upsertManyFromIngester(
      [...uniqueHoldings].map((holdingId) => ({
        holdingId,
        firstTxAt: null,
        lastTxAt: null,
        txSources: [source],
        hasCompleteTxHistory: result.hasCompleteTxHistory,
      })),
      { completenessIsClaimed: !since || result.historyRetractions.length > 0 }
    );
    // The batch above is built from a `Set`, so no holding can repeat and
    // this is unreachable today. It is here because that is a property of
    // this caller and not of the method (SC-366): a second producer, or a
    // change to how the set is built, would otherwise drop a holding's
    // claim in silence. Like the ledger's collapse it is a warning and not
    // a failure, and it deliberately leaves `hasCompleteTxHistory` alone —
    // retracting a standing claim because one batch merged is the silent
    // cost-basis downgrade `completenessIsClaimed` exists to prevent.
    const mergedCoverage = describeMergedCoverageRows(coverage.merges);
    if (mergedCoverage) {
      result.warnings.push(
        `${source}: ${mergedCoverage} Only the last row's sources and completeness claim reached the table.`
      );
    }

    // Reconcile opening balances now that tx history is in the ledger.
    // Only for full-history runs — incremental `since` runs mustn't
    // synthesize opening_balance rows because the full history is by
    // definition missing.
    if (!since && uniqueHoldings.size > 0) {
      for (const holdingId of uniqueHoldings) {
        try {
          await this.reconciliation.reconcileHolding(holdingId);
        } catch (error) {
          result.warnings.push(
            `Reconciliation failed for holding ${holdingId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }

    // Reaching this line means the provider ran cleanly — any real
    // problem (no creds, no provider, unknown source) already threw
    // TransactionImportUnrecoverableError upstream. 0 transactions is
    // a legitimate success state (brand-new account with no history).
    return {
      source,
      accountId,
      transactions: result.transactions.length,
      observations: result.observations.length,
      firstEventAt: result.firstEventAt?.toISOString() ?? null,
      lastEventAt: result.lastEventAt?.toISOString() ?? null,
      hasCompleteTxHistory: result.hasCompleteTxHistory,
      warnings: result.warnings,
      status: 'ok',
    };
  }
}
