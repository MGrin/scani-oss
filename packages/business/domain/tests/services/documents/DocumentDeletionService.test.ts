process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, mock, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { Container } from 'typedi';
import {
  DocumentExtractionRepository,
  type ExtractionOccurrenceLink,
} from '../../../src/repositories/DocumentExtractionRepository';
import { DocumentRepository } from '../../../src/repositories/DocumentRepository';
import { DocumentDeletionService } from '../../../src/services/documents/DocumentDeletionService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

const DOC_ID = '11111111-1111-4111-8111-111111111111';

const LINK: ExtractionOccurrenceLink = {
  extractionId: '33333333-3333-4333-8333-333333333333',
  occurrenceId: '44444444-4444-4444-8444-444444444444',
  paymentId: '55555555-5555-4555-8555-555555555555',
  vendorName: 'Hetzner',
  dueDate: '2026-07-01',
};

function makeService(opts: {
  document?: unknown;
  links?: ExtractionOccurrenceLink[];
  storageDelete?: () => Promise<void>;
}) {
  const findByIdAndUser = mock(async () => opts.document ?? null);
  const deleteDocument = mock(async () => true);
  Container.set(DocumentRepository, {
    findByIdAndUser,
    delete: deleteDocument,
  } as unknown as DocumentRepository);

  const findOccurrenceLinksByDocumentId = mock(async () => opts.links ?? []);
  Container.set(DocumentExtractionRepository, {
    findOccurrenceLinksByDocumentId,
  } as unknown as DocumentExtractionRepository);

  const storageDelete = mock(opts.storageDelete ?? (async () => undefined));
  Container.set(StorageFacade, { delete: storageDelete } as unknown as StorageFacade);

  const instance = new DocumentDeletionService();
  Container.set(DocumentDeletionService, instance);
  return { instance, findByIdAndUser, deleteDocument, storageDelete };
}

describe('DocumentDeletionService.delete', () => {
  test("another user's document is refused and nothing is touched", async () => {
    // `findByIdAndUser` is user-scoped, so a foreign id reads as null — the
    // point here is that neither the row nor the object is reached.
    const { instance, deleteDocument, storageDelete } = makeService({ document: null });

    const result = await instance.delete(DOC_ID, 'intruder');

    expect(result.outcome).toBe('not-found');
    expect(deleteDocument).not.toHaveBeenCalled();
    expect(storageDelete).not.toHaveBeenCalled();
  });

  test('a document whose extraction backs a payment occurrence is refused', async () => {
    // `matched_extraction_id` is ON DELETE SET NULL: the database would
    // accept this delete and silently null the link, leaving a settled
    // occurrence with no invoice behind it. The refusal is the only guard.
    const { instance, deleteDocument, storageDelete } = makeService({
      document: { id: DOC_ID, userId: 'user-1', r2Key: `documents/user-1/${DOC_ID}.pdf` },
      links: [LINK],
    });

    const result = await instance.delete(DOC_ID, 'user-1');

    expect(result.outcome).toBe('blocked');
    if (result.outcome !== 'blocked') throw new Error('unreachable');
    expect(result.blockers).toEqual([LINK]);
    expect(deleteDocument).not.toHaveBeenCalled();
    expect(storageDelete).not.toHaveBeenCalled();
  });

  test('an unlinked document is deleted along with its stored object', async () => {
    const { instance, deleteDocument, storageDelete } = makeService({
      document: { id: DOC_ID, userId: 'user-1', r2Key: `documents/user-1/${DOC_ID}.pdf` },
    });

    const result = await instance.delete(DOC_ID, 'user-1');

    expect(result.outcome).toBe('deleted');
    if (result.outcome !== 'deleted') throw new Error('unreachable');
    expect(result.storageObjectRemoved).toBe(true);
    expect(deleteDocument).toHaveBeenCalledWith(DOC_ID);
    expect(storageDelete).toHaveBeenCalledWith(`documents/user-1/${DOC_ID}.pdf`);
  });

  test('a screenshot is deleted with its retained object, same as an invoice', async () => {
    // Nothing in the delete path is invoice-shaped: a screenshot has no
    // extractions, so it can never be blocked, and its retained object
    // lives under the same prefix. The point is that this stays true as
    // `documents` grows past invoices.
    const { instance, deleteDocument, storageDelete } = makeService({
      document: {
        id: DOC_ID,
        userId: 'user-1',
        purpose: 'screenshot',
        r2Key: `documents/user-1/${DOC_ID}.png`,
      },
    });

    const result = await instance.delete(DOC_ID, 'user-1');

    expect(result.outcome).toBe('deleted');
    if (result.outcome !== 'deleted') throw new Error('unreachable');
    expect(result.storageObjectRemoved).toBe(true);
    expect(deleteDocument).toHaveBeenCalledWith(DOC_ID);
    expect(storageDelete).toHaveBeenCalledWith(`documents/user-1/${DOC_ID}.png`);
  });

  test('a missing stored object does not block deleting the row', async () => {
    // Every document ingested before retention shipped points at a temp key
    // that was swept long ago — and those are precisely the rows a user
    // needs gone to free `(user_id, content_hash)` and re-upload the file.
    const { instance, deleteDocument } = makeService({
      document: { id: DOC_ID, userId: 'user-1', r2Key: 'temp/document/user-1/gone.pdf' },
      storageDelete: async () => {
        throw new Error('NoSuchBucket');
      },
    });

    const result = await instance.delete(DOC_ID, 'user-1');

    expect(result.outcome).toBe('deleted');
    if (result.outcome !== 'deleted') throw new Error('unreachable');
    expect(result.storageObjectRemoved).toBe(false);
    expect(deleteDocument).toHaveBeenCalledWith(DOC_ID);
  });
});
