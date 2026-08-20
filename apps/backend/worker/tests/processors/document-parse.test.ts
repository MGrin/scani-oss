import { describe, expect, mock, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { DocumentRepository } from '@scani/domain/repositories';
import { DocumentIngestionService, DocumentRetentionService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { DocumentParseJob } from '@scani/jobs';
import { type ProcessorContext, UnrecoverableError } from '@scani/queue';
import { Container } from 'typedi';
import { DocumentParseProcessor } from '../../src/processors/document-parse';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

// The exact string R2 returns, as it reaches the worker: the data-provider
// stringifies the S3 error into a TRPCError message and `CloudError.wrap`
// carries it through. Sentry SCANI-WORKER-P is four events of precisely
// this text escaping unclassified.
const R2_MISSING = 'The specified key does not exist.';

// The parse path used to `void storage.delete(data.r2Key)` in a blanket
// `finally`, which destroyed the uploaded file seconds after every parse —
// `documents.r2Key` pointed at nothing and `documents.reparse` could never
// read it. These tests pin the two halves of the fix: the object is
// promoted out of `temp/`, and the cleanup can only ever touch a temp key.

const USER = 'user-1';
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const TEMP_KEY = `temp/document/${USER}/abc.pdf`;
const RETAINED_KEY = `documents/${USER}/${DOC_ID}.pdf`;

function makeDocument(r2Key: string) {
  return {
    id: DOC_ID,
    userId: USER,
    r2Key,
    mimeType: 'application/pdf',
    originalFilename: 'invoice.pdf',
    sourceKind: 'upload',
  };
}

function makeCtx(): ProcessorContext {
  return {
    job: { id: 'job-1' },
    reportProgress: async () => undefined,
    reportStatus: async () => undefined,
  } as unknown as ProcessorContext;
}

class TestableProcessor extends DocumentParseProcessor {
  // `handle` is protected on UserJobProcessor, and the storage side-effects
  // it drives are the whole subject here — expose it rather than stand up
  // BullMQ around it.
  run(data: DocumentParseJob, ctx: ProcessorContext) {
    return this.handle(data, ctx);
  }
}

function makeProcessor(opts: {
  document: ReturnType<typeof makeDocument>;
  deduped?: boolean;
  read?: () => Promise<Buffer>;
  copy?: () => Promise<void>;
  ingestFails?: boolean;
}) {
  const read = mock(opts.read ?? (async () => Buffer.from('pdf-bytes')));
  const copy = mock(opts.copy ?? (async () => undefined));
  const del = mock(async () => undefined);
  Container.set(StorageFacade, { read, copy, delete: del } as unknown as StorageFacade);

  const update = mock(async (_id: string, patch: { r2Key: string }) => ({
    ...opts.document,
    ...patch,
  }));
  Container.set(DocumentRepository, { update } as unknown as DocumentRepository);

  const ingest = mock(async () => {
    if (opts.ingestFails) throw new Error('AI provider exploded');
    return {
      document: opts.document,
      extractions: [],
      deduped: opts.deduped ?? false,
      upstreamCostUsd: 0,
    };
  });
  Container.set(DocumentIngestionService, { ingest } as unknown as DocumentIngestionService);

  // The real retention service, wired to the stubs above — `isRetained` is
  // exactly the predicate under test, so stubbing it would test nothing.
  Container.set(DocumentRetentionService, new DocumentRetentionService());

  return { processor: new TestableProcessor(), read, copy, del, update, ingest };
}

function job(overrides: Partial<DocumentParseJob> = {}): DocumentParseJob {
  return {
    userId: USER,
    requestId: '22222222-2222-4222-8222-222222222222',
    r2Key: TEMP_KEY,
    mimeType: 'application/pdf',
    originalFilename: 'invoice.pdf',
    sourceKind: 'upload',
    ...overrides,
  } as DocumentParseJob;
}

describe('DocumentParseProcessor retention', () => {
  test('a fresh parse promotes the upload and deletes only the temp key', async () => {
    const { processor, copy, del, update } = makeProcessor({ document: makeDocument(TEMP_KEY) });

    const result = await processor.run(job(), makeCtx());

    expect(copy).toHaveBeenCalledWith(TEMP_KEY, RETAINED_KEY, 'application/pdf');
    expect(update).toHaveBeenCalledWith(DOC_ID, { r2Key: RETAINED_KEY });
    // Exactly one delete, and it is the temp upload — never the object the
    // copy just created.
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(TEMP_KEY);
    expect(result.documentId).toBe(DOC_ID);
  });

  test('a retained file survives the parse path cleanup', async () => {
    // A re-parse is handed the document's own permanent key. Deleting it
    // would destroy the only copy of the file.
    const { processor, copy, del } = makeProcessor({ document: makeDocument(RETAINED_KEY) });

    await processor.run(job({ r2Key: RETAINED_KEY, reparseOf: DOC_ID }), makeCtx());

    expect(del).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  test('a retained key is never deleted even when the job omits reparseOf', async () => {
    // The guard is the key prefix, not the flag — a caller that enqueues a
    // permanent key without `reparseOf` still must not lose the file.
    const { processor, del } = makeProcessor({ document: makeDocument(RETAINED_KEY) });

    await processor.run(job({ r2Key: RETAINED_KEY }), makeCtx());

    expect(del).not.toHaveBeenCalled();
  });

  test('a dedup short-circuit still deletes its temp upload', async () => {
    // Nothing was promoted — the matched document was retained by the parse
    // that first ingested it — so the temp copy is pure garbage.
    const { processor, copy, del } = makeProcessor({
      document: makeDocument(RETAINED_KEY),
      deduped: true,
    });

    const result = await processor.run(job(), makeCtx());

    expect(result.deduped).toBe(true);
    expect(copy).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(TEMP_KEY);
  });

  test('a failed promotion does not fail the job, and keeps the object its row points at', async () => {
    // Two things at once, and the second is the SCANI-WORKER-P bug.
    //
    // The AI spend is already incurred; throwing here would re-bill the
    // same file on the BullMQ retry — so the job still succeeds.
    //
    // But when `retain` fails the row is NEVER repointed, so it still
    // holds the temp key. Deleting that temp object — which the cleanup
    // did, because it keyed off `data.r2Key` alone — left a document row
    // aimed at nothing. Re-parsing it then threw
    // `CloudError: The specified key does not exist.` forever. The guard
    // has to consider where the row ended up, not just where the job
    // started.
    const { processor, del } = makeProcessor({
      document: makeDocument(TEMP_KEY),
      copy: async () => {
        throw new Error('R2 unavailable');
      },
    });

    const result = await processor.run(job(), makeCtx());

    expect(result.documentId).toBe(DOC_ID);
    expect(del).not.toHaveBeenCalled();
  });

  test('an unreadable retained object fails terminally with an actionable error', async () => {
    const { processor } = makeProcessor({
      document: makeDocument(RETAINED_KEY),
      read: async () => {
        throw new Error(R2_MISSING);
      },
    });

    const err = await processor
      .run(job({ r2Key: RETAINED_KEY, reparseOf: DOC_ID }), makeCtx())
      .then(
        () => null,
        (e: unknown) => e
      );

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/Delete this document and upload it again/);
  });

  test('an unreadable temp object fails terminally instead of raising raw R2', async () => {
    // SCANI-WORKER-P itself. `readSource` classified only the retained
    // prefix, so a missing temp object rethrew the raw `CloudError` — an
    // unactionable string for the user, a second doomed BullMQ attempt,
    // and a Sentry error for a file that is simply gone.
    const { processor } = makeProcessor({
      document: makeDocument(TEMP_KEY),
      read: async () => {
        throw new Error(R2_MISSING);
      },
    });

    const err = await processor.run(job(), makeCtx()).then(
      () => null,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/upload it again/i);
    expect((err as Error).message).not.toMatch(/specified key/i);
  });

  test('a storage outage stays retryable rather than being classified as gone', async () => {
    // The counterweight: only "the object is not there" is terminal. A 500
    // or a dropped connection must keep its retry and keep alerting, or
    // this fix would silently swallow a real R2 incident.
    const { processor } = makeProcessor({
      document: makeDocument(TEMP_KEY),
      read: async () => {
        throw new Error('R2 is returning 503 Service Unavailable');
      },
    });

    const err = await processor.run(job(), makeCtx()).then(
      () => null,
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toMatch(/503/);
  });
});

describe('DocumentParseProcessor failure cleanup', () => {
  // This was a `finally`, so a failed parse destroyed the file it was
  // handed. BullMQ's own retry (attempts: 2) and the UI's Retry button
  // then both died on "The specified key does not exist" and the job went
  // to the DLQ — every document-parse failure was unretryable by
  // construction. Observed in production 2026-08-11.
  test('a failed parse leaves the upload in place so a retry can read it', async () => {
    const { processor, del } = makeProcessor({
      document: makeDocument(TEMP_KEY),
      ingestFails: true,
    });

    await expect(processor.run(job(), makeCtx())).rejects.toThrow('AI provider exploded');

    expect(del).not.toHaveBeenCalled();
  });
});
