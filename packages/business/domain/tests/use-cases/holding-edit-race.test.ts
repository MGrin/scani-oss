/**
 * Two changes to ONE holding at once (SC-1525). Each caller computes the
 * balance it writes, and `UpdateHoldingUseCase` the delta its ledger row
 * explains, from a read of the holding. Read before the row lock, that read is
 * the balance as it stood before a concurrent edit committed: the second write
 * loses the first, or its row is sized against a figure that no longer stands.
 *
 * Committed, on two connections, because the race is between two transactions.
 * In each test the second is seen blocked by the first before the first
 * commits, so what is asserted is what the second did after waiting.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { MANUAL_EDIT_FLOW_SOURCE } from '../../src/lib/person-authored-sources';
import { RecordHoldingMovementUseCase } from '../../src/use-cases/RecordHoldingMovementUseCase';
import { UpdateHoldingUseCase } from '../../src/use-cases/UpdateHoldingUseCase';
import { committedRows } from '../../test/helpers/committed-rows';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeToken,
  seedReading,
} from '../../test/helpers/factories-extra';
import { raceBehind } from '../../test/helpers/lock-wait';

const created = committedRows();
afterEach(created.drop);

const updateHolding = () => Container.get(UpdateHoldingUseCase);
const recordMovement = () => Container.get(RecordHoldingMovementUseCase);

const MOVED_AT = '2026-08-20T09:30:00.000Z';

/** A source at 500 and a destination at 130, one token, two manual accounts. */
async function committedPair() {
  return await getDb().transaction(async (tx) => {
    const user = await makeUser(tx);
    const institution = await makeInstitution(tx);
    const from = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const to = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const token = await makeToken(tx, { symbol: `R${Date.now()}` });
    const source = await makeHolding(tx, {
      userId: user.id,
      accountId: from.id,
      tokenId: token.id,
      balance: '500',
      source: 'manual',
    });
    const destination = await makeHolding(tx, {
      userId: user.id,
      accountId: to.id,
      tokenId: token.id,
      balance: '130',
      source: 'manual',
    });
    // The readings a manual holding carries since A2; the engine funds both from them.
    const read = new Date('2026-08-01T00:00:00.000Z');
    await seedReading(tx, { userId: user.id, holdingId: source.id, balance: '500', at: read });
    await seedReading(tx, { userId: user.id, holdingId: destination.id, balance: '130', at: read });
    created.users.push(user.id);
    created.tokens.push(token.id);
    created.institutions.push(institution.id);
    return { userId: user.id, source, destination };
  });
}

/** The concurrent edit every test races against: the destination set to 120. */
function editTo120(pair: Awaited<ReturnType<typeof committedPair>>) {
  return (tx: Parameters<Parameters<typeof raceBehind>[0]>[0]) =>
    updateHolding().execute(pair.destination.id, { balance: '120' }, pair.userId, tx);
}

async function balanceOf(holdingId: string): Promise<string> {
  const [row] = await getDb()
    .select({ balance: schema.holdings.balance })
    .from(schema.holdings)
    .where(eq(schema.holdings.id, holdingId));
  if (!row) throw new Error('holding vanished');
  return row.balance;
}

/** What the person's own edits on a holding say moved, summed. */
async function flowOn(holdingId: string): Promise<string> {
  const rows = await getDb()
    .select({ quantity: schema.holdingTransactions.quantity })
    .from(schema.holdingTransactions)
    .where(
      and(
        eq(schema.holdingTransactions.holdingId, holdingId),
        eq(schema.holdingTransactions.source, MANUAL_EDIT_FLOW_SOURCE)
      )
    );
  return rows.reduce((sum, row) => sum.add(row.quantity), new Decimal(0)).toString();
}

describe('concurrent changes to one holding (SC-1525)', () => {
  test('an edit to 100 racing an edit to 120 explains a step of 20, not 30', async () => {
    const pair = await committedPair();

    const blocked = await raceBehind(editTo120(pair), (tx) =>
      updateHolding().execute(
        pair.destination.id,
        { balance: '100', editCause: 'flow', editOccurredAt: new Date(MOVED_AT) },
        pair.userId,
        tx
      )
    );

    expect(blocked).toBe(true);
    expect(await balanceOf(pair.destination.id)).toBe('100');
    expect(await flowOn(pair.destination.id)).toBe('-20');
  });

  test('a movement of +10 racing an edit to 120 lands on 130', async () => {
    const pair = await committedPair();

    const blocked = await raceBehind(editTo120(pair), (tx) =>
      recordMovement().execute(
        {
          direction: 'inflow',
          holdingId: pair.destination.id,
          amount: '10',
          occurredAt: MOVED_AT,
        },
        pair.userId,
        tx
      )
    );

    expect(blocked).toBe(true);
    expect(await balanceOf(pair.destination.id)).toBe('130');
    expect(await flowOn(pair.destination.id)).toBe('10');
  });

  test('a declared transfer of 10 into a holding being edited to 120 lands on 130', async () => {
    const pair = await committedPair();

    const blocked = await raceBehind(editTo120(pair), (tx) =>
      recordMovement().execute(
        {
          direction: 'transfer',
          holdingId: pair.source.id,
          amount: '10',
          occurredAt: MOVED_AT,
          destinationAccountId: pair.destination.accountId,
          destinationHoldingId: pair.destination.id,
        },
        pair.userId,
        tx
      )
    );

    expect(blocked).toBe(true);
    expect(await balanceOf(pair.source.id)).toBe('490');
    expect(await balanceOf(pair.destination.id)).toBe('130');
  });

  test('a balance edit answered internal, into a holding being edited to 120, lands on 130', async () => {
    const pair = await committedPair();

    const blocked = await raceBehind(editTo120(pair), (tx) =>
      updateHolding().execute(
        pair.source.id,
        {
          balance: '490',
          editCause: 'flow',
          editOccurredAt: new Date(MOVED_AT),
          editOutflow: {
            decision: 'internal',
            destination: {
              accountId: pair.destination.accountId,
              holdingId: pair.destination.id,
            },
          },
        },
        pair.userId,
        tx
      )
    );

    expect(blocked).toBe(true);
    expect(await balanceOf(pair.source.id)).toBe('490');
    expect(await balanceOf(pair.destination.id)).toBe('130');
  });
});
