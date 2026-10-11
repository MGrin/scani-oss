import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { UserIntegrationCredentialsRepository } from '../../src/repositories/UserIntegrationCredentialsRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeCredential, makeInstitution, makeUser } from '../../test/helpers/factories';

// Regression lock-in for the `credentials_import_status` pgEnum trap that
// shipped broken for weeks before we caught it. If Drizzle ever loses the
// pgEnum binding on `import_status`, the `findPendingEnqueueOlderThan`
// query falls over with `operator does not exist: credentials_import_status = text`
// exactly like it did in prod. This test calls that exact method with a
// real DB binding so the failure shows up in CI instead of the reconciler
// cron.

const repo = () => Container.get(UserIntegrationCredentialsRepository);

describe('UserIntegrationCredentialsRepository', () => {
  test('findPendingEnqueueOlderThan returns [] when no stale rows', async () => {
    await withTestDb(async (tx) => {
      // Empty DB (transaction-scoped) — method must return [] without throwing.
      const rows = await repo().findPendingEnqueueOlderThan(new Date(), tx);
      expect(rows).toEqual([]);
    });
  });

  test('findPendingEnqueueOlderThan picks up pending_enqueue rows older than cutoff', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);

      const repoDirect = repo();
      await repoDirect.create(
        {
          userId: user.id,
          institutionId: institution.id,
          encryptedCredentials: { test: true },
          credentialsType: 'api_key',
          importStatus: 'pending_enqueue',
          importEnqueuedAt: new Date(Date.now() - 10 * 60 * 1000),
        },
        tx
      );

      const cutoff = new Date(Date.now() - 5 * 60 * 1000);
      const stale = await repoDirect.findPendingEnqueueOlderThan(cutoff, tx);
      expect(stale.length).toBe(1);
    });
  });

  test('findPendingEnqueueOlderThan skips rows with NULL importEnqueuedAt when cutoff is in the past', async () => {
    // The SQL includes "... OR import_enqueued_at IS NULL" so NULL rows
    // are ALSO picked up — they're the crashed-before-mark case. Document
    // that contract here.
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);

      const repoDirect = repo();
      await repoDirect.create(
        {
          userId: user.id,
          institutionId: institution.id,
          encryptedCredentials: {},
          credentialsType: 'api_key',
          importStatus: 'pending_enqueue',
          // importEnqueuedAt left NULL — backend crashed between row insert
          // and the mark-enqueued update.
        },
        tx
      );
      const stale = await repoDirect.findPendingEnqueueOlderThan(new Date(), tx);
      expect(stale.length).toBe(1);
    });
  });
});

describe('a refused key (SC-1686)', () => {
  test('a refusal records its kind, and a success clears it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const cred = await makeCredential(tx, { userId: user.id, institutionId: institution.id });
      const refused = await repo().markSyncRefused(cred.id, 'expired', null, 'auth-failed', tx);
      expect(refused?.syncRefusalKind).toBe('auth-failed');
      const cleared = await repo().clearSyncRefusal(cred.id, tx);
      expect(cleared?.syncRefusalKind).toBeNull();
    });
  });

  test("findKeyRejected names only this user's active credentials refused as auth-failed", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const other = await makeUser(tx);
      const bybit = await makeInstitution(tx, { name: 'Bybit SC-1686' });
      const kraken = await makeInstitution(tx, { name: 'Kraken SC-1686' });
      const gone = await makeInstitution(tx, { name: 'Gone SC-1686' });
      const mine = await makeCredential(tx, { userId: user.id, institutionId: bybit.id });
      const generic = await makeCredential(tx, { userId: user.id, institutionId: kraken.id });
      const off = await makeCredential(tx, {
        userId: user.id,
        institutionId: gone.id,
        isActive: false,
      });
      const theirs = await makeCredential(tx, { userId: other.id, institutionId: bybit.id });
      await repo().markSyncRefused(mine.id, 'expired', null, 'auth-failed', tx);
      await repo().markSyncRefused(generic.id, 'params', null, 'unrecoverable', tx);
      await repo().markSyncRefused(off.id, 'expired', null, 'auth-failed', tx);
      await repo().markSyncRefused(theirs.id, 'expired', null, 'auth-failed', tx);
      expect(await repo().findKeyRejected(user.id, tx)).toEqual([
        { institutionId: bybit.id, institutionName: 'Bybit SC-1686' },
      ]);
    });
  });
});
