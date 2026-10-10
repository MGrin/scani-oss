import { randomUUID } from 'node:crypto';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { getDb } from '@scani/db';
import type { Document, Token } from '@scani/db/schema';
import {
  describeMergedRows,
  TokenRepository,
  TokenTypeRepository,
  UserJobRepository,
} from '@scani/domain/repositories';
import {
  CsvColumnDetectionService,
  FeedIngestService,
  type IngestResult,
  LearnedCategoryRules,
  legacyStatementBatch,
  TransferReviewService,
  UploadedFileService,
} from '@scani/domain/services';
import { parseStatement } from '@scani/file-import';
import {
  type StatementClose,
  type StatementLine,
  type StatementPosition,
  StatementTransactionIngester,
  statementWarnings,
} from '@scani/ingesters';
import {
  FILE_IMPORT,
  type FileImportJob,
  PORTFOLIO_HISTORY_BACKFILL,
  PORTFOLIO_HISTORY_LOOKBACK_DAYS,
} from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService, type ProcessorContext, UserJobProcessor } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import type { CsvMapping } from '@scani/shared';
import { Container, Service } from 'typedi';
import { readUpload } from '../lib/read-upload';
import { widenToEarliestWrite } from '../lib/rebuild-window';
import { asJobFailure } from '../lib/request-refusal';

const logger = createComponentLogger('processor:file-import');

interface FileImportSummary {
  format: string;
  accountId: string;
  transactionCount: number;
  observationCount: number;
  holdingsCreated: string[];
  holdingsTouched: Array<{
    holdingId: string;
    tokenId: string;
    symbol: string;
    name: string;
    transactionCount: number;
    closingBalance: string | null;
    /** Where the holding's balance came from (SC-1324). `imported-rows` and
     *  `unknown` exist only for a holding this import created. */
    balanceFrom: 'statement-close' | 'imported-rows' | 'unknown' | 'unchanged';
    /** The sum the balance was set to, when `balanceFrom` is `imported-rows`. */
    rowsBalance: string | null;
  }>;
  warnings: string[];
  // Set when the file has no Currency column and parseStatement
  // didn't auto-detect one. The job-detail UI shows a currency picker
  // and re-enqueues file-import with `defaultCurrency` set; on retry
  // this branch is skipped because every row resolves through the
  // user's choice. Mutually exclusive with the populated-summary
  // fields above (counts are 0, lists empty when this is true).
  needsColumnMapping?: {
    r2Key: string;
    fileType: string;
    headers: string[];
    rowCount: number;
    defaultCurrency?: string;
    dateOrder?: FileImportJob['dateOrder'];
  };
  needsCurrency?: {
    customMapping?: CsvMapping;
    r2Key: string;
    fileType: string;
    // Carried so the currency re-parse keeps an order the user already chose.
    dateOrder?: 'day-first' | 'month-first';
    transactionCount: number;
    transactionPreview: Array<{
      date: string;
      description: string;
      amount: number;
      balance: number | null;
    }>;
  };
  // Set when nothing in the file says whether `03/04` is 3 April or 4 March
  // (SC-1291). The job-detail UI asks and re-enqueues with `dateOrder`; like
  // `needsCurrency`, nothing has been ingested.
  needsDateOrder?: {
    customMapping?: CsvMapping;
    r2Key: string;
    fileType: string;
    rowCount: number;
    samples: string[];
    defaultCurrency?: string;
  };
}

type FileImportResult = FileImportSummary;

@Service()
export class FileImportProcessor extends UserJobProcessor<FileImportJob, FileImportResult> {
  readonly descriptor = FILE_IMPORT;

