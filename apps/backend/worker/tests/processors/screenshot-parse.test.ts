import { describe, expect, mock, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { DocumentRepository, UserJobRepository } from '@scani/domain/repositories';
import { DocumentRetentionService, UploadedFileService } from '@scani/domain/services';
import { ParseScreenshotUseCase } from '@scani/domain/use-cases/ParseScreenshotUseCase';
import type { ScreenshotParseJob } from '@scani/jobs';
import type { ProcessorContext } from '@scani/queue';
import { Container } from 'typedi';
import { ScreenshotParseProcessor } from '../../src/processors/screenshot-parse';

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

function makeProcessor(opts: { existing?: unknown; parse?: () => Promise<unknown> } = {}) {
  const read = mock(async () => Buffer.from('png-bytes'));
  const copy = mock(async () => undefined);
  const del = mock(async () => undefined);
  Container.set(StorageFacade, { read, copy, delete: del } as unknown as StorageFacade);

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

  return { processor: new TestableProcessor(), read, copy, del, create, execute };
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
  test('a screenshot upload becomes a documents row and a retained object', async () => {
    const { processor, create, copy, del } = makeProcessor();

    await processor.run(job(), makeCtx());

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      userId: USER,
      purpose: 'screenshot',
      r2Key: TEMP_KEY,
      mimeType: 'image/png',
      originalFilename: 'abc.png',
    });
    expect(copy).toHaveBeenCalledWith(TEMP_KEY, RETAINED_KEY, 'image/png');
    // Exactly one delete, and it is the temp upload — never the object the
    // copy just created.
    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith(TEMP_KEY);
  });

  test('a file that fails to parse is still recorded and kept', async () => {
    // Recording happens before the AI call on purpose: a screenshot the
    // extractor choked on is exactly the one the user wants to look at again.
    const { processor, create, copy } = makeProcessor({
      parse: async () => {
        throw new Error('model unavailable');
      },
    });

    const result = (await processor.run(job(), makeCtx())) as { summary: { failureCount: number } };

    expect(result.summary.failureCount).toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith(TEMP_KEY, RETAINED_KEY, 'image/png');
  });

  test('a retained key handed to this job is never deleted', async () => {
    // No caller passes one today. The guard is a prefix test rather than
    // "temp keys only" so that stays true for the next caller.
    const { processor, del } = makeProcessor();

    await processor.run(job({ r2Keys: [RETAINED_KEY] }), makeCtx());

    expect(del).not.toHaveBeenCalled();
  });
});
