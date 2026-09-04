/**
 * SC-1020 — `pickCandidate` must not hand back a user whose credential
 * the resolver will refuse.
 *
 * These tests hit the real Postgres deliberately. The claim under test
 * IS the SQL of the candidate query — which rows it returns and in what
 * order — so a stubbed `getDb` would only ever exercise the stub's own
 * ordering and could not come back red for the right reason.
 *
 * Each test owns its own institution, so the institution id isolates one
 * test's rows from another's without a transaction (the pool calls
 * `getDb()` itself and takes no transaction handle).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db/connection';
import {
  credentialPoolBorrowLog,
  credentialPoolState,
  institutions,
  institutionTypes,
  userIntegrationCredentials,
  users,
} from '@scani/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { CredentialPool, type CredentialsResolver } from '../../src/core/credential-pool';

const createdUserIds: string[] = [];
const createdInstitutionIds: string[] = [];
let institutionTypeId: string;

/**
 * Faithful stand-in for the wired resolver
 * (`IntegrationCredentialsService.getDecryptedCredentials`). It returns
 * null exactly when that one does: the lookup underneath it,
 * `UserIntegrationCredentialsRepository.findByUserAndInstitution`,
 * filters `is_active = true`, so a disconnected credential — which is a
 * soft delete, `deleteCredentials` sets `is_active = false` — resolves
 * to nothing.
 */
const resolver: CredentialsResolver = async (userId, institutionId) => {
  const rows = await getDb()
    .select({ id: userIntegrationCredentials.id })
    .from(userIntegrationCredentials)
    .where(
      and(
        eq(userIntegrationCredentials.userId, userId),
        eq(userIntegrationCredentials.institutionId, institutionId),
        eq(userIntegrationCredentials.isActive, true)
      )
    )
    .limit(1);
  return rows[0] ? { apiKey: `stub-${userId}` } : null;
};

async function seedUser(label: string): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({
      email: `sc1020-${label}-${crypto.randomUUID()}@example.invalid`,
      name: `SC-1020 ${label}`,
    })
    .returning({ id: users.id });
  if (!row) throw new Error('failed to seed user');
  createdUserIds.push(row.id);
  return row.id;
}

async function seedInstitution(): Promise<string> {
  const [row] = await getDb()
    .insert(institutions)
    .values({ name: `SC-1020 ${crypto.randomUUID()}`, typeId: institutionTypeId })
    .returning({ id: institutions.id });
  if (!row) throw new Error('failed to seed institution');
  createdInstitutionIds.push(row.id);
  return row.id;
}

async function seedCredential(
  userId: string,
  institutionId: string,
  isActive: boolean
): Promise<void> {
  await getDb()
    .insert(userIntegrationCredentials)
    .values({
      userId,
      institutionId,
      encryptedCredentials: { ciphertext: 'stub' },
      credentialsType: 'api_key',
      isActive,
    });
}

function makePool(providerKey: string, institutionId: string): CredentialPool {
  const pool = new CredentialPool();
  pool.setCredentialsResolver(resolver);
  pool.registerProviderInstitution(providerKey, institutionId);
  return pool;
}

beforeAll(async () => {
  const [row] = await getDb()
    .insert(institutionTypes)
    .values({ code: `sc1020-${crypto.randomUUID()}`, name: 'SC-1020 fixture' })
    .returning({ id: institutionTypes.id });
  if (!row) throw new Error('failed to seed institution type');
  institutionTypeId = row.id;
});

