/**
 * Every queue write that sets or clears a `transfer_group_id` changes what D-5
 * makes of the row — an unpaired withdrawal is an `outflow`, a paired one a
 * `transfer_out` — so each re-labels the rows it touched, in its own
 * transaction (foundation A2 D-5, ruling R4).
 *
 * Committed fixtures, the shape `TransferReviewService.test.ts` uses: several
 * of these methods open their own transaction on the global connection.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import type { NewHoldingTransaction } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { TransferReviewService } from '../../src/services/TransferReviewService';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const service = () => Container.get(TransferReviewService);
const t = schema.holdingTransactions;

async function setup() {
  return getDb().transaction(async (tx) => {
    const user = await makeUser(tx);
    const instType = await makeInstitutionType(tx, { code: 'bank' });
    const inst = await makeInstitution(tx, { typeId: instType.id });
    const outAccount = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
    const inAccount = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
    const token = await makeToken(tx);
    const outHolding = await makeHolding(tx, {
      userId: user.id,
      accountId: outAccount.id,
      tokenId: token.id,
      balance: '0',
    });
    const inHolding = await makeHolding(tx, {
      userId: user.id,
      accountId: inAccount.id,
      tokenId: token.id,
      balance: '1',
    });
    return {
      userId: user.id,
      tokenId: token.id,
      institutionId: inst.id,
      inAccountId: inAccount.id,
      outHolding: outHolding.id,
      inHolding: inHolding.id,
    };
  });
}

type Fixture = Awaited<ReturnType<typeof setup>>;
let fixture: Fixture | null = null;

beforeEach(async () => {
  fixture = await setup();
});

afterEach(async () => {
  if (!fixture) return;
  const db = getDb();
  // Users first: their holdings are what keep the token restricted.
  await db.delete(schema.users).where(eq(schema.users.id, fixture.userId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, fixture.tokenId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, fixture.institutionId));
  fixture = null;
});

const AT = () => new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const later = (at: Date, minutes: number) => new Date(at.getTime() + minutes * 60_000);

async function insertLeg(
  f: Fixture,
  fields: Partial<NewHoldingTransaction> & Pick<NewHoldingTransaction, 'kind' | 'quantity'>
): Promise<string> {
  const [row] = await getDb()
    .insert(t)
    .values({
      userId: f.userId,
      holdingId: fields.kind === 'withdraw' ? f.outHolding : f.inHolding,
      tokenId: f.tokenId,
      occurredAt: AT(),
      source: fields.kind === 'withdraw' ? 'kraken-api' : 'etherscan',
      externalId: randomUUID(),
      kindOrigin: 'source',
      ...fields,
    })
    .returning({ id: t.id });
  if (!row) throw new Error('holding_transactions insert failed');
  return row.id;
}

/** An unpaired withdrawal, labelled as the backfill labels it. */
const outflow = (f: Fixture, fields: Partial<NewHoldingTransaction> = {}) =>
  insertLeg(f, { kind: 'withdraw', quantity: '-1.0', ledgerKind: 'outflow', ...fields });

/** An unpaired deposit, labelled as the backfill labels it. */
const inflow = (f: Fixture, fields: Partial<NewHoldingTransaction> = {}) =>
  insertLeg(f, { kind: 'deposit', quantity: '1.0', ledgerKind: 'inflow', ...fields });

async function labels(ids: readonly string[]) {
  const rows = await getDb()
    .select({
      id: t.id,
      ledgerKind: t.ledgerKind,
      groupId: t.groupId,
      kindOrigin: t.kindOrigin,
      transferGroupId: t.transferGroupId,
    })
    .from(t)
    .where(inArray(t.id, [...ids]));
  return ids.map((id) => rows.find((r) => r.id === id));
}

/** The labels D-5 gives a leg, read against the group it now carries. */
function expectLabelled(
  row: Awaited<ReturnType<typeof labels>>[number],
  ledgerKind: string,
  kindOrigin: 'source' | 'person' = 'source'
) {
  expect(row).toEqual({
    id: row?.id ?? 'missing',
    ledgerKind,
    groupId: row?.transferGroupId ?? null,
    kindOrigin,
    transferGroupId: row?.transferGroupId ?? null,
  });
}

