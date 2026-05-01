import { randomUUID } from 'node:crypto';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import {
  HoldingBalanceObservationRepository,
  HoldingRepository,
  HoldingTransactionRepository,
  TokenRepository,
  UserJobRepository,
} from '@scani/domain/repositories';
import { CsvColumnDetectionService, HoldingService } from '@scani/domain/services';
import { parseStatement } from '@scani/file-import';
import { StatementTransactionIngester } from '@scani/ingesters';
import { FILE_IMPORT, type FileImportJob, PORTFOLIO_HISTORY_BACKFILL } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService, type ProcessorContext, UserJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

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
  }>;
  warnings: string[];
  // Set when the file has no Currency column and parseStatement
  // didn't auto-detect one. The job-detail UI shows a currency picker
  // and re-enqueues file-import with `defaultCurrency` set; on retry
  // this branch is skipped because every row resolves through the
  // user's choice. Mutually exclusive with the populated-summary
  // fields above (counts are 0, lists empty when this is true).
  needsCurrency?: {
    r2Key: string;
    fileType: string;
    transactionCount: number;
    transactionPreview: Array<{
      date: string;
      description: string;
      amount: number;
      balance: number | null;
    }>;
  };
}

type FileImportResult = FileImportSummary;

@Service()
export class FileImportProcessor extends UserJobProcessor<FileImportJob, FileImportResult> {
  readonly descriptor = FILE_IMPORT;

