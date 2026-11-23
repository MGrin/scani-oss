import { expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import { makeInstitution, makeUser } from '@scani/domain/test-helpers';
import { sql } from 'drizzle-orm';
import { makeAccount } from '../../../../../../packages/business/domain/test/helpers/factories-extra';
import { makeAuthedCaller, makeUnauthedCaller } from '../../helpers/test-caller';

test('saved rule router enforces strict input, authenticated ownership and typed conflicts', async () => {
  const db = getDb();
  const f = await db.transaction(async (tx) => {
    const owner = await makeUser(tx);
    const foreign = await makeUser(tx);
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: owner.id, institutionId: institution.id });
    const [cat] = await tx.execute(
      sql`insert into transaction_categories(user_id,name) values (${owner.id},'Food') returning id`
    );
    return { owner, foreign, institution, account, categoryId: (cat as { id: string }).id };
  });
  try {
    const caller = makeAuthedCaller(f.owner).categories.rules;
    const draft = {
      accountId: f.account.id,
      categoryId: f.categoryId,
      payeeText: 'Cafe Example',
      enabled: true,
    };
    const saved = await caller.save(draft);
    expect(saved.payeeKey).toBe('cafe example');
    await expect(caller.save(draft)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'DUPLICATE_RULE',
    });
    await expect(makeAuthedCaller(f.foreign).categories.rules.save(draft)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(caller.save({ ...draft, id: saved.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(
      caller.preview({
        accountId: f.account.id,
        from: '2026-11-01T00:00:00Z',
        to: '2026-10-01T00:00:00Z',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.apply.apply(null, [
        { previewId: crypto.randomUUID(), beforeImages: [] } as Parameters<typeof caller.apply>[0],
      ])
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(makeUnauthedCaller().categories.rules.list()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      makeAuthedCaller(f.foreign).categories.rules.remove({ id: saved.id, expectedRevision: 1 })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await caller.list()).toHaveLength(1);
  } finally {
    await db.execute(sql`delete from transaction_category_rules where user_id = ${f.owner.id}`);
    await db.execute(sql`delete from users where id in (${f.owner.id},${f.foreign.id})`);
    await db.execute(sql`delete from institutions where id = ${f.institution.id}`);
  }
});
