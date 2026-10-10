import type { DatabaseTransaction } from '@scani/db';
import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { FeedInputRepository } from '../../repositories/FeedInputRepository';
import type { IngestResult } from '../feeds/FeedIngestService';
import { BALANCE_RUN_LEDGER_SOURCES, ledgerOverlapMs } from './ledger-cadence';
import {
  type FetchedLedger,
  TransactionImportCoordinator,
  type TransactionImportResult,
} from './TransactionImportCoordinator';

/** A ledger read with a balance that wrote rows, for the worker to follow as an import. */
export interface LedgerWrite {
  readonly userId: string;
  readonly accountId: string;
  readonly result: TransactionImportResult;
}

export type LedgerRead =
  | { readonly kind: 'read'; readonly fetched: FetchedLedger }
  | { readonly kind: 'skipped'; readonly reason: 'no-ledger' | 'nightly' | 'never-read' }
  | { readonly kind: 'failed'; readonly error: unknown };

/**
 * The ledger read that rides a balance sync, so the balance and the rows that
 * explain it are written in one transaction (SC-1665). The balance is fetched
 * first and this second: a row posted between the two reads lands dated
 * after the balance anchor and counts once.
 */
@Service()
export class AccountLedgerSync {
  private readonly logger = createComponentLogger('service:AccountLedgerSync');
  private readonly coordinator = Container.get(TransactionImportCoordinator);
  private readonly feedInputs = Container.get(FeedInputRepository);

  async read(args: {
    userId: string;
    accountId: string;
    source: string | null;
  }): Promise<LedgerRead> {
    const { userId, accountId, source } = args;
    if (!source) return { kind: 'skipped', reason: 'no-ledger' };
    if (!BALANCE_RUN_LEDGER_SOURCES.has(source)) return { kind: 'skipped', reason: 'nightly' };
    const readThrough = await this.feedInputs.findLedgerReadThrough(accountId, source);
    // A first read is a full walk, and the nightly run owns those.
    if (!readThrough) return { kind: 'skipped', reason: 'never-read' };
    const since = new Date(readThrough.getTime() - ledgerOverlapMs(source));
    try {
      return {
        kind: 'read',
        fetched: await this.coordinator.fetch({ userId, accountId, source, since }),
      };
    } catch (error) {
      this.logger.warn(
        { accountId, source, error: error instanceof Error ? error.message : error },
        'Ledger read failed; the balance is written alone'
      );
      await this.coordinator.retractCompleteHistoryClaim(accountId, source);
      return { kind: 'failed', error };
    }
  }

  write(fetched: FetchedLedger, transaction: DatabaseTransaction): Promise<IngestResult> {
    return this.coordinator.write(fetched, transaction);
  }

  finish(fetched: FetchedLedger, ingested: IngestResult): Promise<TransactionImportResult> {
    return this.coordinator.finish(fetched, ingested);
  }
}
