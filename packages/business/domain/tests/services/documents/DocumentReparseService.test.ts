process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, mock, test } from 'bun:test';
import { Container } from 'typedi';
import { DocumentExtractionRepository } from '../../../src/repositories/DocumentExtractionRepository';
import { DocumentRepository } from '../../../src/repositories/DocumentRepository';
import { DocumentReparseService } from '../../../src/services/documents/DocumentReparseService';

const DOC_ID = '11111111-1111-4111-8111-111111111111';

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

  const instance = new DocumentReparseService();
  Container.set(DocumentReparseService, instance);
  return { instance, findByIdAndUser, deleteUnlinkedByDocumentId };
}

describe('DocumentReparseService.prepare', () => {
  test("another user's document is refused and nothing is deleted", async () => {
    // `findByIdAndUser` is already user-scoped, so a foreign id reads as
    // null — the point of this test is that the delete never fires on it.
    const { instance, deleteUnlinkedByDocumentId } = makeService({ document: null });

    expect(await instance.prepare(DOC_ID, 'intruder')).toBeNull();
    expect(deleteUnlinkedByDocumentId).not.toHaveBeenCalled();
  });

  test("the caller's own document reports what was cleared and what was kept", async () => {
    const document = { id: DOC_ID, userId: 'user-1' };
    const { instance, deleteUnlinkedByDocumentId } = makeService({
      document,
      before: [{ id: 'kept' }, { id: 'stale' }],
      deleted: [{ id: 'stale' }],
    });

    const plan = await instance.prepare(DOC_ID, 'user-1');

    expect(plan?.document).toBe(document);
    expect(plan?.clearedExtractionIds).toEqual(['stale']);
    // The survivor is the one a payment occurrence points at.
    expect(plan?.keptExtractionIds).toEqual(['kept']);
    expect(deleteUnlinkedByDocumentId).toHaveBeenCalledWith(DOC_ID, 'user-1');
  });
});
