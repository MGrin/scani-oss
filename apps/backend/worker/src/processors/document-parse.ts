import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import type { Document } from '@scani/db/schema';
import { DocumentIngestionService, DocumentRetentionService } from '@scani/domain/services';
import { DOCUMENT_PARSE, type DocumentParseJob } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { type ProcessorContext, UserJobProcessor } from '@scani/queue';
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

    try {
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
    } finally {
      // Exactly one delete, and only ever of the temp upload. `retain`
      // COPIES to the permanent key rather than moving, so the object this
      // job was handed is still the temp one and cleaning it up here is
      // what completes the promotion.
      //
      // The guard is the retained-prefix test rather than `!data.reparseOf`
      // on purpose: a re-parse is handed a permanent key, and so is any
      // future caller that re-reads a stored file. Keying the decision off
      // where the object lives makes "a retained file is never deleted by
      // the parse path" structural instead of a flag someone can forget.
      if (!retention.isRetained(data.r2Key)) {
        void storage.delete(data.r2Key).catch(() => undefined);
      }
    }
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
      // failing the job here would re-bill the same file on retry. Losing
      // the object degrades the document to the pre-retention state
      // (`reparse` will report it as missing), which is recoverable by
      // deleting and re-uploading.
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
      // A retained key that can't be read means the object is gone from
      // under a document we promised to keep. Raw S3 errors say nothing
      // the user can act on; this does.
      if (retention.isRetained(r2Key)) {
        throw new Error(
          'The original file is no longer stored. Delete this document and upload it again.'
        );
      }
      throw error;
    }
  }
}
