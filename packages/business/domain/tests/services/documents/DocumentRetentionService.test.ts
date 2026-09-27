process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, mock, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import type { Document } from '@scani/db/schema';
import { Container } from 'typedi';
import { DocumentRepository } from '../../../src/repositories/DocumentRepository';
import { DocumentRetentionService } from '../../../src/services/documents/DocumentRetentionService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

function makeDocument(overrides: Partial<Document> = {}): Document {
  return {
    id: DOC_ID,
    userId: USER,
    r2Key: `temp/document/${USER}/abc123.pdf`,
    mimeType: 'application/pdf',
    originalFilename: 'invoice.pdf',
    ...overrides,
  } as Document;
}

function makeService(opts: { write?: () => Promise<void>; updated?: unknown } = {}) {
  const write = mock(opts.write ?? (async () => undefined));
  Container.set(StorageFacade, { write } as unknown as StorageFacade);

  const update = mock(async (_id: string, patch: Partial<Document>) => {
    if ('updated' in opts) return opts.updated;
    return { ...makeDocument(), ...patch };
  });
  Container.set(DocumentRepository, { update } as unknown as DocumentRepository);

  const instance = new DocumentRetentionService();
  Container.set(DocumentRetentionService, instance);
  return { instance, write, update };
}

describe('DocumentRetentionService', () => {
  test('retains the exact parsed bytes even when the upload was replaced', async () => {
    const objects = new Map<string, Uint8Array>();
    const document = makeDocument();
    const parsed = new Uint8Array([1, 2, 3]);
    objects.set(document.r2Key, new Uint8Array([9, 9, 9]));
    Container.set(StorageFacade, {
      copy: async (from: string, to: string) => {
        objects.set(to, objects.get(from)!);
      },
      write: async (key: string, bytes: Uint8Array) => {
        objects.set(key, bytes);
      },
    } as unknown as StorageFacade);
    Container.set(DocumentRepository, {
      update: async (_id: string, patch: Partial<Document>) => ({ ...document, ...patch }),
    } as unknown as DocumentRepository);
    const service = new DocumentRetentionService();
    const retained = await service.retain(document, parsed);
    expect(objects.get(retained.r2Key)).toEqual(parsed);
  });

  test('the permanent key is per-user, per-document, and keeps the extension', async () => {
    const { instance } = makeService();
    expect(instance.retainedKeyFor(makeDocument())).toBe(`documents/${USER}/${DOC_ID}.pdf`);
  });

  test('the extension falls back to the original filename', async () => {
    // Email-ingested documents can arrive on a key with no extension.
    const { instance } = makeService();
    const document = makeDocument({
      r2Key: `temp/document/${USER}/abc123`,
      originalFilename: 'Rechnung.PNG',
    });
    expect(instance.retainedKeyFor(document)).toBe(`documents/${USER}/${DOC_ID}.png`);
  });

  test('retain copies the object rather than moving it', async () => {
    // A move would leave a failure between "source deleted" and "key
    // persisted" with no write of the file at all. The parse path owns the
    // one delete of the temp upload.
    const { instance, write, update } = makeService();
    const document = makeDocument();

    const retained = await instance.retain(document, new Uint8Array([1, 2, 3]));

    expect(write).toHaveBeenCalledWith(
      `documents/${USER}/${DOC_ID}.pdf`,
      new Uint8Array([1, 2, 3]),
      'application/pdf'
    );
    expect(update).toHaveBeenCalledWith(DOC_ID, { r2Key: `documents/${USER}/${DOC_ID}.pdf` });
    expect(retained.r2Key).toBe(`documents/${USER}/${DOC_ID}.pdf`);
  });

  test('retain is a no-op for an already-retained document', async () => {
    // Every re-parse reaches here with the permanent key; rewriting the
    // object from itself would be pointless work and a needless risk.
    const { instance, write, update } = makeService();
    const document = makeDocument({ r2Key: `documents/${USER}/${DOC_ID}.pdf` });

    expect(await instance.retain(document, new Uint8Array([1, 2, 3]))).toBe(document);
    expect(write).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  test('isRetained separates a permanent key from a temp upload', async () => {
    const { instance } = makeService();
    expect(instance.isRetained(`documents/${USER}/${DOC_ID}.pdf`)).toBe(true);
    expect(instance.isRetained(`temp/document/${USER}/abc.pdf`)).toBe(false);
  });

  test('a document deleted mid-parse keeps its old key rather than claiming retention', async () => {
    const { instance } = makeService({ updated: null });
    const document = makeDocument();

    expect((await instance.retain(document, new Uint8Array([1, 2, 3]))).r2Key).toBe(document.r2Key);
  });
});
