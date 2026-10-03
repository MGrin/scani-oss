import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { MANUAL_EDIT_FLOW_SOURCE } from '../../../src/lib/person-authored-sources';
import { ManualEditSupersessionService } from '../../../src/services/holdings/ManualEditSupersessionService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

/**
 * A hand-typed edit equal to the SUM of rows the importer later wrote is the
 * same movement counted twice; it goes. An edit whose owner answer differs
 * from the imported row's stays, so the owner still sees it (SC-1468).
 */

const service = () => Container.get(ManualEditSupersessionService);

async function account(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const instType = await makeInstitutionType(tx);
  const inst = await makeInstitution(tx, { typeId: instType.id });
  const acct = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
  const usd = await makeToken(tx);
  const holding = await makeHolding(tx, { userId: user.id, accountId: acct.id, tokenId: usd.id });
  return { userId: user.id, tokenId: usd.id, holdingId: holding.id };
}

type Acct = Awaited<ReturnType<typeof account>>;

function tx(a: Acct, over: Partial<typeof schema.holdingTransactions.$inferInsert>) {
  return {
    userId: a.userId,
    holdingId: a.holdingId,
    tokenId: a.tokenId,
    kind: 'deposit',
    quantity: '0',
    occurredAt: new Date('2026-08-27T00:00:00Z'),
    source: 'airwallex',
    externalId: crypto.randomUUID(),
    ...over,
  };
}

const edit = (a: Acct, quantity: string, extra: Record<string, unknown> = {}) =>
  tx(a, {
    quantity,
    kind: quantity.startsWith('-') ? 'withdraw' : 'deposit',
    source: MANUAL_EDIT_FLOW_SOURCE,
    sourceMetadata: { cause: 'flow', editedAt: '2026-08-27T09:00:00Z' },
    ...extra,
  });

async function sources(t: DatabaseTransaction, holdingId: string) {
  const rows = await t
    .select({ source: schema.holdingTransactions.source })
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.holdingId, holdingId));
  return rows.map((r) => r.source).sort();
}

describe('ManualEditSupersessionService', () => {
  test('removes an unanswered edit equal to an imported deposit plus its fee', async () => {
    await withTestDb(async (t) => {
      const a = await account(t);
      await t
        .insert(schema.holdingTransactions)
        .values([
          edit(a, '5600.75'),
          tx(a, { quantity: '5617.60', occurredAt: new Date('2026-08-28T03:00:00Z') }),
          tx(a, { kind: 'fee', quantity: '-16.85', occurredAt: new Date('2026-08-28T03:00:00Z') }),
        ]);

      const out = await service().supersede(a.userId, [a.holdingId], t);

      expect(out.removedEditRowIds).toHaveLength(1);
      expect(await sources(t, a.holdingId)).toEqual(['airwallex', 'airwallex']);
    });
  });

  test('keeps an edit whose answer the imported row does not share', async () => {
    await withTestDb(async (t) => {
      const a = await account(t);
      await t.insert(schema.holdingTransactions).values([
        edit(a, '-1000', { transferReview: 'left_control' }),
        tx(a, {
          kind: 'withdraw',
          quantity: '-1000',
          occurredAt: new Date('2026-08-27T12:00:00Z'),
        }),
      ]);

      const out = await service().supersede(a.userId, [a.holdingId], t);

      expect(out.removedEditRowIds).toHaveLength(0);
      expect(out.keptForReview).toHaveLength(1);
      expect(await sources(t, a.holdingId)).toEqual(['airwallex', MANUAL_EDIT_FLOW_SOURCE].sort());
    });
  });

  test('removes an answered edit when the imported row says the same thing', async () => {
    await withTestDb(async (t) => {
      const a = await account(t);
      await t.insert(schema.holdingTransactions).values([
        edit(a, '-1000', { transferReview: 'left_control' }),
        tx(a, {
          kind: 'withdraw',
          quantity: '-1000',
          occurredAt: new Date('2026-08-27T12:00:00Z'),
          transferReview: 'left_control',
        }),
      ]);

      const out = await service().supersede(a.userId, [a.holdingId], t);

      expect(out.removedEditRowIds).toHaveLength(1);
      expect(await sources(t, a.holdingId)).toEqual(['airwallex']);
    });
  });
});
