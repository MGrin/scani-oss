process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, mock, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { Container } from 'typedi';
import { DocumentExtractionRepository } from '../../../src/repositories/DocumentExtractionRepository';
import { DocumentRepository } from '../../../src/repositories/DocumentRepository';
import { DocumentReparseService } from '../../../src/services/documents/DocumentReparseService';
import { DocumentRetentionService } from '../../../src/services/documents/DocumentRetentionService';

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const RETAINED_KEY = `documents/user-1/${DOC_ID}.pdf`;

function makeService(opts: {
  document?: unknown;
  before?: Array<{ id: string }>;
  deleted?: Array<{ id: string }>;
}) {
  const findByIdAndUser = mock(async () => opts.document ?? null);
  Container.set(DocumentRepository, { findByIdAndUser } as unknown as DocumentRepository);

  const findByDocumentId = mock(async () => opts.before ?? []);
  const deleteUnlinkedByDocumentId = mock(async () => opts.deleted ?? []);
  Container.set(DocumentExtractionRepository, {
    findByDocumentId,
    deleteUnlinkedByDocumentId,
  } as unknown as DocumentExtractionRepository);

  Container.set(StorageFacade, {} as unknown as StorageFacade);
  Container.set(DocumentRetentionService, new DocumentRetentionService());

  const instance = new DocumentReparseService();
  Container.set(DocumentReparseService, instance);
  return { instance, findByIdAndUser, deleteUnlinkedByDocumentId };
}

describe('DocumentReparseService.prepare', () => {
  test("another user's document is refused and nothing is deleted", async () => {
    // `findByIdAndUser` is already user-scoped, so a foreign id reads as
    // null — the point of this test is that the delete never fires on it.
    const { instance, deleteUnlinkedByDocumentId } = makeService({ document: null });

    expect(await instance.prepare(DOC_ID, 'intruder')).toEqual({ outcome: 'not-found' });
    expect(deleteUnlinkedByDocumentId).not.toHaveBeenCalled();
  });

  test('a document whose file was never retained keeps its extractions', async () => {
    // Documents ingested before retention shipped point at a temp key the
    // parse job deleted. Clearing first and discovering that on the worker
    // would cost the user their extractions for a job that cannot run.
    const document = { id: DOC_ID, userId: 'user-1', r2Key: 'temp/document/user-1/abc.pdf' };
    const { instance, deleteUnlinkedByDocumentId } = makeService({ document });

    const outcome = await instance.prepare(DOC_ID, 'user-1');

    expect(outcome).toEqual({ outcome: 'file-missing', document });
    expect(deleteUnlinkedByDocumentId).not.toHaveBeenCalled();
  });

  test("the caller's own document reports what was cleared and what was kept", async () => {
    const document = { id: DOC_ID, userId: 'user-1', r2Key: RETAINED_KEY };
    const { instance, deleteUnlinkedByDocumentId } = makeService({
      document,
      before: [{ id: 'kept' }, { id: 'stale' }],
      deleted: [{ id: 'stale' }],
    });

    const outcome = await instance.prepare(DOC_ID, 'user-1');

    expect(outcome.outcome).toBe('ready');
    if (outcome.outcome !== 'ready') throw new Error('unreachable');
    expect(outcome.plan.document).toBe(document);
    expect(outcome.plan.clearedExtractionIds).toEqual(['stale']);
    // The survivor is the one a payment occurrence points at.
    expect(outcome.plan.keptExtractionIds).toEqual(['kept']);
    expect(deleteUnlinkedByDocumentId).toHaveBeenCalledWith(DOC_ID, 'user-1');
  });
});
