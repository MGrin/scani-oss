import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { DocumentIngestionService } from '@scani/domain/services';
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

    await ctx.reportStatus('Reading uploaded document…');
    const buf = await storage.read(data.r2Key);

    try {
      await ctx.reportStatus('Checking for a duplicate…');
      const result = await ingestion.ingest({
        userId: data.userId,
        bytes: new Uint8Array(buf),
        mimeType: data.mimeType,
        r2Key: data.r2Key,
        originalFilename: data.originalFilename,
        sourceKind: data.sourceKind,
      });

      if (!result.deduped) {
        await ctx.reportStatus('Extracting invoice data with AI…');
      }

      logger.info(
        {
          jobId: ctx.job.id,
          documentId: result.document.id,
          deduped: result.deduped,
          invoiceCount: result.extractions.length,
        },
        result.deduped ? 'Document deduped — no extraction performed' : 'Document parsed'
      );

      return {
        documentId: result.document.id,
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
      // R2 lifecycle rule cleans up if this fails; mirrors screenshot-parse's
      // best-effort delete of the temp upload.
      void storage.delete(data.r2Key).catch(() => undefined);
    }
  }
}
