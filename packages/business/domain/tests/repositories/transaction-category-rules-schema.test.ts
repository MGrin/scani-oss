import { expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { type SQL, sql } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHoldingTransaction } from '../../test/helpers/factories-extra';

async function refused(tx: DatabaseTransaction, query: SQL) {
  try {
    await tx.transaction(async (t) => {
      await t.execute(query);
    });
  } catch (e) {
    const error = e as { code?: string; cause?: { code?: string } };
    return error.cause?.code ?? error.code;
  }
  return undefined;
}
test('saved rule schema refuses null scope and foreign category; protects referenced category', async () => {
  await withTestDb(async (tx) => {
    const user = await makeUser(tx);
    const foreign = await makeUser(tx);
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const [category] = await tx.execute(
      sql`insert into transaction_categories (user_id, name) values (${user.id}, 'Food') returning id`
    );
    const id = (category as { id: string }).id;
    expect(
      await refused(
        tx,
        sql`insert into transaction_category_rules (user_id, category_id, payee_key) values (${user.id}, ${id}, 'cafe')`
      )
    ).toBe('23502');
    expect(
      await refused(
        tx,
        sql`insert into transaction_category_rules (user_id, account_id, category_id, payee_key) values (${foreign.id}, ${account.id}, ${id}, 'cafe')`
      )
    ).toBe('23503');
    await tx.execute(
      sql`insert into transaction_category_rules (user_id, account_id, category_id, payee_key, enabled) values (${user.id}, ${account.id}, ${id}, 'cafe', false)`
    );
    expect(await refused(tx, sql`delete from transaction_categories where id = ${id}`)).toBe(
      '23503'
    );
  });
});
test('custom source requires category and cleared still requires none', async () => {
  await withTestDb(async (tx) => {
    const user = await makeUser(tx);
    const row = await makeHoldingTransaction(tx, { userId: user.id });
    const [category] = await tx.execute(
      sql`insert into transaction_categories (user_id, name) values (${user.id}, 'Food') returning id`
    );
    const id = (category as { id: string }).id;
    expect(
      await refused(
        tx,
        sql`update holding_transactions set category_set_by = 'custom_rule' where id = ${row.id}`
      )
    ).toBe('23514');
    expect(
      await refused(
        tx,
        sql`update holding_transactions set category_id = ${id}, category_set_by = 'custom_rule' where id = ${row.id}`
      )
    ).toBeUndefined();
    expect(
      await refused(
        tx,
        sql`update holding_transactions set category_set_by = 'cleared' where id = ${row.id}`
      )
    ).toBe('23514');
    expect(
      await refused(
        tx,
        sql`update holding_transactions set category_id = null, category_set_by = 'cleared' where id = ${row.id}`
      )
    ).toBeUndefined();
  });
});
