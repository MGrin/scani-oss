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
import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../repositories/HoldingBalanceObservationRepository';
import { HoldingCoverageRepository } from '../../repositories/HoldingCoverageRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { OpeningBalanceReconciliationService } from '../holdings/OpeningBalanceReconciliationService';
import { IntegrationCredentialsService } from '../users/IntegrationCredentialsService';
import { TransactionRouter, type TransactionRouterResult } from './TransactionRouter';

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
 * Source tag (the BullMQ payload field) → institution code (the
 * registry filter). Keeping the existing source tags lets the
 * persisted `holding_transactions.source` column stay stable for
 * dedup, while the registry sees the institution code its providers
 * registered for.
 */
const CEX_SOURCE_TO_INSTITUTION: Record<string, string> = {
  'kraken-api': 'kraken',
  'binance-api': 'binance',
  'bybit-api': 'bybit',
  'okx-api': 'okx',
  'coinbase-api': 'coinbase',
  'kucoin-api': 'kucoin',
  'gate-api': 'gate',
  'bitget-api': 'bitget',
  'huobi-api': 'huobi',
  'mexc-api': 'mexc',
  'bitstamp-api': 'bitstamp',
  'gemini-api': 'gemini',
  'ibkr-api': 'ibkr',
};

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

    const institutionCode = this.resolveInstitutionCode(source, account.metadata);
    return this.runViaRegistry(
      userId,
      accountId,
      account.institutionId,
      source,
      institutionCode,
      since
    );
  }

  /**
   * Map a source tag to the institution code the provider registry
   * filter dispatches by. CEX sources are static; EVM sources read
   * the chain id from `account.metadata.chainId`.
   */
  private resolveInstitutionCode(source: string, accountMetadata: unknown): string {
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
    // Non-EVM wallet sources whose institutionCode is the source tag
    // itself. The Solana provider (Helius API) registers under
    // 'solana' and exposes both BalanceProvider and TransactionsProvider.
    if (source === 'solana') return 'solana';
    throw new TransactionImportUnrecoverableError(
      `No provider wired for source '${source}'`,
      'unsupported-source'
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
          return fresh;
        },
      });
    } catch (error) {
      this.logger.error(
        {
          source,
          institutionCode,
          accountId,
          error: error instanceof Error ? error.message : error,
        },
        'Provider fetchTransactions threw — surfacing to BullMQ for retry'
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
      await this.holdingTransactionRepo.bulkUpsert(result.transactions);
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

    for (const holdingId of uniqueHoldings) {
      await this.coverageRepo.upsertFromIngester({
        holdingId,
        firstTxAt: result.firstEventAt,
        lastTxAt: result.lastEventAt,
        firstObservationAt: null,
        lastObservationAt: null,
        txSources: [source],
        hasCompleteTxHistory: result.hasCompleteTxHistory,
      });
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