  protected async handle(data: FileImportJob, ctx: ProcessorContext): Promise<FileImportResult> {
    const storage = Container.get(StorageFacade);
    const csvColumnDetection = Container.get(CsvColumnDetectionService);
    const ingester = Container.get(StatementTransactionIngester);

    await ctx.reportStatus('Reading uploaded file…');
    const buf = await readUpload(storage, data.r2Key);
    // Recorded and retained before parsing: a statement that failed to
    // import is precisely the file the user wants back, and recording
    // ahead of the currency gate means the `needsCurrency` early return
    // below doesn't lose it.
    //
    // The currency-picker retry consumes this same key a second time and
    // hits `UploadedFileService`'s content-hash lookup, so it reuses the
    // row rather than listing the upload twice.
    const document = await this.record(data, buf, ctx.job.id);
    // R2 keys are uploaded under `temp/file-import/{userId}/` which the
    // bucket lifecycle rule (24h) cleans up. We never delete the temp file
    // ourselves — that would race the currency-picker retry path, where
    // the same key is consumed twice (once for the picker pass that
    // returns `needsCurrency`, then again on the Apply mutation). If
    // the user clicks Apply twice (e.g. via browser back), each call
    // is idempotent at the DB layer (txns/observations dedup) and the
    // file stays alive until R2 sweeps it — by which point the retained
    // copy under `documents/` is the one that survives.
    await ctx.reportStatus(`Parsing ${data.fileType.toUpperCase()} statement…`);
    const parsed = await parseStatement(buf.toString('utf-8'), `import.${data.fileType}`, {
      aiColumnDetector: (headers, sampleRows) =>
        csvColumnDetection.detectColumns(data.userId, headers, sampleRows),
      dateOrder: data.dateOrder,
      customMapping: data.customMapping,
    });

    logger.info(
      {
        jobId: ctx.job.id,
        format: parsed.format,
        transactionCount: parsed.transactions.length,
        holdingCount: parsed.holdings.length,
        warnings: parsed.warnings.length,
      },
      'Statement parsed'
    );

    if (parsed.needsColumnMapping) {
      return {
        format: parsed.format,
        accountId: data.accountId,
        transactionCount: 0,
        observationCount: 0,
        holdingsCreated: [],
        holdingsTouched: [],
        warnings: parsed.warnings,
        needsColumnMapping: {
          ...parsed.needsColumnMapping,
          r2Key: data.r2Key,
          fileType: data.fileType,
          defaultCurrency: data.defaultCurrency,
          dateOrder: data.dateOrder,
        },
      };
    }

    // Date-order gate, ahead of the currency one: the preview that gate
    // shows is dates, and it cannot show them before their order is known.
    if (parsed.ambiguousDateOrder) {
      return {
        format: parsed.format,
        accountId: data.accountId,
        transactionCount: 0,
        observationCount: 0,
        holdingsCreated: [],
        holdingsTouched: [],
        warnings: parsed.warnings,
        needsDateOrder: {
          customMapping: data.customMapping,
          r2Key: data.r2Key,
          fileType: data.fileType,
          rowCount: parsed.ambiguousDateOrder.rowCount,
          samples: parsed.ambiguousDateOrder.samples,
          defaultCurrency: data.defaultCurrency,
        },
      };
    }

    // Currency-fallback gate: if the file has no Currency column and
    // parseStatement didn't auto-detect one, ask the user to pick one
    // before we ingest anything. Returning early here puts the job
    // into "needs review" state; the FileImportResult component
    // renders a picker and re-submits with `defaultCurrency`.
    const fallbackCurrency = (data.defaultCurrency ?? '').trim().toUpperCase();
    const detectedCurrency = (parsed.detectedCurrency ?? '').trim().toUpperCase();
    const anyRowHasCurrency = parsed.transactions.some((tx) => (tx.currency ?? '').trim() !== '');
    const hasCurrencyHint =
      anyRowHasCurrency || detectedCurrency.length > 0 || fallbackCurrency.length > 0;
    if (!hasCurrencyHint && parsed.transactions.length > 0) {
      return {
        format: parsed.format,
        accountId: data.accountId,
        transactionCount: 0,
        observationCount: 0,
        holdingsCreated: [],
        holdingsTouched: [],
        warnings: parsed.warnings,
        needsCurrency: {
          r2Key: data.r2Key,
          fileType: data.fileType,
          dateOrder: data.dateOrder,
          customMapping: data.customMapping,
          transactionCount: parsed.transactions.length,
          transactionPreview: parsed.transactions.slice(0, 5).map((tx) => ({
            date: tx.date.toISOString(),
            description: tx.description,
            amount: tx.amount,
            balance: tx.balance ?? null,
          })),
        },
      };
    }

    const statement = ingester.ingest({
      accountId: data.accountId,
      parseResult: parsed,
      defaultCurrency: fallbackCurrency || undefined,
    });
    const lines = statement.lines.filter((line): line is StatementLine => !('skipped' in line));
    const currencies = [
      ...new Set([
        ...lines.map((line) => line.currency),
        ...statement.closes.map((close) => close.currency),
      ]),
    ];
    const securities = statement.positions.map((position) => position.symbol);

    if (currencies.length > 0) {
      await ctx.reportStatus(
        `Resolving ${currencies.length} ${currencies.length === 1 ? 'currency' : 'currencies'}…`
      );
    }
    await ctx.reportStatus(
      `Ingesting ${parsed.transactions.length} ${parsed.transactions.length === 1 ? 'transaction' : 'transactions'}…`
    );
    await ctx.reportStatus('Saving transactions to your account…');

    // One transaction: the holdings, the rows, the close, the window and the
    // balances are all written or none is. A statement none of whose
    // currencies the catalog knows has nothing to write, so it records no
    // input and no window either: a window would claim a period nothing was
    // read for.
    //
    // The tokens the summary names are read in that transaction too. Read
    // after the commit, a failure would fail a job whose import had landed,
    // and the retry would find nothing changed and rebuild 400 days over rows
    // older than that (ruling R26).
    const imported = (await this.knowsAny(currencies, securities))
      ? await getDb()
          .transaction(async (tx) => {
            const ingested = await Container.get(FeedIngestService).ingest(
              legacyStatementBatch({
                userId: data.userId,
                accountId: data.accountId,
                result: statement,
                uploadRef: data.r2Key,
                // The same file is the same document, so it is the same fetch and
                // a second upload of it records no second window.
                fetchedAt: document?.createdAt ?? new Date(),
              }),
              tx
            );
            const tokens = await Container.get(TokenRepository).findByIds(
              ingested.holdings.map((h) => h.tokenId),
              tx
            );
            return { ingested, tokens };
          })
          // The feed write refuses an account the user does not have, and
          // refuses it again on the retry RETRY_HEAVY allows (SC-1545).
          .catch((error: unknown) => {
            throw asJobFailure(error, ctx.job.id);
          })
      : null;
    const ingested = imported?.ingested ?? null;
    const unknown = new Set(ingested ? ingested.skippedAssets.map((a) => a.symbol) : currencies);
    for (const symbol of unknown) {
      logger.warn(
        { jobId: ctx.job.id, symbol },
        'Statement currency not found in tokens table; rows for this currency will be skipped'
      );
    }
    const ambiguous = new Set(
      (ingested?.skippedAssets ?? []).filter((a) => a.ambiguous).map((a) => a.symbol)
    );
    const warnings = statementWarnings(statement, unknown, ambiguous);
    // A statement's synthetic externalId is built from the parsed row, so
    // two rows a bank genuinely repeated on one day collapse into one and
    // the import used to report only the surviving count (SC-349). The
    // merge is legitimate often enough that it must not fail the import —
    // but the user is the only one who can tell a real duplicate from a
    // row their statement lost.
    const merged = describeMergedRows(ingested?.merges ?? []);
    if (merged) {
      warnings.push(`${merged} Check the statement for genuinely repeated entries.`);
    }
    // A statement's payments carry the counterparty a destination rule is keyed
    // on, so an outflow to a marked destination is answered here, when it is
    // written, rather than by whoever reads the queue next (SC-1071).
    // Non-fatal: the nightly transfer-linking sweep applies whatever this missed.
    try {
      await Container.get(TransferReviewService).applyDisposalMarks(data.userId);
    } catch (err) {
      logger.warn(
        { jobId: ctx.job.id, error: err instanceof Error ? err.message : err },
        'Applying destination rules to imported statement rows failed (non-fatal)'
      );
    }

    // Counted as sent, a re-sent row included, as they always were.
    const written = lines.filter((line) => !unknown.has(line.currency));
    const closes = statement.closes.filter((close) => !unknown.has(close.currency));
    const positions = statement.positions.filter((position) => !unknown.has(position.symbol));
    const transactionCount = written.reduce((count, line) => count + line.rows.length, 0);
    const observationCount = closes.length + positions.length;
    const holdingsTouched = imported
      ? this.summarize(imported.ingested, imported.tokens, written, closes, positions)
      : [];

    // Auto-stamp `action_taken_at` — structured CSV imports have no
    // review step, so the /jobs sidebar would otherwise insist on
    // "1 to review" forever.
    const jobId = ctx.job.id;
    if (typeof jobId === 'string' && jobId.length > 0) {
      try {
        await Container.get(UserJobRepository).markActionTaken(data.userId, jobId);
      } catch (err) {
        logger.warn(
          { jobId, error: err instanceof Error ? err.message : err },
          'Failed to auto-stamp file-import actionTakenAt (non-fatal)'
        );
      }
    }

    if (transactionCount > 0) {
      // Before the app hears of the rows, so they arrive already categorized
      // where the person has picked for that payee (SC-1695). Never fails the job.
      await Container.get(LearnedCategoryRules).afterImport(data.userId);
    }
    if (transactionCount > 0 || positions.length > 0) {
      // The open app learns of the rows now; the chart follows when the
      // backfill below finishes (SC-1600). Fire-and-forget.
      try {
        emitEntityChange({
          entityType: 'holding',
          operationType: 'sync',
          userId: data.userId,
          data: { reason: 'file_import' },
        });
      } catch (err) {
        logger.warn(
          { jobId: ctx.job.id, error: err instanceof Error ? err.message : err },
          'Failed to announce file-import holdings (non-fatal)'
        );
      }
      const tokenIds = [...new Set(holdingsTouched.map((h) => h.tokenId))];
      try {
        await Container.get(BullMqEnqueueService).add(PORTFOLIO_HISTORY_BACKFILL, {
          userId: data.userId,
          requestId: randomUUID(),
          tokenIds,
          // A statement older than the chart window is rebuilt back to its
          // oldest changed row, rather than to the window's edge.
          lookbackDays: widenToEarliestWrite(
            PORTFOLIO_HISTORY_LOOKBACK_DAYS,
            ingested?.earliestChangedAt?.toISOString() ?? null
          ),
        });
      } catch (err) {
        logger.warn(
          { jobId: ctx.job.id, error: err instanceof Error ? err.message : err },
          'Failed to enqueue portfolio-history-backfill after file-import (non-fatal)'
        );
      }
    }

    return {
      format: parsed.format,
      accountId: data.accountId,
      transactionCount,
      observationCount,
      holdingsCreated: ingested?.createdHoldingIds ?? [],
      holdingsTouched,
      warnings,
    };
  }

