/**
 * SyncExchangeTransactionsUseCase
 *
 * Recurring refresh of integration transaction LEDGERS. The hourly
 * exchange-balances job refreshes current positions; nothing refreshed
 * the transaction history after the one-time import, so ledgers (e.g.
 * IBKR trades) went stale. This use case enumerates every syncable
 * account and returns one transaction-sync TARGET per account with an
 * incremental `since`. The worker's exchange-transactions processor
 * fans these out into `transaction-import` jobs (it owns the
 * `@scani/jobs` descriptor + the enqueue infra — domain must not depend
 * on `@scani/jobs`, which depends back on domain). Dedup on
 * (holding_id, source, external_id) makes re-ingest idempotent.
 *
 * Blockchain wallets are enumerated here too (SC-360). They were excluded
 * twice over — once by the institution filter, once by a source map with
 * no chain in it — so a wallet's ledger was written at import and never
 * again, while its balances stayed hourly-fresh and made the account look
 * healthy. Wallet accounts resolve their source from
 * `accounts.metadata.chainId` rather than the institution name.
 */

import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../repositories/AccountRepository';
import { HoldingTransactionRepository } from '../repositories/HoldingTransactionRepository';
import { InstitutionRepository } from '../repositories/InstitutionRepository';
import { UserIntegrationCredentialsRepository } from '../repositories/UserIntegrationCredentialsRepository';
import { sourceForChainId, sourceForProvider } from '../services/transactions/transaction-source';

const logger = createComponentLogger('use-case:sync-exchange-transactions');

// Rolling window re-fetched each run. Incremental providers (Kraken,
// Airwallex) only pull ~30d; IBKR ignores `since` and re-runs its full
// Flex query (idempotent via dedup). 30d comfortably covers the daily
// cadence plus late-settling transactions.
const LOOKBACK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** One account to refresh, with the ingester `source` + incremental cutoff. */
export interface TransactionSyncTarget {
  userId: string;
  accountId: string;
  /** Ingester tag (e.g. 'ibkr-api') the transaction-import job routes by. */
  source: string;
  institutionId: string;
  /**
   * ISO-8601 lower bound for the incremental fetch, or undefined to read
   * the whole ledger. Undefined only for an account that has no rows from
   * this source at all — see `attachSince`.
   */
  since?: string;
}

export interface SyncExchangeTransactionsResult {
  targets: TransactionSyncTarget[];
  /** Active accounts found across all syncable institutions. */
  accountsFound: number;
  /** Accounts skipped because their provider has no ingester source. */
  skippedNoSource: number;
  /** Targets emitted without a `since` because their ledger was empty. */
  fullHistoryTargets: number;
  durationMs: number;
}

interface Candidate {
  userId: string;
  accountId: string;
  source: string;
  institutionId: string;
}

@Service()
export class SyncExchangeTransactionsUseCase {
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly credentialsRepository = Container.get(UserIntegrationCredentialsRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly holdingTransactionRepository = Container.get(HoldingTransactionRepository);

  async execute(): Promise<SyncExchangeTransactionsResult> {
    const startTime = Date.now();

    const institutions = await this.institutionRepository.findTransactionSyncableInstitutions();

    const candidates: Candidate[] = [];
    let accountsFound = 0;
    let skippedNoSource = 0;

    for (const institution of institutions) {
      const providerSource = sourceForProvider(institution.name);
      const credentials = await this.credentialsRepository.findByInstitution(institution.id);

      for (const credential of credentials) {
        const accounts = await this.accountRepository.findByUser(credential.userId);
        for (const account of accounts) {
          if (account.institutionId !== institution.id || !account.isActive) continue;
          accountsFound++;
          // A wallet institution's name is a display string; its chain id
          // is what the coordinator dispatches on, and it lives on the
          // account because one user can hold several wallets per chain.
          const source = providerSource ?? sourceForChainId(chainIdOf(account.metadata));
          if (!source) {
            skippedNoSource++;
            continue;
          }
          candidates.push({
            userId: credential.userId,
            accountId: account.id,
            source,
            institutionId: institution.id,
          });
        }
      }
    }

    const targets = await this.attachSince(candidates, startTime);
    const fullHistoryTargets = targets.filter((t) => t.since === undefined).length;

    logger.info(
      { accountsFound, targets: targets.length, skippedNoSource, fullHistoryTargets },
      'Recurring transaction-sync targets computed'
    );
    return {
      targets,
      accountsFound,
      skippedNoSource,
      fullHistoryTargets,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Give each candidate its cutoff: the rolling window when the account
   * already has a ledger from this source, and NO cutoff when it does not.
   *
   * An incremental window is a statement about what changed since the last
   * read, and an account that has never been read has no last read. Solana
   * is the case that proves it: its whole history predates any window worth
   * running nightly, so a `since` on an empty ledger restores nothing and
   * keeps restoring nothing every night thereafter.
   *
   * One query per distinct source rather than per account — six sources are
   * live in production against twelve-plus accounts.
   */
  private async attachSince(
    candidates: readonly Candidate[],
    startTime: number
  ): Promise<TransactionSyncTarget[]> {
    const since = new Date(startTime - LOOKBACK_DAYS * DAY_MS).toISOString();
    const bySource = new Map<string, string[]>();
    for (const candidate of candidates) {
      const ids = bySource.get(candidate.source) ?? [];
      ids.push(candidate.accountId);
      bySource.set(candidate.source, ids);
    }

    const warm = new Map<string, Set<string>>();
    for (const [source, accountIds] of bySource) {
      warm.set(
        source,
        await this.holdingTransactionRepository.findAccountsWithLedgerFor(accountIds, source)
      );
    }

    return candidates.map((candidate) => ({
      ...candidate,
      since: warm.get(candidate.source)?.has(candidate.accountId) ? since : undefined,
    }));
  }
}

function chainIdOf(metadata: unknown): string | number | null {
  const meta = (metadata ?? {}) as { chainId?: unknown };
  const chainId = meta.chainId;
  if (typeof chainId === 'string' || typeof chainId === 'number') return chainId;
  return null;
}
