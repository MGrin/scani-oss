import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount } from '../../test/helpers/factories-extra';
import { AccountRepository } from './AccountRepository';

// AccountRepository.findByUser is the filter that decides which accounts
// show up on the dashboard. The hidden/isActive filters are easy to break
// accidentally (several previous regressions where marking an account
// hidden accidentally nuked its cross-references) — pin them here.

const repo = () => Container.get(AccountRepository);

describe('AccountRepository', () => {
  test('findByUser returns active, non-hidden accounts joined with account type', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const rows = await repo().findByUser(user.id, tx);
      expect(rows.length).toBe(1);
      expect(rows[0]!.id).toBe(account.id);
      // Join must populate `type` + `typeName` — consumers rely on both.
      expect(rows[0]!.type).toBeTruthy();
      expect(rows[0]!.typeName).toBeTruthy();
    });
  });

  test('findByUser excludes hidden accounts', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        isHidden: true,
      });
      const rows = await repo().findByUser(user.id, tx);
      expect(rows).toEqual([]);
    });
  });

  test('findByUser excludes inactive accounts', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        isActive: false,
      });
      const rows = await repo().findByUser(user.id, tx);
      expect(rows).toEqual([]);
    });
  });

  test('findByUser scopes by userId — no cross-user bleed', async () => {
    await withTestDb(async (tx) => {
      const userA = await makeUser(tx);
      const userB = await makeUser(tx);
      const institution = await makeInstitution(tx);
      await makeAccount(tx, { userId: userA.id, institutionId: institution.id });
      expect((await repo().findByUser(userA.id, tx)).length).toBe(1);
      expect((await repo().findByUser(userB.id, tx)).length).toBe(0);
    });
  });

  test('updateMetadata merges without destroying other fields', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        name: 'original',
      });
      await repo().updateMetadata(account.id, { walletAddress: '0xabc' }, tx);
      const refreshed = await repo().findByUser(user.id, tx);
      expect(refreshed[0]!.name).toBe('original');
      expect((refreshed[0]!.metadata as { walletAddress?: string })?.walletAddress).toBe('0xabc');
    });
  });

  test('updateAccount returns the updated row and persists fields', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const updated = await repo().updateAccount(
        account.id,
        { name: 'renamed', description: 'test desc' },
        tx
      );
      expect(updated.name).toBe('renamed');
      expect(updated.description).toBe('test desc');
    });
  });

  test('findWalletAccounts returns only accounts with walletAddress metadata', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const wallet = await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        metadata: { walletAddress: '0xdeadbeef' },
      });
      // Account without walletAddress should not appear.
      await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const wallets = await repo().findWalletAccounts(tx);
      const ids = wallets.map((w) => w.id);
      expect(ids).toContain(wallet.id);
      expect(
        wallets.every((w) => {
          const meta = w.metadata as Record<string, unknown> | null;
          return meta && 'walletAddress' in meta;
        })
      ).toBe(true);
    });
  });
});