  private async knowsAny(
    currencies: readonly string[],
    securities: readonly string[]
  ): Promise<boolean> {
    const tokens = Container.get(TokenRepository);
    for (const currency of currencies) {
      if (await tokens.findBySymbol(currency)) return true;
    }
    if (securities.length === 0) return false;
    const stock = await Container.get(TokenTypeRepository).findByCode('stock');
    if (!stock) return false;
    for (const symbol of securities) {
      if ((await tokens.findCatalogListingsOfType(symbol, stock.id)).length > 0) return true;
    }
    return false;
  }

  /** One line per holding the import wrote into, in the order the statement first named each. */
  private summarize(
    ingested: IngestResult,
    tokens: readonly Token[],
    written: readonly StatementLine[],
    closes: readonly StatementClose[],
    positions: readonly StatementPosition[]
  ): FileImportSummary['holdingsTouched'] {
    const anchors = [
      ...closes.map((close) => ({ symbol: close.currency, balance: close.balance })),
      ...positions.map((position) => ({ symbol: position.symbol, balance: position.quantity })),
    ];
    const created = new Set(ingested.createdHoldingIds);
    return ingested.holdings.flatMap((holding) => {
      const token = tokens.find((t) => t.id === holding.tokenId);
      if (!token) return [];
      // A statement currency or ticker is its catalog token's symbol.
      const close = anchors.find((anchor) => anchor.symbol === token.symbol);
      // A holding this import created, from a file with no balance column, has
      // no close to take. Its own rows are then the only evidence (SC-1324); a
      // holding that already existed keeps whatever its balance was.
      const fromRows = close === undefined && created.has(holding.holdingId);
      return [
        {
          holdingId: holding.holdingId,
          tokenId: token.id,
          symbol: token.symbol,
          name: token.name,
          transactionCount: written
            .filter((line) => line.currency === token.symbol)
            .reduce((count, line) => count + line.rows.length, 0),
          closingBalance: close?.balance ?? null,
          balanceFrom: close
            ? 'statement-close'
            : !fromRows
              ? 'unchanged'
              : holding.cacheBalance === null
                ? 'unknown'
                : 'imported-rows',
          rowsBalance: fromRows ? holding.cacheBalance : null,
        },
      ];
    });
  }

