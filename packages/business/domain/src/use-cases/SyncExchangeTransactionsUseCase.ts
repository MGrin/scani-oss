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
 */

import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { AccountRepository } from '../repositories/AccountRepository';
import { InstitutionRepository } from '../repositories/InstitutionRepository';
import { UserIntegrationCredentialsRepository } from '../repositories/UserIntegrationCredentialsRepository';
import { sourceForProvider } from '../services/transactions/transaction-source';

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
  /** ISO-8601 lower bound for the incremental fetch. */
  since: string;
}

export interface SyncExchangeTransactionsResult {
  targets: TransactionSyncTarget[];
  /** Active accounts found across all syncable institutions. */
  accountsFound: number;
  /** Accounts skipped because their provider has no ingester source. */
  skippedNoSource: number;
  durationMs: number;
}

@Service()
export class SyncExchangeTransactionsUseCase {
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly credentialsRepository = Container.get(UserIntegrationCredentialsRepository);
  private readonly accountRepository = Container.get(AccountRepository);

  async execute(): Promise<SyncExchangeTransactionsResult> {
    const startTime = Date.now();
    const since = new Date(startTime - LOOKBACK_DAYS * DAY_MS).toISOString();

    const institutions = await this.institutionRepository.findSyncableInstitutions();

    const targets: TransactionSyncTarget[] = [];
    let accountsFound = 0;
    let skippedNoSource = 0;

    for (const institution of institutions) {
      const source = sourceForProvider(institution.name);
      const credentials = await this.credentialsRepository.findByInstitution(institution.id);

      for (const credential of credentials) {
        const accounts = await this.accountRepository.findByUser(credential.userId);
        for (const account of accounts) {
          if (account.institutionId !== institution.id || !account.isActive) continue;
          accountsFound++;
          if (!source) {
            skippedNoSource++;
            continue;
          }
          targets.push({
            userId: credential.userId,
            accountId: account.id,
            source,
            institutionId: institution.id,
            since,
          });
        }
      }
    }

    logger.info(
      { accountsFound, targets: targets.length, skippedNoSource },
      'Recurring transaction-sync targets computed'
    );
    return { targets, accountsFound, skippedNoSource, durationMs: Date.now() - startTime };
  }
}
