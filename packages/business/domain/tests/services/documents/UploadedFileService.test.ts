process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import type { Document } from '@scani/db/schema';
import { Container } from 'typedi';
import { DocumentRepository } from '../../../src/repositories/DocumentRepository';
import { DocumentRetentionService } from '../../../src/services/documents/DocumentRetentionService';
import { UploadedFileService } from '../../../src/services/documents/UploadedFileService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const BYTES = new Uint8Array([1, 2, 3, 4]);
const HASH = createHash('sha256').update(BYTES).digest('hex');
const TEMP_KEY = `temp/screenshot/${USER}/abc123.png`;
const RETAINED_KEY = `documents/${USER}/${DOC_ID}.png`;

function makeService(opts: { existing?: Document | null; copy?: () => Promise<void> } = {}) {
  const copy = mock(opts.copy ?? (async () => undefined));
  Container.set(StorageFacade, { copy } as unknown as StorageFacade);

  const findByPurposeAndContentHash = mock(async () => opts.existing ?? null);
  const create = mock(async (values: Partial<Document>) => ({ id: DOC_ID, ...values }) as Document);
  const update = mock(
    async (id: string, patch: Partial<Document>) => ({ id, ...patch }) as Document
  );
  Container.set(DocumentRepository, {
    findByPurposeAndContentHash,
    create,
    update,
  } as unknown as DocumentRepository);

  // The REAL retention service, so "was the object promoted out of temp/"
  // is answered by the code that actually decides it.
  Container.set(DocumentRetentionService, new DocumentRetentionService());

  const instance = new UploadedFileService();
  Container.set(UploadedFileService, instance);
  return { instance, copy, create, findByPurposeAndContentHash, update };
}

const INPUT = {
  userId: USER,
  purpose: 'screenshot' as const,
  bytes: BYTES,
  mimeType: 'image/png',
  r2Key: TEMP_KEY,
  originalFilename: 'abc123.png',
};

describe('UploadedFileService.record', () => {
  test('a screenshot upload becomes a documents row and a retained object', async () => {
    const { instance, create, copy } = makeService();

    const document = await instance.record(INPUT);

    expect(create).toHaveBeenCalledWith({
      userId: USER,
      purpose: 'screenshot',
      r2Key: TEMP_KEY,
      contentHash: HASH,
      mimeType: 'image/png',
      byteSize: 4,
      originalFilename: 'abc123.png',
      sourceKind: 'upload',
    });
    expect(copy).toHaveBeenCalledWith(TEMP_KEY, RETAINED_KEY, 'image/png');
    expect(document.r2Key).toBe(RETAINED_KEY);
  });

  test('re-uploading the same file reuses the row instead of failing', async () => {
    // The case the partial unique exists for: a user re-uploads the same
    // CSV after a failed import. A constraint would blow up the INSERT and
    // take the retry with it; the lookup just hands back the row.
    const existing = {
      id: DOC_ID,
      userId: USER,
      purpose: 'file-import',
      r2Key: `documents/${USER}/${DOC_ID}.csv`,
      contentHash: HASH,
    } as Document;
    const { instance, create, copy } = makeService({ existing });

    const document = await instance.record({ ...INPUT, purpose: 'file-import' });

    expect(document).toBe(existing);
    expect(create).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  test('a reused row that never got retained is retained from the new upload', async () => {
    // Its own key is a temp one R2 has very likely swept; the bytes on the
    // key this upload landed on are identical by definition.
    const existing = {
      id: DOC_ID,
      userId: USER,
      purpose: 'screenshot',
      r2Key: `temp/screenshot/${USER}/older.png`,
      mimeType: 'image/png',
      originalFilename: 'abc123.png',
      contentHash: HASH,
    } as Document;
    const { instance, copy } = makeService({ existing });

    const document = await instance.record(INPUT);

    expect(copy).toHaveBeenCalledWith(TEMP_KEY, RETAINED_KEY, 'image/png');
    expect(document.r2Key).toBe(RETAINED_KEY);
  });

  test('a retention failure still yields the row rather than throwing', async () => {
    // The caller's real work is a parse or an import. Losing the kept copy
    // degrades the row to the pre-retention state; it must not fail the job.
    const { instance } = makeService({
      copy: async () => {
        throw new Error('R2 unavailable');
      },
    });

    const document = await instance.record(INPUT);

    expect(document.r2Key).toBe(TEMP_KEY);
  });
});
