/**
 * SC-279. The hourly balance sync retried an IBKR credential that the
 * provider had locked out — code 1025, "Too many failed attempts", which is
 * triggered *by* repeated failure. Every hourly run was another failed
 * attempt against the counter that has to age out, so the schedule was what
 * sustained the lockout: it fired every hour from 12:00Z with 57 Sentry
 * events behind it and could not have recovered on its own.
 *
 * Meanwhile the credential row read `import_status=enqueued`,
 * `import_last_error=(none)`, `import_retry_count=0` — a healthy integration
 * to admin, to the UI and to a human triaging. That is instance 14 of
 * `docs/technical/2026-08-15_absence-and-refusal.md`: the log knew, the row
 * did not, and the row is what gets read.
 *
 * Both halves are tested here: the credential is not touched inside the
 * window, and the refusal reaches the row.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { UserIntegrationCredentialsRepository } from '../../src/repositories/UserIntegrationCredentialsRepository';
import { isSyncBlocked } from '../../src/use-cases/SyncExchangeBalancesUseCase';

const HOUR = 60 * 60 * 1000;

describe('isSyncBlocked — the credential the sync must not touch', () => {
  const at = (ms: number) => new Date(Date.parse('2026-08-15T16:00:00Z') + ms);

  test('a credential locked out for 24h is NOT retried an hour later', () => {
    // The exact shape that kept firing: blocked at 12:00Z for a day, and the
    // 13:00Z run must skip it. Against the old code this branch did not
    // exist and the run went straight to the provider.
    const credential = { syncBlockedUntil: at(24 * HOUR) };

    expect(isSyncBlocked(credential, at(HOUR))).toBe(true);
    expect(isSyncBlocked(credential, at(23 * HOUR))).toBe(true);
  });

  test('it is retried once the window has passed, not before', () => {
    const credential = { syncBlockedUntil: at(24 * HOUR) };

    expect(isSyncBlocked(credential, at(24 * HOUR - 1))).toBe(true);
    expect(isSyncBlocked(credential, at(24 * HOUR))).toBe(false);
    expect(isSyncBlocked(credential, at(24 * HOUR + 1))).toBe(false);
  });

  test('an ordinary credential is never blocked', () => {
    expect(isSyncBlocked({ syncBlockedUntil: null }, at(0))).toBe(false);
  });
});

describe('the refusal reaches the credential row', () => {
  let credentialsId: string;
  let userId: string;
  let institutionId: string;
  let institutionTypeId: string;
  const repo = Container.get(UserIntegrationCredentialsRepository);

  beforeEach(async () => {
    const [user] = await db
      .insert(schema.users)
      .values({ email: `sc279-${randomUUID().slice(0, 8)}@scani.local`, name: 'SC279' })
      .returning();
    const [instType] = await db
      .insert(schema.institutionTypes)
      .values({ code: `sc279-${randomUUID().slice(0, 6)}`, name: 'SC279 Type' })
      .returning();
    const [inst] = await db
      .insert(schema.institutions)
      .values({ name: `SC279-${randomUUID().slice(0, 6)}`, typeId: instType!.id })
      .returning();
    const [credential] = await db
      .insert(schema.userIntegrationCredentials)
      .values({
        userId: user!.id,
        institutionId: inst!.id,
        encryptedCredentials: {},
        credentialsType: 'api_key',
      })
      .returning();
    userId = user!.id;
    institutionId = inst!.id;
    institutionTypeId = instType!.id;
    credentialsId = credential!.id;
  });

  afterEach(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await db.delete(schema.institutions).where(eq(schema.institutions.id, institutionId));
    await db
      .delete(schema.institutionTypes)
      .where(eq(schema.institutionTypes.id, institutionTypeId));
  });

  const read = async () =>
    (
      await db
        .select()
        .from(schema.userIntegrationCredentials)
        .where(eq(schema.userIntegrationCredentials.id, credentialsId))
    )[0];

  test('a fresh credential claims no refusal', async () => {
    const row = await read();
    expect(row?.syncBlockedUntil).toBeNull();
    expect(row?.syncLastError).toBeNull();
    expect(row?.syncFailureCount).toBe(0);
  });

  test('a refusal with a window is written, so the row stops reading as healthy', async () => {
    const until = new Date(Date.now() + 24 * HOUR);

    await repo.markSyncRefused(
      credentialsId,
      'IBKR Flex Query error (code 1025): Too many failed attempts. Please review your configuration.',
      until
    );

    const row = await read();
    expect(row?.syncLastError).toContain('code 1025');
    expect(row?.syncFailureCount).toBe(1);
    expect(row?.syncBlockedUntil?.getTime()).toBe(until.getTime());
    // And the row now answers "is this blocked" the same way the sync will.
    expect(isSyncBlocked({ syncBlockedUntil: row?.syncBlockedUntil ?? null })).toBe(true);
  });

  test('the import lifecycle is left alone — the reconciler must keep its budget', async () => {
    // `reconcile-pending-credentials` abandons a credential once
    // `importRetryCount` reaches its cap, so an hourly balance failure
    // spending that budget would abandon a later, unrelated import before it
    // had been tried once.
    await repo.markSyncRefused(credentialsId, 'refused', new Date(Date.now() + HOUR));

    const row = await read();
    expect(row?.importRetryCount).toBe(0);
    expect(row?.importLastError).toBeNull();
    expect(row?.importStatus).toBe('enqueued');
  });

  test('repeated refusals count up rather than overwrite', async () => {
    await repo.markSyncRefused(credentialsId, 'first', null);
    await repo.markSyncRefused(credentialsId, 'second', null);

    const row = await read();
    expect(row?.syncFailureCount).toBe(2);
    expect(row?.syncLastError).toBe('second');
    // No window was offered, so none was invented.
    expect(row?.syncBlockedUntil).toBeNull();
  });

  test('a success clears the refusal', async () => {
    await repo.markSyncRefused(credentialsId, 'refused', new Date(Date.now() + 24 * HOUR));

    await repo.clearSyncRefusal(credentialsId);

    const row = await read();
    expect(row?.syncBlockedUntil).toBeNull();
    expect(row?.syncLastError).toBeNull();
    expect(row?.syncFailureCount).toBe(0);
  });
});
