/**
 * A5 #9. `holdings.delete` and `holdings.bulkDelete` hide a feed holding and
 * delete a person's snapshot, and they say which happened: the toast offers
 * Undo only for what was hidden, since a deleted row has nothing to restore.
 *
 * The rows are committed: the router reads through the process-wide handle.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import {
  makeAccount,
  makeHolding,
  makeInstitution,
  makeInstitutionType,
  makeToken,
  makeUser,
  restoreContainerAfterAll,
} from '@scani/domain/test-helpers';
import { BullMqEnqueueService } from '@scani/queue';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

type User = typeof schema.users.$inferSelect;
type Holding = typeof schema.holdings.$inferSelect;

let user: User;
let accountId: string;
const tokenIds: string[] = [];
const institutionIds: string[] = [];

async function holdingOf(shape: Pick<Holding, 'source' | 'kind'>): Promise<Holding> {
  const token = await makeToken(db);
  tokenIds.push(token.id);
  return makeHolding(db, { userId: user.id, accountId, tokenId: token.id, ...shape });
}

async function stored(holdingId: string) {
  const [row] = await db.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
  return row;
}

beforeAll(async () => {
  user = await makeUser(db);
  const type = await makeInstitutionType(db, { code: 'crypto_exchange' });
  const institution = await makeInstitution(db, { typeId: type.id });
  institutionIds.push(institution.id);
  accountId = (await makeAccount(db, { userId: user.id, institutionId: institution.id })).id;
  Container.set(BullMqEnqueueService, {
    add: async () => 'job-1',
  } as unknown as BullMqEnqueueService);
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, user.id));
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokenIds));
  await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutionIds));
});

describe('holdings.delete and holdings.bulkDelete (A5 #9)', () => {
  test('delete hides a feed holding and says it did', async () => {
    const feed = await holdingOf({ source: 'import_ibkr', kind: 'feed' });

    const result = await makeAuthedCaller(user).holdings.delete({ id: feed.id });

    expect(result.wasHidden).toBe(true);
    expect((await stored(feed.id))?.isHidden).toBe(true);
  });

  test('bulk delete hides the feed holdings, deletes the snapshot, and names the hidden ones', async () => {
    const feed = await holdingOf({ source: 'sync_exchange_balances', kind: 'feed' });
    const snapshot = await holdingOf({ source: 'manual', kind: 'snapshot' });

    const result = await makeAuthedCaller(user).holdings.bulkDelete({
      ids: [feed.id, snapshot.id],
    });

    expect([...result.deletedIds].sort()).toEqual([feed.id, snapshot.id].sort());
    expect(result.hiddenIds).toEqual([feed.id]);
    expect((await stored(feed.id))?.isHidden).toBe(true);
    expect(await stored(snapshot.id)).toBeUndefined();
  });
});
