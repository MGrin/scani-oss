import type { NewHoldingBalanceObservation, NewHoldingTransaction } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { Service } from 'typedi';

export interface IngesterResult {
  transactions: NewHoldingTransaction[];
  observations: NewHoldingBalanceObservation[];
  coverage: CoverageUpdate;
  // Soft diagnostics — surfaced in the UI when rows were partially
  // dropped. Errors that abort ingestion should throw instead.
  warnings: string[];
}

export interface CoverageUpdate {
  firstEventAt: Date | null;
  lastEventAt: Date | null;
  // Drives `has_complete_tx_history` on holding_coverage. e.g. Etherscan
  // claims complete; screenshot claims only "what the image showed".
  hasCompleteTxHistory: boolean;
  // Surfaced on the result so the registry doesn't need to introspect
  // the ingester instance to label coverage rows.
  sourceTag: string;
}

export interface TransactionIngesterOptions {
  // Incremental cutoff. Provided after an initial backfill so re-runs
  // fetch only new events.
  since?: Date;
  // Exclusive upper bound. Rare; used by tests / partial backfills.
  until?: Date;
  // Provider-specific hints (e.g. Etherscan may accept `startBlock`).
  // Unknown hints are ignored.
  hints?: Record<string, unknown>;
}

export interface TransactionIngester {
  // Stable identifier (e.g. 'etherscan', 'binance-api', 'statement-csv-revolut').
  // Used for dedup on holding_transactions and for selective re-run / purge.
  readonly source: string;

  ingestForAccount(accountId: string, options: TransactionIngesterOptions): Promise<IngesterResult>;
}

@Service()
export class TransactionIngesterRegistry {
  private readonly logger = createComponentLogger('service:TransactionIngesterRegistry');
  private readonly ingesters = new Map<string, TransactionIngester>();

  register(ingester: TransactionIngester): void {
    if (this.ingesters.has(ingester.source)) {
      this.logger.warn(
        { source: ingester.source },
        'Overwriting existing TransactionIngester registration'
      );
    }
    this.ingesters.set(ingester.source, ingester);
    this.logger.info({ source: ingester.source }, 'Registered TransactionIngester');
  }

  get(source: string): TransactionIngester | null {
    return this.ingesters.get(source) ?? null;
  }

  require(source: string): TransactionIngester {
    const ing = this.get(source);
    if (!ing) {
      throw new Error(
        `No TransactionIngester registered for source '${source}'. Did the worker forget to import its wiring?`
      );
    }
    return ing;
  }

  list(): string[] {
    return [...this.ingesters.keys()];
  }
}