afterAll(async () => {
  const db = getDb();
  if (createdUserIds.length > 0) {
    await db
      .delete(credentialPoolBorrowLog)
      .where(inArray(credentialPoolBorrowLog.borrowedFromUserId, createdUserIds));
    await db.delete(credentialPoolState).where(inArray(credentialPoolState.userId, createdUserIds));
    await db
      .delete(userIntegrationCredentials)
      .where(inArray(userIntegrationCredentials.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  if (createdInstitutionIds.length > 0) {
    await db.delete(institutions).where(inArray(institutions.id, createdInstitutionIds));
  }
  if (institutionTypeId) {
    await db.delete(institutionTypes).where(eq(institutionTypes.id, institutionTypeId));
  }
});

describe('CredentialPool candidate selection (SC-1020)', () => {
  test('CONTROL: borrows the healthy credential when no dead pool entry exists', async () => {
    const institutionId = await seedInstitution();
    const healthy = await seedUser('control-healthy');
    await seedCredential(healthy, institutionId, true);

    const pool = makePool('sc1020-control', institutionId);

    const first = await pool.borrowCredentials('sc1020-control');
    const second = await pool.borrowCredentials('sc1020-control');

    expect(first?.handle.userId).toBe(healthy);
    expect(second?.handle.userId).toBe(healthy);
  });

  test('a disconnected user with a pool-state row does not wedge the pool', async () => {
    const institutionId = await seedInstitution();
    const disconnected = await seedUser('wedge-disconnected');
    const healthy = await seedUser('wedge-healthy');

    // The production sequence: the disconnected user borrowed once (which
    // is what created their state row), then disconnected — a soft delete
    // that leaves `credential_pool_state` standing. The healthy user has
    // never borrowed, so has no state row.
    await seedCredential(disconnected, institutionId, false);
    await seedCredential(healthy, institutionId, true);
    await getDb()
      .insert(credentialPoolState)
      .values({
        userId: disconnected,
        institutionId,
        lastBorrowedAt: new Date('2020-01-01T00:00:00Z'),
        totalBorrowsCount: 1,
      });

    const pool = makePool('sc1020-wedge', institutionId);

    // The pool reports itself healthy — `size()` joins the credential
    // table and so counts only the live one. A borrow must agree with it.
    expect(await pool.isHealthy('sc1020-wedge')).toBe(true);

    const first = await pool.borrowCredentials('sc1020-wedge');
    const second = await pool.borrowCredentials('sc1020-wedge');

    expect(first?.handle.userId).toBe(healthy);
    expect(second?.handle.userId).toBe(healthy);
  });

  test('an orphaned state row with no credential row at all does not wedge the pool', async () => {
    const institutionId = await seedInstitution();
    const orphan = await seedUser('orphan');
    const healthy = await seedUser('orphan-healthy');

    // No `user_integration_credentials` row for the orphan at all — the
    // shape a hard delete would leave, since nothing removes the state row.
    await seedCredential(healthy, institutionId, true);
    await getDb()
      .insert(credentialPoolState)
      .values({
        userId: orphan,
        institutionId,
        lastBorrowedAt: new Date('2020-01-01T00:00:00Z'),
        totalBorrowsCount: 1,
      });

    const pool = makePool('sc1020-orphan', institutionId);

    const first = await pool.borrowCredentials('sc1020-orphan');
    const second = await pool.borrowCredentials('sc1020-orphan');

    expect(first?.handle.userId).toBe(healthy);
    expect(second?.handle.userId).toBe(healthy);
  });

  test('a quarantined entry is still skipped in favour of a healthy one', async () => {
    const institutionId = await seedInstitution();
    const quarantined = await seedUser('quarantined');
    const healthy = await seedUser('quarantine-healthy');

    await seedCredential(quarantined, institutionId, true);
    await seedCredential(healthy, institutionId, true);
    await getDb()
      .insert(credentialPoolState)
      .values({
        userId: quarantined,
        institutionId,
        lastBorrowedAt: new Date('2020-01-01T00:00:00Z'),
        quarantinedUntil: new Date(Date.now() + 60 * 60 * 1000),
        totalBorrowsCount: 1,
      });

    const pool = makePool('sc1020-quarantine', institutionId);

    const borrow = await pool.borrowCredentials('sc1020-quarantine');
    expect(borrow?.handle.userId).toBe(healthy);
  });

  test('a never-borrowed credential outranks a borrowed one (NULLS FIRST)', async () => {
    const institutionId = await seedInstitution();
    const borrowed = await seedUser('lru-borrowed');
    const fresh = await seedUser('lru-fresh');

    await seedCredential(borrowed, institutionId, true);
    await seedCredential(fresh, institutionId, true);
    await getDb()
      .insert(credentialPoolState)
      .values({
        userId: borrowed,
        institutionId,
        lastBorrowedAt: new Date('2020-01-01T00:00:00Z'),
        totalBorrowsCount: 1,
      });

    const pool = makePool('sc1020-nullsfirst', institutionId);

    // `fresh` has no state row, so its `last_borrowed_at` is NULL. Under
    // Postgres' default ASC (NULLS LAST) the 2020 timestamp would win and
    // a brand-new credential would never be reached.
    const borrow = await pool.borrowCredentials('sc1020-nullsfirst');
    expect(borrow?.handle.userId).toBe(fresh);
  });

  test('among borrowed entries the least recent wins (LRU)', async () => {
    const institutionId = await seedInstitution();
    const older = await seedUser('lru-older');
    const newer = await seedUser('lru-newer');

    await seedCredential(older, institutionId, true);
    await seedCredential(newer, institutionId, true);
    await getDb()
      .insert(credentialPoolState)
      .values([
        {
          userId: older,
          institutionId,
          lastBorrowedAt: new Date('2020-01-01T00:00:00Z'),
          totalBorrowsCount: 1,
        },
        {
          userId: newer,
          institutionId,
          lastBorrowedAt: new Date('2025-01-01T00:00:00Z'),
          totalBorrowsCount: 1,
        },
      ]);

    const pool = makePool('sc1020-lru', institutionId);

    const borrow = await pool.borrowCredentials('sc1020-lru');
    expect(borrow?.handle.userId).toBe(older);
  });
});
