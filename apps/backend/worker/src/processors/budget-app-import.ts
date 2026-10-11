import { randomUUID } from 'node:crypto';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { getDb } from '@scani/db';
import {
  type BudgetAppImportOutcome,
  BudgetAppImportRefused,
  BudgetAppImportService,
  type BudgetAppImportSummary,
  type BudgetAppUndoOutcome,
  LearnedCategoryRules,
} from '@scani/domain/services';
import { parseBudgetAppRegister } from '@scani/file-import';
import {
  BUDGET_APP_IMPORT,
  BUDGET_APP_IMPORT_UNDO,
  type BudgetAppImportJob,
  type BudgetAppImportUndoJob,
  PORTFOLIO_HISTORY_BACKFILL,
  PORTFOLIO_HISTORY_LOOKBACK_DAYS,
} from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import {
  BullMqEnqueueService,
  type ProcessorContext,
  UnrecoverableError,
  UserJobProcessor,
  userFacing,
} from '@scani/queue';
import { Container, Service } from 'typedi';
import { readUpload } from '../lib/read-upload';
import { widenToEarliestWrite } from '../lib/rebuild-window';

const logger = createComponentLogger('processor:budget-app-import');

const REFUSALS: Record<BudgetAppImportRefused['reason'], string> = {
  'unknown-account': 'The file has no account by that name.',
  'account-not-found': 'One of the chosen accounts no longer exists.',
  'provider-fed':
    'One of the chosen accounts is fed by a connected provider or wallet, which already records these movements.',
  'unknown-currency': 'Scani has no currency with that code.',
  'unknown-account-type': 'That account type does not exist.',
};

const NOT_A_REGISTER: Record<BudgetAppImportJob['app'], string> = {
  ynab: "This is not a YNAB register. Export the plan from YNAB and upload the file whose name ends in 'Register'.",
  actual:
    'This is not an Actual Budget export. In Actual, open the account (or All accounts), choose Export, and upload that file.',
  mint: 'This is not a Mint export. Upload the transactions.csv file Mint exported.',
};

const NOT_READABLE: Record<string, string> = {
  'mixed-decimal-separators':
    'The amounts in this file use both a dot and a comma as the decimal point.',
  'ambiguous-dates':
    'The dates in this file fit both day-first and month-first. Choose the order and try again.',
};

async function rebuildHistory(
  userId: string,
  tokenIds: string[],
  earliestChangedAt: Date | null,
  jobId: string | undefined
): Promise<void> {
  if (!earliestChangedAt) return;
  try {
    await Container.get(BullMqEnqueueService).add(PORTFOLIO_HISTORY_BACKFILL, {
      userId,
      requestId: randomUUID(),
      tokenIds,
      lookbackDays: widenToEarliestWrite(
        PORTFOLIO_HISTORY_LOOKBACK_DAYS,
        earliestChangedAt.toISOString()
      ),
    });
  } catch (error) {
    logger.warn(
      { jobId, error: error instanceof Error ? error.message : String(error) },
      'Failed to enqueue the history rebuild after a budget app import (non-fatal)'
    );
  }
}

export interface BudgetAppImportResult {
  importId: string;
  summary: BudgetAppImportSummary;
}

/** Imports a YNAB, Actual Budget or Mint register the person mapped account by account (SC-1649). */
@Service()
export class BudgetAppImportProcessor extends UserJobProcessor<
  BudgetAppImportJob,
  BudgetAppImportResult
> {
  readonly descriptor = BUDGET_APP_IMPORT;

  protected async handle(
    data: BudgetAppImportJob,
    ctx: ProcessorContext
  ): Promise<BudgetAppImportResult> {
    const storage = Container.get(StorageFacade);
    await ctx.reportStatus('Reading your file…');
    const bytes = await readUpload(storage, data.r2Key);
    const parsed = parseBudgetAppRegister(
      new TextDecoder('utf-8').decode(bytes),
      data.app,
      data.dateOrder
    );
    if (parsed.kind !== 'parsed') {
      const reason =
        parsed.kind === 'not-a-register' ? NOT_A_REGISTER[data.app] : NOT_READABLE[parsed.kind];
      throw userFacing(new UnrecoverableError(`${reason} Nothing was imported.`));
    }

    await ctx.reportStatus('Importing your accounts…');
    let outcome: BudgetAppImportOutcome;
    try {
      outcome = await getDb().transaction((tx) =>
        Container.get(BudgetAppImportService).importRegister(
          {
            userId: data.userId,
            app: data.app,
            uploadRef: data.r2Key,
            // Fixed per upload, so a retry of this job records no second window.
            fetchedAt: new Date(ctx.job.timestamp),
            currency: data.currency.toUpperCase(),
            accounts: data.accounts,
            skippedRows: parsed.skipped,
          },
          parsed.accounts,
          tx
        )
      );
    } catch (error) {
      if (error instanceof BudgetAppImportRefused) {
        throw userFacing(new UnrecoverableError(`${REFUSALS[error.reason]} Nothing was imported.`));
      }
      throw error;
    }

    // After the commit: the categories this import brought teach the rows
    // from other sources (SC-1695). Logs its own failure; never fails the job.
    await Container.get(LearnedCategoryRules).afterImport(data.userId);
    await rebuildHistory(data.userId, outcome.tokenIds, outcome.earliestChangedAt, ctx.job.id);
    logger.info(
      {
        userId: data.userId,
        importId: outcome.importId,
        accounts: outcome.summary.accounts.length,
        transfersPaired: outcome.summary.transfersPaired,
      },
      'Budget app register imported'
    );
    return { importId: outcome.importId, summary: outcome.summary };
  }
}

/** Undoes one budget app upload (SC-1649). */
@Service()
export class BudgetAppImportUndoProcessor extends UserJobProcessor<
  BudgetAppImportUndoJob,
  BudgetAppUndoOutcome
> {
  readonly descriptor = BUDGET_APP_IMPORT_UNDO;

  protected async handle(
    data: BudgetAppImportUndoJob,
    ctx: ProcessorContext
  ): Promise<BudgetAppUndoOutcome> {
    await ctx.reportStatus('Undoing the import…');
    const outcome = await getDb().transaction((tx) =>
      Container.get(BudgetAppImportService).undo(data.userId, data.importId, tx)
    );
    if (!outcome) {
      throw userFacing(new UnrecoverableError('That import was already undone, or is not yours.'));
    }
    await rebuildHistory(data.userId, [], outcome.earliestChangedAt, ctx.job.id);
    return outcome;
  }
}
