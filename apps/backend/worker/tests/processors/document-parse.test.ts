import { describe, expect, mock, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { DocumentRepository } from '@scani/domain/repositories';
import { DocumentIngestionService, DocumentRetentionService } from '@scani/domain/services';
import type { DocumentParseJob } from '@scani/jobs';
import type { ProcessorContext } from '@scani/queue';
import { Container } from 'typedi';
import { DocumentParseProcessor } from '../../src/processors/document-parse';

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

  test('a failed promotion does not fail the job', async () => {
    // The AI spend is already incurred; throwing here would re-bill the
    // same file on the BullMQ retry.
    const { processor, del } = makeProcessor({
      document: makeDocument(TEMP_KEY),
      copy: async () => {
        throw new Error('R2 unavailable');
      },
    });

    const result = await processor.run(job(), makeCtx());

    expect(result.documentId).toBe(DOC_ID);
    expect(del).toHaveBeenCalledWith(TEMP_KEY);
  });

  test('an unreadable retained object surfaces an actionable error', async () => {
    const { processor } = makeProcessor({
      document: makeDocument(RETAINED_KEY),
      read: async () => {
        throw new Error('NoSuchKey: the specified key does not exist');
      },
    });

    await expect(
      processor.run(job({ r2Key: RETAINED_KEY, reparseOf: DOC_ID }), makeCtx())
    ).rejects.toThrow(/Delete this document and upload it again/);
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
