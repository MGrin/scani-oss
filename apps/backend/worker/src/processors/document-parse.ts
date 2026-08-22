import { isMissingObjectError, StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import type { Document } from '@scani/db/schema';
import { DocumentIngestionService, DocumentRetentionService } from '@scani/domain/services';
import { DOCUMENT_PARSE, type DocumentParseJob } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import {
  type ProcessorContext,
  UnrecoverableError,
  UserJobProcessor,
  userFacing,
} from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:document-parse');

interface DocumentParseResult {
  documentId: string;
  deduped: boolean;
  invoiceCount: number;
  upstreamCostUsd: number;
  extractions: Array<{
    id: string;
    vendorNameRaw: string;
    invoiceNumber: string | null;
    totalAmount: string | null;
    currencyCode: string | null;
  }>;
}

@Service()
export class DocumentParseProcessor extends UserJobProcessor<
  DocumentParseJob,
  DocumentParseResult
> {
  readonly descriptor = DOCUMENT_PARSE;

  protected async handle(
    data: DocumentParseJob,
    ctx: ProcessorContext
  ): Promise<DocumentParseResult> {
    const storage = Container.get(StorageFacade);
    const ingestion = Container.get(DocumentIngestionService);
    const retention = Container.get(DocumentRetentionService);

    await ctx.reportStatus('Reading uploaded document…');
    const buf = await this.readSource(storage, retention, data.r2Key);

    await ctx.reportStatus(
      data.reparseOf ? 'Re-reading with the current extractor…' : 'Checking for a duplicate…'
    );
    const result = await ingestion.ingest({
      userId: data.userId,
      bytes: new Uint8Array(buf),
      mimeType: data.mimeType,
      r2Key: data.r2Key,
      originalFilename: data.originalFilename,
      sourceKind: data.sourceKind,
      reparseOf: data.reparseOf,
    });

    if (!result.deduped) {
      await ctx.reportStatus('Extracting invoice data with AI…');
    }

    // Only a fresh read has an object worth promoting: a dedup matched a
    // document that was already retained (or predates retention), and a
    // re-parse read the retained key itself. `retain` is idempotent on
    // both, but skipping them keeps the intent legible.
    const document =
      result.deduped || data.reparseOf
        ? result.document
        : await this.retain(retention, result.document, ctx.job.id);

    logger.info(
      {
        jobId: ctx.job.id,
        documentId: document.id,
        deduped: result.deduped,
        invoiceCount: result.extractions.length,
        retainedKey: document.r2Key,
      },
      result.deduped ? 'Document deduped — no extraction performed' : 'Document parsed'
    );

    // The only delete in this method, and it is reached only by falling off
    // the success path — every throw above skips it. That placement is the
    // fix for the 2026-08-11 production failure: this used to be a blanket
    // `finally`, so a failed parse destroyed the file it was handed, and
    // then BullMQ's own retry (attempts: 2) and the UI's Retry button both
    // died on "The specified key does not exist". Every document-parse
    // failure was unretryable by construction.
    //
    // The cost of keeping a failed upload is one leaked temp object per
    // failure. Until SC-144 nothing ever reclaimed it — checked against the
    // live bucket on 2026-08-12 and 2026-08-14, `scani-job-uploads` carried
    // only the default multipart-abort rule. It now expires `temp/` at 30
    // days, chosen to outlast every path that still reads the key: this
    // job's own retries, and the user's Retry button, which re-runs with
    // this same `r2Key` and is bounded by a count rather than by time.
    //
    // Both conditions below are load-bearing.
    //
    // `isRetained(data.r2Key)` — a re-parse is handed a permanent key, and
    // so is any future caller that re-reads a stored file. Keying off where
    // the object lives makes "a retained file is never deleted by the parse
    // path" structural instead of a flag someone can forget.
    //
    // `document.r2Key !== data.r2Key` — when `retain` fails, the row is
    // never repointed and still holds the temp key. Deleting it then left a
    // document aimed at nothing, and every later re-parse threw
    // `The specified key does not exist.` Only the first guard existed, so
    // the parse path manufactured exactly the broken rows the retention
    // work was meant to eliminate.
    if (!retention.isRetained(data.r2Key) && document.r2Key !== data.r2Key) {
      void storage.delete(data.r2Key).catch(() => undefined);
    }

    return {
      documentId: document.id,
      deduped: result.deduped,
      invoiceCount: result.extractions.length,
      upstreamCostUsd: result.upstreamCostUsd,
      extractions: result.extractions.map((e) => ({
        id: e.id,
        vendorNameRaw: e.vendorNameRaw,
        invoiceNumber: e.invoiceNumber,
        totalAmount: e.totalAmount,
        currencyCode: e.currencyCode,
      })),
    };
  }

  private async retain(
    retention: DocumentRetentionService,
    document: Document,
    jobId: string | undefined
  ): Promise<Document> {
    try {
      return await retention.retain(document);
    } catch (error) {
      // The AI spend is already incurred and the extractions are written —
      // failing the job here would re-bill the same file on retry. The row
      // simply stays on its temp key, which the cleanup below then leaves
      // alone, so the file is still readable and a re-parse still works.
      // Only the promotion is lost, and `retain` is idempotent.
      logger.error(
        {
          jobId,
          documentId: document.id,
          r2Key: document.r2Key,
          error: error instanceof Error ? error.message : error,
        },
        'Document parsed but the file could not be retained'
      );
      return document;
    }
  }

  private async readSource(
    storage: StorageFacade,
    retention: DocumentRetentionService,
    r2Key: string
  ): Promise<Buffer> {
    try {
      return await storage.read(r2Key);
    } catch (error) {
      // Anything other than "the object is not there" — a 5xx, a dropped
      // connection, bad credentials — is a real incident: leave it raw so
      // BullMQ retries it and the terminal-failure hook alerts on it.
      if (!isMissingObjectError(error)) throw error;

      // The object is gone. No number of retries brings it back, so this
      // is `UnrecoverableError`: BullMQ stops immediately and the Sentry
      // hook skips it, while the user still sees the failure in the UI.
      // Sentry SCANI-WORKER-P was the missing half of this — only the
      // retained prefix was classified, so a missing temp object rethrew
      // `CloudError: The specified key does not exist.`, burned a second
      // doomed attempt, and paged us about a file that simply is not there.
      // `userFacing`: both sentences are written for the person who uploaded
      // the file and tell them what to do next. Unmarked, the owner would be
      // shown only the translated failure category (SC-551).
      throw userFacing(
        new UnrecoverableError(
          retention.isRetained(r2Key)
            ? 'The original file is no longer stored. Delete this document and upload it again.'
            : 'The uploaded file is no longer available. Please upload it again.'
        )
      );
    }
  }
}