  protected async handle(data: FileImportJob, ctx: ProcessorContext): Promise<FileImportResult> {
    const storage = Container.get(StorageFacade);
    const csvColumnDetection = Container.get(CsvColumnDetectionService);
    const tokenRepo = Container.get(TokenRepository);
    const holdingRepo = Container.get(HoldingRepository);
    const holdingService = Container.get(HoldingService);
    const txRepo = Container.get(HoldingTransactionRepository);
    const obsRepo = Container.get(HoldingBalanceObservationRepository);
    const ingester = Container.get(StatementTransactionIngester);

    await ctx.reportStatus('Reading uploaded file…');
    const buf = await storage.read(data.r2Key);
    // R2 keys are uploaded under `temp/file-import/{userId}/` which the
    // bucket lifecycle rule (24h) cleans up. We never delete the file
    // ourselves — that would race the currency-picker retry path, where
    // the same key is consumed twice (once for the picker pass that
    // returns `needsCurrency`, then again on the Apply mutation). If
    // the user clicks Apply twice (e.g. via browser back), each call
    // is idempotent at the DB layer (txns/observations dedup) and the
    // file stays alive until R2 sweeps it.
    await ctx.reportStatus(`Parsing ${data.fileType.toUpperCase()} statement…`);
    const parsed = await parseStatement(buf.toString('utf-8'), `import.${data.fileType}`, {
      aiColumnDetector: (headers, sampleRows) =>
        csvColumnDetection.detectColumns(headers, sampleRows),
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

    // Build the holding-by-currency map first. Each unique currency
    // in the parsed transactions resolves to a fiat token, then to
    // the user's holding for that token (find-or-create with balance
    // = 0; the actual balance lands via the closing-balance
    // observation the ingester emits). The resolution chain mirrors
    // the ingester's: per-row currency, then file-detected currency,
    // then user-supplied fallback.
    const uniqueCurrencies = new Set<string>();
    for (const tx of parsed.transactions) {
      const cur = (tx.currency || parsed.detectedCurrency || fallbackCurrency || '')
        .trim()
        .toUpperCase();
      if (cur) uniqueCurrencies.add(cur);
    }

    if (uniqueCurrencies.size > 0) {
      await ctx.reportStatus(
        `Resolving ${uniqueCurrencies.size} ${uniqueCurrencies.size === 1 ? 'currency' : 'currencies'}…`
      );
    }
    const holdingByCurrency = new Map<
      string,
      { holdingId: string; tokenId: string; symbol: string; name: string }
    >();
    const holdingsCreated: string[] = [];
    for (const symbol of uniqueCurrencies) {
      const token = await tokenRepo.findBySymbol(symbol);
      if (!token) {
        logger.warn(
          { jobId: ctx.job.id, symbol },
          'Statement currency not found in tokens table; rows for this currency will be skipped'
        );
        continue;
      }
      const existing = await holdingRepo.findByAccountAndToken(
        data.accountId,
        token.id,
        data.userId
      );
      if (existing) {
        holdingByCurrency.set(symbol, {
          holdingId: existing.id,
          tokenId: token.id,
          symbol: token.symbol,
          name: token.name,
        });
        continue;
      }
      // Skip the create-time sync-capture obs: we'll write the real one
      // via `updateHoldingBalance` once the ingester gives us the closing
      // balance. Without this skip, two sync-capture obs land at NOW
      // (placeholder 0 + real closing) within ~50ms; `findLatestAtOrAfter`
      // picks the earlier one (balance=0) and the chart goes to 0 for
      // every day between the statement's last row and import day.
      const created = await holdingService.createHoldingWithEvent({
        accountId: data.accountId,
        tokenId: token.id,
        balance: '0',
        userId: data.userId,
        source: 'statement-import',
        skipSyncCapture: true,
      });
      holdingByCurrency.set(symbol, {
        holdingId: created.id,
        tokenId: token.id,
        symbol: token.symbol,
        name: token.name,
      });
      holdingsCreated.push(created.id);
    }

    await ctx.reportStatus(
      `Ingesting ${parsed.transactions.length} ${parsed.transactions.length === 1 ? 'transaction' : 'transactions'}…`
    );
    const ingestResult = await ingester.ingest({
      userId: data.userId,
      accountId: data.accountId,
      parseResult: parsed,
      defaultCurrency: fallbackCurrency || undefined,
      resolveToken: {
        async resolveFiatTokenBySymbol(sym) {
          const upper = sym.trim().toUpperCase();
          const found = holdingByCurrency.get(upper);
          return found ? { holdingId: found.holdingId, tokenId: found.tokenId } : null;
        },
      },
    });

    // Write transactions + observations to the DB. Both are idempotent —
    // dedup keys are (holdingId, source, externalId) for transactions
    // and (holdingId, observedAt, source) for observations.
    await ctx.reportStatus('Saving transactions to your account…');
    await txRepo.bulkUpsert(ingestResult.transactions);
    await obsRepo.bulkAppend(ingestResult.observations);

    // Update each affected holding's `balance` column to the latest
    // observed close. Use HoldingService.updateHoldingBalance (not a
    // direct UPDATE) so a fresh sync-capture observation lands at NOW
    // with the correct value — without it, the stale balance=0
    // sync-capture written at holding-creation time stays as the
    // newest anchor and BalanceAtTimeService returns 0 for any date
    // between the statement's last day and today.
    const closingByHolding = new Map<string, string>();
    for (const obs of ingestResult.observations) {
      if (typeof obs.balance === 'string') {
        closingByHolding.set(obs.holdingId, obs.balance);
      }
    }
    for (const [holdingId, balance] of closingByHolding) {
      try {
        await holdingService.updateHoldingBalance(holdingId, balance);
      } catch (err) {
        logger.warn(
          { jobId: ctx.job.id, holdingId, error: err instanceof Error ? err.message : err },
          'Failed to update holding balance from statement close (non-fatal)'
        );
      }
    }

    const txCountByHolding = new Map<string, number>();
    for (const tx of ingestResult.transactions) {
      txCountByHolding.set(tx.holdingId, (txCountByHolding.get(tx.holdingId) ?? 0) + 1);
    }
    const holdingsTouched = [...holdingByCurrency.entries()].map(([_sym, info]) => ({
      holdingId: info.holdingId,
      tokenId: info.tokenId,
      symbol: info.symbol,
      name: info.name,
      transactionCount: txCountByHolding.get(info.holdingId) ?? 0,
      closingBalance: closingByHolding.get(info.holdingId) ?? null,
    }));

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

    if (ingestResult.transactions.length > 0) {
      const tokenIds = [...new Set(holdingsTouched.map((h) => h.tokenId))];
      try {
        await Container.get(BullMqEnqueueService).add(PORTFOLIO_HISTORY_BACKFILL, {
          userId: data.userId,
          requestId: randomUUID(),
          tokenIds,
          lookbackDays: 365,
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
      transactionCount: ingestResult.transactions.length,
      observationCount: ingestResult.observations.length,
      holdingsCreated,
      holdingsTouched,
      warnings: ingestResult.warnings,
    };
  }
}
