process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, mock, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import type { Document } from '@scani/db/schema';
import { Container } from 'typedi';
import { DocumentRepository } from '../../../src/repositories/DocumentRepository';
import { DocumentDownloadService } from '../../../src/services/documents/DocumentDownloadService';
import { DocumentRetentionService } from '../../../src/services/documents/DocumentRetentionService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const RETAINED_KEY = `documents/${USER}/${DOC_ID}.png`;

function makeService(document: Partial<Document> | null) {
  const findByIdAndUser = mock(async () => document as Document | null);
  Container.set(DocumentRepository, { findByIdAndUser } as unknown as DocumentRepository);

  const presignDownload = mock(async (key: string) => `https://r2.example/${key}?sig=abc`);
  Container.set(StorageFacade, { presignDownload } as unknown as StorageFacade);

  Container.set(DocumentRetentionService, new DocumentRetentionService());

  const instance = new DocumentDownloadService();
  Container.set(DocumentDownloadService, instance);
  return { instance, findByIdAndUser, presignDownload };
}

describe('DocumentDownloadService.presign', () => {
  test("another user's file is invisible and never presigned", async () => {
    // `findByIdAndUser` is the ownership check, and it reads null for both
    // "no such document" and "not yours". The URL carries the bucket's own
    // authority, so it must not be minted before that returns a row.
    const { instance, presignDownload } = makeService(null);

    const result = await instance.presign(DOC_ID, 'intruder');

    expect(result.outcome).toBe('not-found');
    expect(presignDownload).not.toHaveBeenCalled();
  });

  test('a retained file of any purpose gets a presigned GET', async () => {
    const { instance, presignDownload } = makeService({
      id: DOC_ID,
      userId: USER,
      purpose: 'screenshot',
      r2Key: RETAINED_KEY,
      originalFilename: 'abc123.png',
      mimeType: 'image/png',
    });

    const result = await instance.presign(DOC_ID, USER);

    expect(result.outcome).toBe('ready');
    if (result.outcome !== 'ready') throw new Error('unreachable');
    expect(result.url).toBe(`https://r2.example/${RETAINED_KEY}?sig=abc`);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(presignDownload).toHaveBeenCalledWith(RETAINED_KEY, 5 * 60);
  });

  test('a row still pointing at temp/ reports file-missing rather than a dead URL', async () => {
    // Presigning a swept temp key returns a URL that 404s. The retained
    // -prefix test is the same guard the parse path uses.
    const { instance, presignDownload } = makeService({
      id: DOC_ID,
      userId: USER,
      purpose: 'invoice',
      r2Key: `temp/document/${USER}/gone.pdf`,
    });

    const result = await instance.presign(DOC_ID, USER);

    expect(result.outcome).toBe('file-missing');
    expect(presignDownload).not.toHaveBeenCalled();
  });
});
