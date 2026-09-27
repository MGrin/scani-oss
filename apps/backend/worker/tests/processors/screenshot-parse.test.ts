import { describe, expect, mock, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { DocumentRepository, UserJobRepository } from '@scani/domain/repositories';
import { DocumentRetentionService, UploadedFileService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { ParseScreenshotUseCase } from '@scani/domain/use-cases/ParseScreenshotUseCase';
import { type ScreenshotParseJob, UPLOADED_FILE_MAX_BYTES } from '@scani/jobs';
import type { ProcessorContext } from '@scani/queue';
import { Container } from 'typedi';
import { ScreenshotParseProcessor } from '../../src/processors/screenshot-parse';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

// Screenshots used to leave no trace at all: the r2Key existed only inside
// the job payload and the file was deleted the moment the parse finished.
// These tests pin the two halves of the fix — the upload becomes a
// `documents` row and is promoted out of `temp/`, and the cleanup can only
// ever touch a temp key.

const USER = 'user-1';
const DOC_ID = '11111111-1111-4111-8111-111111111111';
const TEMP_KEY = `temp/screenshot/${USER}/abc.png`;
const RETAINED_KEY = `documents/${USER}/${DOC_ID}.png`;

function makeCtx(): ProcessorContext {
  return {
    job: { id: 'job-1' },
    reportProgress: async () => undefined,
    reportStatus: async () => undefined,
  } as unknown as ProcessorContext;
}

class TestableProcessor extends ScreenshotParseProcessor {
  // `handle` is protected on UserJobProcessor, and the storage side-effects
  // it drives are the whole subject here.
  run(data: ScreenshotParseJob, ctx: ProcessorContext) {
    return this.handle(data, ctx);
  }
}

function makeProcessor(
  opts: { existing?: unknown; parse?: () => Promise<unknown>; read?: () => Promise<Buffer> } = {}
) {
  const read = mock(opts.read ?? (async () => Buffer.from('png-bytes')));
  const write = mock(async () => undefined);
  const del = mock(async () => undefined);
  Container.set(StorageFacade, { read, write, delete: del } as unknown as StorageFacade);

  const findByPurposeAndContentHash = mock(async () => opts.existing ?? null);
  const create = mock(async (values: Record<string, unknown>) => ({ id: DOC_ID, ...values }));
  const update = mock(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch }));
  Container.set(DocumentRepository, {
    findByPurposeAndContentHash,
    create,
    update,
  } as unknown as DocumentRepository);

  // Real retention + real recording service: `isRetained` and the promotion
  // are exactly the behaviour under test, so stubbing them would test nothing.
  Container.set(DocumentRetentionService, new DocumentRetentionService());
  Container.set(UploadedFileService, new UploadedFileService());

  const execute = mock(opts.parse ?? (async () => ({ holdings: [{ symbol: 'BTC' }] })));
  Container.set(ParseScreenshotUseCase, { execute } as unknown as ParseScreenshotUseCase);

  const markActionTaken = mock(async () => undefined);
  Container.set(UserJobRepository, { markActionTaken } as unknown as UserJobRepository);

  return { processor: new TestableProcessor(), read, write, del, create, execute };
}

function job(overrides: Partial<ScreenshotParseJob> = {}): ScreenshotParseJob {
  return {
    userId: USER,
    requestId: '22222222-2222-4222-8222-222222222222',
    r2Keys: [TEMP_KEY],
    provider: 'openai',
    accountType: 'unknown',
    expectedCurrency: 'USD',
    minConfidence: 0.5,
    ...overrides,
  } as ScreenshotParseJob;
}

describe('ScreenshotParseProcessor file retention', () => {
  // SC-1345: see the same test in document-parse.test.ts.
  test('reads each upload with the upload cap, so storage refuses an oversized one first', async () => {
    const { processor, read } = makeProcessor();
    await processor.run(job(), makeCtx());
    expect(read).toHaveBeenCalledWith(TEMP_KEY, { maxBytes: UPLOADED_FILE_MAX_BYTES });
  });

  // SC-1363: the refusal reaches the owner as a sentence, not as `ObjectTooLarge: <key>`.
  test('an oversized screenshot is reported to its owner as over 8 MB', async () => {
    const { processor } = makeProcessor({
      read: async () => {
        throw new Error(
          `ObjectTooLarge: ${TEMP_KEY} is ${9 * 2 ** 20} bytes, over the ${UPLOADED_FILE_MAX_BYTES}-byte limit`
        );
      },
    });
    const out = (await processor.run(job(), makeCtx())) as {
      results: { success: boolean; error?: string }[];
    };
    expect(out.results[0]?.success).toBe(false);
    expect(out.results[0]?.error).toBe('This file is larger than 8 MB. Upload a smaller file.');
  });

  test('a screenshot upload becomes a documents row and a retained object', async () => {
    const { processor, create, write, del } = makeProcessor();

    await processor.run(job(), makeCtx());

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      userId: USER,
      purpose: 'screenshot',
      r2Key: TEMP_KEY,
      mimeType: 'image/png',
      originalFilename: 'abc.png',
    });
    expect(write).toHaveBeenCalledWith(RETAINED_KEY, Buffer.from('png-bytes'), 'image/png');
    // Exactly one delete, and it is the temp upload — never the object the
    // write just created.
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(TEMP_KEY);
  });

  test('a file that fails to parse is still recorded and kept', async () => {
    // Recording happens before the AI call on purpose: a screenshot the
    // extractor choked on is exactly the one the user wants to look at again.
    const { processor, create, write } = makeProcessor({
      parse: async () => {
        throw new Error('model unavailable');
      },
    });

    const result = (await processor.run(job(), makeCtx())) as { summary: { failureCount: number } };

    expect(result.summary.failureCount).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(RETAINED_KEY, Buffer.from('png-bytes'), 'image/png');
  });

  test('a retained key handed to this job is never deleted', async () => {
    // No caller passes one today. The guard is a prefix test rather than
    // "temp keys only" so that stays true for the next caller.
    const { processor, del } = makeProcessor();

    await processor.run(job({ r2Keys: [RETAINED_KEY] }), makeCtx());

    expect(del).not.toHaveBeenCalled();
  });
});
