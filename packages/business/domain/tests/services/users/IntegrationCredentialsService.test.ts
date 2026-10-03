/**
 * What connecting and disconnecting a credential does, as a person sees it:
 * the stored row, what the integrations page reads back, whether the hourly
 * sync owns the institution's accounts, and the status of the account's feed
 * input, which follows the credential (A2 Task 20).
 *
 * The service writes through its own connection, so the fixtures are committed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { decryptCredentials } from '@scani/security';
import { asc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { BalanceSyncOwnershipService } from '../../../src/services/accounts/BalanceSyncOwnershipService';
import { EXCHANGE_BALANCE_SYNC_SOURCE } from '../../../src/services/holdings/balance-sync-sources';
import { IntegrationCredentialsService } from '../../../src/services/users/IntegrationCredentialsService';
import { committedRows } from '../../../test/helpers/committed-rows';
import { commitExchange } from '../../../test/helpers/committed-seeds';

const rows = committedRows();
afterEach(rows.drop);

const credentials = () => Container.get(IntegrationCredentialsService);

const storedRows = (userId: string) =>
  getDb()
    .select()
    .from(schema.userIntegrationCredentials)
    .where(eq(schema.userIntegrationCredentials.userId, userId));

const syncSourceOf = (account: typeof schema.accounts.$inferSelect) =>
  getDb().transaction((tx) =>
    Container.get(BalanceSyncOwnershipService).resolveSyncSource(account.userId, account, tx)
  );

const inputStatuses = async (userId: string) =>
  (
    await getDb()
      .select({ status: schema.feedInputs.status })
      .from(schema.feedInputs)
      .where(eq(schema.feedInputs.userId, userId))
      .orderBy(asc(schema.feedInputs.accountId))
  ).map((input) => input.status);

describe('IntegrationCredentialsService — connect, disconnect and reconnect', () => {
  test('storing connects an active credential awaiting its import, and storing again updates the same row', async () => {
    const { userId, institutionId } = await commitExchange(rows);

    const first = await credentials().storeCredentials(
      userId,
      institutionId,
      { apiKey: 'first' },
      'api_key'
    );
    const second = await credentials().storeCredentials(
      userId,
      institutionId,
      { apiKey: 'second' },
      'api_key'
    );

    expect([first.isActive, first.importStatus]).toEqual([true, 'pending_enqueue']);
    expect(second.id).toBe(first.id);
    const [row] = await storedRows(userId);
    expect([row!.isActive, row!.importStatus]).toEqual([true, 'pending_enqueue']);
    expect(decryptCredentials(row!.encryptedCredentials as Record<string, unknown>)).toEqual({
      apiKey: 'second',
    });
    expect((await credentials().getUserCredentials(userId)).map((c) => c.id)).toEqual([first.id]);
  });

  test('deleting disconnects: the row stays, inactive, and reads back as absent', async () => {
    const { userId, institutionId } = await commitExchange(rows);
    const stored = await credentials().storeCredentials(
      userId,
      institutionId,
      { apiKey: 'k' },
      'api_key'
    );

    await credentials().deleteCredentials(userId, institutionId);

    expect((await storedRows(userId)).map((r) => [r.id, r.isActive])).toEqual([[stored.id, false]]);
    expect(await credentials().getCredentials(userId, institutionId)).toBeNull();
    expect(await credentials().getUserCredentials(userId)).toEqual([]);
  });

  /**
   * The key is (user, institution) and a disconnect keeps the row, so a
   * reconnect re-activates that row rather than inserting beside it. Until
   * SC-1534 the lookup read active rows only, and the insert was refused.
   */
  test('storing again after a delete reconnects the same row, with the new keys', async () => {
    const { userId, institutionId } = await commitExchange(rows);
    const stored = await credentials().storeCredentials(
      userId,
      institutionId,
      { apiKey: 'k' },
      'api_key'
    );
    await credentials().markImportFailed(stored.id, 'the old import failed');
    await credentials().deleteCredentials(userId, institutionId);

    const again = await credentials().storeCredentials(
      userId,
      institutionId,
      { apiKey: 'again' },
      'api_key'
    );

    expect(again.id).toBe(stored.id);
    const all = await storedRows(userId);
    expect(all.map((r) => [r.id, r.isActive, r.importStatus, r.importLastError])).toEqual([
      [stored.id, true, 'pending_enqueue', null],
    ]);
    expect(decryptCredentials(all[0]!.encryptedCredentials as Record<string, unknown>)).toEqual({
      apiKey: 'again',
    });
    expect((await credentials().getUserCredentials(userId)).map((c) => c.id)).toEqual([stored.id]);
  });

  test('a disconnected credential still reads back as absent, and cannot be deleted twice', async () => {
    const { userId, institutionId } = await commitExchange(rows);
    await credentials().storeCredentials(userId, institutionId, { apiKey: 'k' }, 'api_key');
    await credentials().deleteCredentials(userId, institutionId);

    expect(await credentials().getDecryptedCredentials(userId, institutionId)).toBeNull();
    await expect(credentials().deleteCredentials(userId, institutionId)).rejects.toThrow();
    await expect(
      credentials().updateCredentials(userId, institutionId, { apiKey: 'sneaked' })
    ).rejects.toThrow();
  });

  test("the hourly exchange sync owns the institution's account while the credential is active, not once it is deleted, and again once it is reconnected", async () => {
    const { userId, institutionId, account } = await commitExchange(rows);
    expect(await syncSourceOf(account)).toBeNull();

    await credentials().storeCredentials(userId, institutionId, { apiKey: 'k' }, 'api_key');
    expect(await syncSourceOf(account)).toBe(EXCHANGE_BALANCE_SYNC_SOURCE);

    await credentials().deleteCredentials(userId, institutionId);
    expect(await syncSourceOf(account)).toBeNull();

    await credentials().storeCredentials(userId, institutionId, { apiKey: 'again' }, 'api_key');
    expect(await syncSourceOf(account)).toBe(EXCHANGE_BALANCE_SYNC_SOURCE);
  });

  test("the account's feed input follows the credential through a disconnect and a reconnect", async () => {
    const { userId, institutionId } = await commitExchange(rows, { evidence: true });

    await credentials().storeCredentials(userId, institutionId, { apiKey: 'k' }, 'api_key');
    expect(await inputStatuses(userId)).toEqual(['active']);

    await credentials().deleteCredentials(userId, institutionId);
    expect(await inputStatuses(userId)).toEqual(['disconnected']);

    await credentials().storeCredentials(userId, institutionId, { apiKey: 'again' }, 'api_key');
    expect(await inputStatuses(userId)).toEqual(['active']);
  });
});