  /**
   * Never throws — the user's goal is the import, and a failed bookkeeping
   * write must not fail a statement that parsed cleanly. Null when the upload
   * could not be recorded.
   */
  private async record(
    data: FileImportJob,
    bytes: Buffer,
    jobId: string | undefined
  ): Promise<Document | null> {
    try {
      return await Container.get(UploadedFileService).record({
        userId: data.userId,
        purpose: 'file-import',
        bytes: new Uint8Array(bytes),
        mimeType: STATEMENT_MIME_TYPES[data.fileType] ?? 'application/octet-stream',
        r2Key: data.r2Key,
        // `fileImport.parseAndEnrich` carries the r2Key and a fileType, not
        // the name the user picked, so the presigned key's own filename is
        // the honest answer.
        // The presigned key is a uuid, so fall back to it only when the
        // enqueuer didn't carry the user's own filename through.
        originalFilename: data.originalFilename ?? data.r2Key.split('/').pop() ?? data.r2Key,
      });
    } catch (err) {
      logger.warn(
        { jobId, r2Key: data.r2Key, error: err instanceof Error ? err.message : err },
        'Statement upload could not be recorded (non-fatal)'
      );
      return null;
    }
  }
}

const STATEMENT_MIME_TYPES: Record<string, string> = {
  csv: 'text/csv',
  ofx: 'application/x-ofx',
  qif: 'application/x-qif',
};
