import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { sql } from 'drizzle-orm';
import { assertNoForeignUsers, DemoModeRefused } from '../../src/demo';
import { isDemoPersonaPresent, todayAnchor } from '../../src/demo/bootstrap';
import { buildDemoDataset } from '../../src/demo/dataset';
import { withTestDb } from '../../test/helpers/db';

/**
 * SC-467: what a demo instance does on its first boot.
 *
 * The published images carry no seeder CLI and there is no checkout inside a
 * container, so a freshly migrated demo database can only be filled by the
 * worker. The two decisions that entails are tested here: whether the persona
 * is already present, and whether it is safe to write.
 *
 * `ensureDemoDatasetSeeded` itself is deliberately NOT called from this file.
 * It writes through the process-wide `db` handle rather than a transaction, so
 * exercising it here would leave 21,500 rows in the gate database and make
 * this file's result depend on the order the suite ran in. Its two decisions
 * are each covered below against a real database; the composition is covered
 * by running a demo stack, which is what SC-467's verification did.
 */

const demoUser = buildDemoDataset().user;

async function emptyUsers(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  await tx.execute(sql`TRUNCATE TABLE users CASCADE`);
}

async function insertUser(
  tx: Parameters<Parameters<typeof withTestDb>[0]>[0],
  email: string,
  id: string
) {
  await tx.insert(schema.users).values({ id, email, name: 'Test', emailVerified: true });
}

describe('isDemoPersonaPresent', () => {
  test('false on an empty database — the case first boot exists for', async () => {
    await withTestDb(async (tx) => {
      await emptyUsers(tx);
      expect(await isDemoPersonaPresent(tx)).toBe(false);
    });
  });

  test('true once the persona has a row', async () => {
    await withTestDb(async (tx) => {
      await emptyUsers(tx);
      await insertUser(tx, demoUser.email, demoUser.id);
      expect(await isDemoPersonaPresent(tx)).toBe(true);
    });
  });

  test('false when the database holds somebody else entirely', async () => {
    // Without this the check could be "are there any users at all", which
    // would treat a production database as already seeded and skip the guard
    // that refuses it.
    await withTestDb(async (tx) => {
      await emptyUsers(tx);
      await insertUser(tx, 'real.person@example.com', '11111111-1111-4111-8111-111111111111');
      expect(await isDemoPersonaPresent(tx)).toBe(false);
    });
  });

  test('matches case-insensitively, as email comparison must', async () => {
    await withTestDb(async (tx) => {
      await emptyUsers(tx);
      await insertUser(tx, demoUser.email.toUpperCase(), demoUser.id);
      expect(await isDemoPersonaPresent(tx)).toBe(true);
    });
  });
});

describe('assertNoForeignUsers — the seeder guard, which is NOT the api guard', () => {
  test('ACCEPTS an empty database, which the api guard refuses', () => {
    // This is the whole reason the two guards are different functions. The
    // api's `assertDemoOnlyUsers` refuses an empty database because emptiness
    // proves nothing about whether it is a demo — right for a process about to
    // hand every anonymous visitor a session. Here it is the only case worth
    // handling, and calling the stricter one would mean a fresh demo
    // deployment never comes up at all.
    expect(() => assertNoForeignUsers([])).not.toThrow();
  });

  test('accepts the persona alone', () => {
    expect(() => assertNoForeignUsers([demoUser.email])).not.toThrow();
  });

  test('refuses one foreign account, and names it', () => {
    expect(() => assertNoForeignUsers([demoUser.email, 'real.person@example.com'])).toThrow(
      DemoModeRefused
    );
    try {
      assertNoForeignUsers(['real.person@example.com']);
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toContain('real.person@example.com');
    }
  });

  test('refuses a production-shaped database', () => {
    const production = ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'];
    expect(() => assertNoForeignUsers(production)).toThrow(DemoModeRefused);
  });

  test('blank and null rows are not foreign accounts', () => {
    expect(() => assertNoForeignUsers([null, '  ', demoUser.email])).not.toThrow();
  });
});

describe('todayAnchor', () => {
  test('is the UTC calendar date, in the shape the seeder wants', () => {
    expect(todayAnchor(new Date('2026-08-21T23:59:59Z'))).toBe('2026-08-21');
    expect(todayAnchor(new Date('2026-08-22T00:00:01Z'))).toBe('2026-08-22');
  });

  test('does not follow the local clock', () => {
    // The reset job and this share the rule, and the dataset is deterministic
    // per anchor — so a boot that used local time and a reset that used UTC
    // would produce two different datasets on the same calendar day for half
    // the world.
    expect(todayAnchor(new Date('2026-08-21T16:30:00+08:00'))).toBe('2026-08-21');
  });
});
