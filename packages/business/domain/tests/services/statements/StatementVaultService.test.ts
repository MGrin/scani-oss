import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { RecordNotAccessibleError } from '../../../src/lib/record-not-accessible';
import { FeedInputRepository } from '../../../src/repositories/FeedInputRepository';
import { StatementVaultService } from '../../../src/services/statements/StatementVaultService';
import { withTestDb } from '../../../test/helpers/db';
import { makeDocument, makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount } from '../../../test/helpers/factories-extra';

/**
 * SC-1656. An account's statements are its statement-upload windows, each
 * with the stored file it was read from when there is one. A gap is a month
 * from the first statement through the last complete one that no statement
 * covers; an inactive account stops at its last statement.
 */

const vault = () => Container.get(StatementVaultService);
const inputs = () => Container.get(FeedInputRepository);
const NOW = new Date('2026-04-10T12:00:00Z');

async function seedAccount(
  tx: DatabaseTransaction,
  userId: string,
  fields: { name?: string; isActive?: boolean } = {}
) {
  const institution = await makeInstitution(tx);
  return makeAccount(tx, { userId, institutionId: institution.id, ...fields });
}

async function statement(
  tx: DatabaseTransaction,
  account: { id: string; userId: string },
  period: { from: string; to: string },
  file?: { id: string },
  source = 'statement'
) {
  const input = await inputs().findOrCreate(
    { userId: account.userId, accountId: account.id, source, credentialId: null, walletId: null },
    tx
  );
  await inputs().recordWindow(
    input.id,
    {
      shape: 'statement-upload',
      from: new Date(`${period.from}T09:00:00Z`),
      to: new Date(`${period.to}T17:00:00Z`),
      complete: false,
      uploadRef: `temp/file-import/${account.userId}/${period.from}.csv`,
      ...(file ? { documentId: file.id } : {}),
    },
    new Date(`${period.to}T20:00:00Z`),
    tx
  );
}

describe('StatementVaultService.forAccount', () => {
  test("the account's statements, newest first, each with its file; one with no file still covers its months", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const account = await seedAccount(tx, user.id);
      const january = await makeDocument(tx, {
        userId: user.id,
        purpose: 'file-import',
        originalFilename: 'jan.csv',
        r2Key: `documents/${user.id}/jan.csv`,
      });
      await statement(tx, account, { from: '2026-01-01', to: '2026-01-31' }, january);
      await statement(tx, account, { from: '2026-02-01', to: '2026-02-28' });
      await statement(tx, account, { from: '2026-03-01', to: '2026-03-31' }, january);

      const answer = await vault().forAccount(user.id, account.id, NOW, tx);
      expect(answer.statements.map((s) => [s.from, s.to, s.document?.filename ?? null])).toEqual([
        ['2026-03-01', '2026-03-31', 'jan.csv'],
        ['2026-02-01', '2026-02-28', null],
        ['2026-01-01', '2026-01-31', 'jan.csv'],
      ]);
      expect(answer.statements[0]?.document).toEqual({
        id: january.id,
        filename: 'jan.csv',
        downloadable: true,
      });
      expect(answer.gaps).toEqual([]);
    });
  });

  test('a month no statement covers, since the first, is a gap, through the last complete month', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const account = await seedAccount(tx, user.id);
      await statement(tx, account, { from: '2025-12-01', to: '2025-12-31' });
      await statement(tx, account, { from: '2026-02-01', to: '2026-02-28' });

      expect((await vault().forAccount(user.id, account.id, NOW, tx)).gaps).toEqual([
        '2026-01',
        '2026-03',
      ]);
    });
  });

  test('an inactive account stops at its last statement', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const account = await seedAccount(tx, user.id, { isActive: false });
      await statement(tx, account, { from: '2025-12-01', to: '2025-12-31' });
      await statement(tx, account, { from: '2026-02-01', to: '2026-02-28' });

      expect((await vault().forAccount(user.id, account.id, NOW, tx)).gaps).toEqual(['2026-01']);
    });
  });

  test("another account's statements and a non-statement input's windows are not this account's statements", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const account = await seedAccount(tx, user.id);
      const other = await seedAccount(tx, user.id);
      await statement(tx, other, { from: '2026-03-01', to: '2026-03-31' });
      await statement(
        tx,
        account,
        { from: '2026-03-01', to: '2026-03-31' },
        undefined,
        'airwallex-api'
      );

      expect(await vault().forAccount(user.id, account.id, NOW, tx)).toEqual({
        statements: [],
        gaps: [],
      });
    });
  });

  // Windows written before SC-1665 carry no shape; on the statement input they are statements.
  test('a statement window with no shape is still a statement', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const account = await seedAccount(tx, user.id);
      await statement(tx, account, { from: '2026-03-01', to: '2026-03-31' });
      await tx.execute(
        sql`update feed_input_windows set shape = null where input_id in (select id from feed_inputs where account_id = ${account.id})`
      );

      expect(
        (await vault().forAccount(user.id, account.id, NOW, tx)).statements.map((s) => s.from)
      ).toEqual(['2026-03-01']);
    });
  });

  test("another user's account is refused", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeUser(tx);
      const stranger = await makeUser(tx);
      const account = await seedAccount(tx, owner.id);
      await expect(vault().forAccount(stranger.id, account.id, NOW, tx)).rejects.toBeInstanceOf(
        RecordNotAccessibleError
      );
    });
  });
});

describe('StatementVaultService.accountsByDocument', () => {
  test("one file uploaded to two accounts names both; another user's documents name nothing", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const current = await seedAccount(tx, user.id, { name: 'Current' });
      const savings = await seedAccount(tx, user.id, { name: 'Savings' });
      const file = await makeDocument(tx, { userId: user.id, purpose: 'file-import' });
      await statement(tx, current, { from: '2026-03-01', to: '2026-03-31' }, file);
      await statement(tx, savings, { from: '2026-03-01', to: '2026-03-31' }, file);
      const stranger = await makeUser(tx);

      const named = await vault().accountsByDocument(user.id, [file.id], tx);
      expect(named.get(file.id)).toEqual([
        { id: current.id, name: 'Current' },
        { id: savings.id, name: 'Savings' },
      ]);
      expect((await vault().accountsByDocument(stranger.id, [file.id], tx)).size).toBe(0);
    });
  });
});
