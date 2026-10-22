import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { FeedInputRepository } from '../../src/repositories/FeedInputRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeDocument, makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount } from '../../test/helpers/factories-extra';

/**
 * SC-1656. A statement window names the stored file it was read from, so the
 * vault can list an account's statements. The link is the window's, not the
 * document's: one file uploaded to two accounts is one document and two
 * windows (feeds, #24514).
 */

const repo = () => Container.get(FeedInputRepository);

async function seed(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const input = await repo().findOrCreate(
    {
      userId: user.id,
      accountId: account.id,
      source: 'statement',
      credentialId: null,
      walletId: null,
    },
    tx
  );
  const document = await makeDocument(tx, { userId: user.id, purpose: 'file-import' });
  return { input, document };
}

const windowOf = (documentId: string) => ({
  shape: 'statement-upload' as const,
  from: new Date('2026-08-01T00:00:00Z'),
  to: new Date('2026-08-31T00:00:00Z'),
  complete: false,
  uploadRef: 'temp/file-import/u/statement.csv',
  documentId,
});

async function windowsOf(inputId: string, tx: DatabaseTransaction) {
  return tx
    .select({ documentId: schema.feedInputWindows.documentId })
    .from(schema.feedInputWindows)
    .where(eq(schema.feedInputWindows.inputId, inputId));
}

describe('FeedInputRepository.recordWindow, document link', () => {
  test('a statement window stores the document it was read from', async () => {
    await withTestDb(async (tx) => {
      const { input, document } = await seed(tx);
      await repo().recordWindow(input.id, windowOf(document.id), document.createdAt, tx);
      expect(await windowsOf(input.id, tx)).toEqual([{ documentId: document.id }]);
    });
  });

  test('deleting the document keeps the window and clears its link', async () => {
    await withTestDb(async (tx) => {
      const { input, document } = await seed(tx);
      await repo().recordWindow(input.id, windowOf(document.id), document.createdAt, tx);
      await tx.delete(schema.documents).where(eq(schema.documents.id, document.id));
      expect(await windowsOf(input.id, tx)).toEqual([{ documentId: null }]);
    });
  });
});
