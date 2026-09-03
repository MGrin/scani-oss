import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { and, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { UserCostBasisMethodChangeRepository } from '../../../src/repositories/UserCostBasisMethodChangeRepository';
import { UserService } from '../../../src/services/users/UserService';
import { withTestDb } from '../../../test/helpers/db';
import { makeUser } from '../../../test/helpers/factories';

/**
 * SC-957 — a change of cost-basis method leaves a record of itself.
 *
 * ## Why these run against a real database
 *
 * Three of the four properties under test are database CHECK constraints, and a
 * stub cannot refuse anything. The defect being closed is a figure that moved
 * with no stored explanation, so "the row exists and says the right thing" is
 * the whole claim — asserting it against a fake writer would assert only that
 * this file calls the method it calls.
 *
 * `withTestDb` hands each test a transaction it rolls back, and `updateUser`
 * takes it, so the row and the column are written by the same code path
 * production uses and neither survives the test.
 *
 * ## The control
 *
 * `records nothing when the method did not change` is not a tidiness test: it
 * is what makes every other assertion here mean something. A write path that
 * recorded a row on EVERY profile edit would pass all the positive cases below
 * while making the table useless, because "this row moved somebody's figures"
 * would no longer be true of a row.
 */

/**
 * The name of the constraint that refused a write.
 *
 * Read off `cause.constraint_name` rather than matched against the message:
 * drizzle's message is `Failed query: insert into …` and names no constraint at
 * all, so a `toThrow(/is_a_change/)` would fail over a refusal that DID happen —
 * and, worse, a `toThrow()` with no pattern would pass over the WRONG
 * constraint firing.
 *
 * Throwing when the write SUCCEEDS is the control: without it, dropping the
 * constraint would make these tests report nothing rather than go red.
 */
async function constraintRefusing(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    const name = (error as { cause?: { constraint_name?: string } }).cause?.constraint_name;
    if (name) return name;
    throw error;
  }
  throw new Error('expected the row to be refused; the database accepted it');
}

const service = () => Container.get(UserService);
const changes = () => Container.get(UserCostBasisMethodChangeRepository);

describe('SC-957 — UserService.updateUser records a cost-basis method change', () => {
  test('a real change writes one row carrying both methods and the source', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { costBasisMethod: 'fifo' });

      const result = await service().updateUser(user.id, { costBasisMethod: 'uk_section_104' }, tx);

      expect(result.user.costBasisMethod).toBe('uk_section_104');
      expect(result.costBasisMethodChange).toEqual({
        previousMethod: 'fifo',
        newMethod: 'uk_section_104',
      });

      const rows = await changes().findByUserId(user.id, tx);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.previousMethod).toBe('fifo');
      expect(rows[0]?.newMethod).toBe('uk_section_104');
      expect(rows[0]?.source).toBe('user_profile_update');
      expect(rows[0]?.changedAt).toBeInstanceOf(Date);
    });
  });

  // The control. Without it, a path that logged every edit would pass every
  // other test in this file and leave the table unable to say anything.
  test('records nothing when the method did not change', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { costBasisMethod: 'fifo' });

      // Same method restated, and an edit that does not mention it at all.
      const restated = await service().updateUser(user.id, { costBasisMethod: 'fifo' }, tx);
      const unrelated = await service().updateUser(user.id, { name: 'Renamed' }, tx);

      expect(restated.costBasisMethodChange).toBeNull();
      expect(unrelated.costBasisMethodChange).toBeNull();
      expect(unrelated.user.name).toBe('Renamed');
      expect(await changes().findByUserId(user.id, tx)).toEqual([]);
    });
  });

  test('every transition is kept, newest first — one timestamp could not say this', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { costBasisMethod: 'fifo' });

      await service().updateUser(user.id, { costBasisMethod: 'uk_section_104' }, tx);
      await service().updateUser(user.id, { costBasisMethod: 'fifo' }, tx);

      const rows = await changes().findByUserId(user.id, tx);
      expect(rows).toHaveLength(2);
      // Three eras — fifo, then s104, then fifo — which is the case a single
      // `cost_basis_method_changed_at` column cannot separate at all.
      expect(rows.map((r) => [r.previousMethod, r.newMethod])).toEqual([
        ['uk_section_104', 'fifo'],
        ['fifo', 'uk_section_104'],
      ]);
    });
  });

  test('the row is scoped to its own account', async () => {
    await withTestDb(async (tx) => {
      const mine = await makeUser(tx, { costBasisMethod: 'fifo' });
      const theirs = await makeUser(tx, { costBasisMethod: 'fifo' });

      await service().updateUser(mine.id, { costBasisMethod: 'uk_section_104' }, tx);

      expect(await changes().findByUserId(mine.id, tx)).toHaveLength(1);
      expect(await changes().findByUserId(theirs.id, tx)).toEqual([]);
    });
  });

  test('the user row and the history row are written together', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { costBasisMethod: 'fifo' });
      await service().updateUser(user.id, { costBasisMethod: 'uk_section_104' }, tx);

      // Read the column back through the table rather than through the return
      // value: the returned row could be right while the write went elsewhere.
      const [stored] = await tx
        .select({ method: schema.users.costBasisMethod })
        .from(schema.users)
        .where(eq(schema.users.id, user.id));
      const rows = await changes().findByUserId(user.id, tx);

      expect(stored?.method).toBe('uk_section_104');
      expect(rows[0]?.newMethod).toBe(stored?.method);
    });
  });
});

describe('SC-957 — the database refuses a row that explains nothing', () => {
  test('a row whose two methods are equal is rejected', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const refused = await constraintRefusing(() =>
        tx.insert(schema.userCostBasisMethodChanges).values({
          userId: user.id,
          previousMethod: 'fifo',
          newMethod: 'fifo',
          source: 'user_profile_update',
        })
      );
      expect(refused).toBe('user_cost_basis_method_changes_is_a_change');
    });
  });

  test('a method the users column would refuse is refused here too', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const refused = await constraintRefusing(() =>
        tx.insert(schema.userCostBasisMethodChanges).values({
          userId: user.id,
          previousMethod: 'fifo',
          newMethod: 'lifo',
          source: 'user_profile_update',
        })
      );
      expect(refused).toBe('user_cost_basis_method_changes_new_method_check');
    });
  });

  test('a second write path cannot appear without a migration saying so', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const refused = await constraintRefusing(() =>
        tx.insert(schema.userCostBasisMethodChanges).values({
          userId: user.id,
          previousMethod: 'fifo',
          newMethod: 'uk_section_104',
          source: 'support_tool',
        })
      );
      expect(refused).toBe('user_cost_basis_method_changes_source_check');
    });
  });

  test('the history goes when the account does', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx, { costBasisMethod: 'fifo' });
      await service().updateUser(user.id, { costBasisMethod: 'uk_section_104' }, tx);
      expect(await changes().findByUserId(user.id, tx)).toHaveLength(1);

      await tx.delete(schema.users).where(eq(schema.users.id, user.id));

      const survivors = await tx
        .select()
        .from(schema.userCostBasisMethodChanges)
        .where(
          and(
            eq(schema.userCostBasisMethodChanges.userId, user.id),
            eq(schema.userCostBasisMethodChanges.source, 'user_profile_update')
          )
        );
      expect(survivors).toEqual([]);
    });
  });
});