describe('answers that pair', () => {
  test('resolve paired re-labels both legs transfer_out/transfer_in', async () => {
    const f = fixture!;
    const at = AT();
    const out = await outflow(f, { occurredAt: at });
    const arrival = await inflow(f, { occurredAt: later(at, 1) });

    expect(
      await service().resolve(f.userId, out, 'paired', { matchTransactionId: arrival })
    ).toEqual({ ok: true });

    const [o, i] = await labels([out, arrival]);
    expect(o?.transferGroupId).not.toBeNull();
    expectLabelled(o, 'transfer_out');
    expectLabelled(i, 'transfer_in');
  });

  test('resolve paired with parts re-labels every part', async () => {
    const f = fixture!;
    const at = AT();
    const out = await outflow(f, { occurredAt: at, quantity: '-200' });
    const parts = [
      await inflow(f, { occurredAt: later(at, 11), quantity: '150' }),
      await inflow(f, { occurredAt: later(at, 800), quantity: '50' }),
    ];

    const result = await service().resolve(f.userId, out, 'paired', {
      matchTransactionId: parts[0],
      alsoMatchTransactionIds: parts.slice(1),
    });

    expect(result.ok).toBe(true);
    const [o, ...p] = await labels([out, ...parts]);
    expectLabelled(o, 'transfer_out');
    for (const part of p) expectLabelled(part, 'transfer_in');
  });

  test('a refused set re-labels the part it claimed and then released', async () => {
    const f = fixture!;
    const at = AT();
    const out = await outflow(f, { occurredAt: at, quantity: '-200' });
    const first = await inflow(f, { occurredAt: later(at, 11), quantity: '150' });
    const elsewhere = randomUUID();
    const taken = await inflow(f, {
      occurredAt: later(at, 800),
      quantity: '50',
      transferGroupId: elsewhere,
      ledgerKind: 'transfer_in',
      groupId: elsewhere,
    });

    const result = await service().resolve(f.userId, out, 'paired', {
      matchTransactionId: first,
      alsoMatchTransactionIds: [taken],
    });

    expect(result).toEqual({ ok: false, reason: 'partner_gone' });
    const [o, released, other] = await labels([out, first, taken]);
    expectLabelled(o, 'outflow');
    expectLabelled(released, 'inflow');
    expect(released?.transferGroupId).toBeNull();
    expectLabelled(other, 'transfer_in');
  });

  test('resolve internal labels the arrival it writes and re-labels the outflow', async () => {
    const f = fixture!;
    const out = await outflow(f, { quantity: '-4000' });

    expect(
      await service().resolve(f.userId, out, 'internal', {
        destination: { accountId: f.inAccountId, holdingId: f.inHolding },
      })
    ).toEqual({ ok: true });

    const [arrival] = await getDb()
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.userId, f.userId), eq(t.source, 'transfer-review'), eq(t.externalId, out)));
    const [o, a] = await labels([out, arrival?.id ?? 'missing']);
    expectLabelled(o, 'transfer_out');
    expectLabelled(a, 'transfer_in', 'person');
    expect(a?.transferGroupId).toBe(o?.transferGroupId ?? 'missing');
  });

  test('resolveSplit re-labels the legs of its paired part', async () => {
    const f = fixture!;
    const at = AT();
    const out = await outflow(f, { occurredAt: at, quantity: '-4000' });
    const arrival = await inflow(f, { occurredAt: later(at, 1), quantity: '3500' });

    const result = await service().resolveSplit(f.userId, out, [
      { decision: 'paired', quantity: '3500', matchTransactionId: arrival },
      { decision: 'left_control', quantity: '500' },
    ]);

    expect(result).toEqual({ ok: true });
    const [o, i] = await labels([out, arrival]);
    expectLabelled(o, 'transfer_out');
    expectLabelled(i, 'transfer_in');
  });
});

describe('writes that unpair', () => {
  /** A pair the matcher or the queue linked, labelled as the backfill labels it. */
  async function linkedPair(
    f: Fixture,
    fields: { out?: Partial<NewHoldingTransaction>; in?: Partial<NewHoldingTransaction> } = {}
  ) {
    const group = randomUUID();
    const at = AT();
    const linked = { transferGroupId: group, groupId: group };
    const out = await outflow(f, {
      occurredAt: at,
      ...linked,
      ledgerKind: 'transfer_out',
      ...fields.out,
    });
    const arrival = await inflow(f, {
      occurredAt: later(at, 1),
      ...linked,
      ledgerKind: 'transfer_in',
      ...fields.in,
    });
    return { out, arrival };
  }

  test('reopen re-labels the legs whose group it clears', async () => {
    const f = fixture!;
    const { out, arrival } = await linkedPair(f, {
      out: { transferReview: 'paired', transferReviewSource: 'user' },
    });

    expect(await service().reopen(f.userId, out)).toBe(true);

    const [o, i] = await labels([out, arrival]);
    expect(o?.transferGroupId).toBeNull();
    expectLabelled(o, 'outflow');
    expectLabelled(i, 'inflow');
  });

  test('unlinkPair re-labels both legs', async () => {
    const f = fixture!;
    const { out, arrival } = await linkedPair(f);

    expect((await service().unlinkPair(f.userId, out)).ok).toBe(true);

    const [o, i] = await labels([out, arrival]);
    expectLabelled(o, 'outflow');
    expectLabelled(i, 'inflow');
  });

  test('withdrawSameHoldingPairing re-labels both legs', async () => {
    const f = fixture!;
    // Two different upstream events on ONE holding: the matcher artifact.
    const onOneHolding = { holdingId: f.outHolding, source: 'solana' };
    const { out, arrival } = await linkedPair(f, {
      out: {
        ...onOneHolding,
        externalId: 'sigA-0',
        transferReview: 'paired',
        transferReviewSource: 'user',
      },
      in: { ...onOneHolding, externalId: 'sigB-0' },
    });

    const result = await service().withdrawSameHoldingPairing(f.userId, out);

    expect(result.ok).toBe(true);
    const [o, i] = await labels([out, arrival]);
    expectLabelled(o, 'outflow');
    expectLabelled(i, 'inflow');
  });
});
