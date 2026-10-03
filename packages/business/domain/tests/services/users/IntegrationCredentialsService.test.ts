/**
 * What connecting and disconnecting a credential does, as a person sees it:
 * the stored row, what the integrations page reads back, and whether the
 * hourly sync owns the institution's accounts. Pinned before A2 Task 20 made
 * feed inputs follow the credential, which moves none of it (D-1).
 *
 * The service writes through its own connection, so the fixtures are committed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { decryptCredentials } from '@scani/security';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { databaseErrorOf } from '../../../src/lib/database-error';
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

describe('IntegrationCredentialsService — connect and disconnect, as today', () => {
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
   * The lookup reads active rows only and the key is (user, institution), so a
   * disconnected credential cannot be stored again: the connect fails, and the
   * row stays disconnected. No path re-activates a credential today.
   */
  test('storing again after a delete is refused by the (user, institution) key, and the row stays disconnected', async () => {
    const { userId, institutionId } = await commitExchange(rows);
    const stored = await credentials().storeCredentials(
      userId,
      institutionId,
      { apiKey: 'k' },
      'api_key'
    );
    await credentials().deleteCredentials(userId, institutionId);

    const refused = await credentials()
      .storeCredentials(userId, institutionId, { apiKey: 'again' }, 'api_key')
      .then(
        () => null,
        (error: unknown) => databaseErrorOf(error)?.code ?? String(error)
      );

    expect(refused).toBe('23505');
    expect((await storedRows(userId)).map((r) => [r.id, r.isActive])).toEqual([[stored.id, false]]);
  });

  test("the hourly exchange sync owns the institution's account while the credential is active, and not once it is deleted", async () => {
    const { userId, institutionId, account } = await commitExchange(rows);
    expect(await syncSourceOf(account)).toBeNull();

    await credentials().storeCredentials(userId, institutionId, { apiKey: 'k' }, 'api_key');
    expect(await syncSourceOf(account)).toBe(EXCHANGE_BALANCE_SYNC_SOURCE);

    await credentials().deleteCredentials(userId, institutionId);
    expect(await syncSourceOf(account)).toBeNull();
  });
});
