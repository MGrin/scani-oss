/**
 * Pairing two legs changes what D-5 makes of them — an unpaired withdrawal is
 * an `outflow`, a paired one a `transfer_out` — so both linking paths re-label
 * the legs they pair, in the transaction that pairs them (foundation A2 D-5).
 *
 * The nightly pass reads and writes through the global connection, so its
 * fixture is committed and deleted afterwards, the shape
 * `LinkTransferPairsUseCase.test.ts` uses for the same reason.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { type DatabaseTransaction, getDb } from '@scani/db';
import type { NewHoldingTransaction } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { FoundationClassificationService } from '../../src/services/foundation/FoundationClassificationService';
import { LinkTransferPairsUseCase } from '../../src/use-cases/LinkTransferPairsUseCase';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';
import { expectLabelsSettled } from '../../test/helpers/labels-settled';

const linker = () => Container.get(LinkTransferPairsUseCase);
const t = schema.holdingTransactions;

async function twoHoldings(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const instType = await makeInstitutionType(tx, { code: 'bank' });
  const inst = await makeInstitution(tx, { typeId: instType.id });
  const from = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
  const to = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
  const token = await makeToken(tx);
  const fromHolding = await makeHolding(tx, {
    userId: user.id,
    accountId: from.id,
    tokenId: token.id,
  });
  const toHolding = await makeHolding(tx, { userId: user.id, accountId: to.id, tokenId: token.id });
  return {
    userId: user.id,
    tokenId: token.id,
    institutionId: inst.id,
    from: fromHolding.id,
    to: toHolding.id,
  };
}

type Fixture = Awaited<ReturnType<typeof twoHoldings>>;

async function insertLeg(
  tx: DatabaseTransaction,
  f: Fixture,
  fields: Partial<NewHoldingTransaction> & Pick<NewHoldingTransaction, 'holdingId' | 'kind'>
) {
  const [row] = await tx
    .insert(t)
    .values({
      userId: f.userId,
      tokenId: f.tokenId,
      quantity: '1',
      occurredAt: new Date(),
      source: 'kraken-api',
      externalId: crypto.randomUUID(),
      ...fields,
    })
    .returning();
  if (!row) throw new Error('holding_transactions insert failed');
  return row;
}

function legLabels(tx: DatabaseTransaction, ids: readonly string[]) {
  return tx
    .select({
      id: t.id,
      ledgerKind: t.ledgerKind,
      groupId: t.groupId,
      kindOrigin: t.kindOrigin,
      transferGroupId: t.transferGroupId,
    })
    .from(t)
    .where(inArray(t.id, [...ids]));
}

describe('linkDeclaredPair', () => {
  test('linkDeclaredPair leaves both legs labelled transfer_out/transfer_in with group_id = transfer_group_id', async () => {
    await withTestDb(async (tx) => {
      const f = await twoHoldings(tx);
      // Labelled as the backfill labels two unpaired legs.
      const out = await insertLeg(tx, f, {
        holdingId: f.from,
        kind: 'withdraw',
        quantity: '-1',
        source: 'user-balance-edit',
        externalId: 'declared:out',
        ledgerKind: 'outflow',
        kindOrigin: 'person',
      });
      const arrival = await insertLeg(tx, f, {
        holdingId: f.to,
        kind: 'deposit',
        source: 'user-balance-edit',
        externalId: 'declared:in',
        ledgerKind: 'inflow',
        kindOrigin: 'person',
      });

      const groupId = await linker().linkDeclaredPair(
        {
          outflow: { holdingId: f.from, source: 'user-balance-edit', externalId: 'declared:out' },
          inflow: { holdingId: f.to, source: 'user-balance-edit', externalId: 'declared:in' },
          userId: f.userId,
        },
        tx
      );

      expect(groupId).not.toBeNull();
      const legs = await legLabels(tx, [out.id, arrival.id]);
      expect(legs.find((l) => l.id === out.id)).toEqual({
        id: out.id,
        ledgerKind: 'transfer_out',
        groupId,
        kindOrigin: 'person',
        transferGroupId: groupId,
      });
      expect(legs.find((l) => l.id === arrival.id)).toEqual({
        id: arrival.id,
        ledgerKind: 'transfer_in',
        groupId,
        kindOrigin: 'person',
        transferGroupId: groupId,
      });
    });
  });
});

describe('the nightly CEX-to-wallet pass', () => {
  const createdUserIds: string[] = [];
  const createdTokenIds: string[] = [];
  const createdInstitutionIds: string[] = [];

  afterEach(async () => {
    const db = getDb();
    const users = createdUserIds.splice(0);
    const tokens = createdTokenIds.splice(0);
    const institutions = createdInstitutionIds.splice(0);
    // Users first: their holdings are what keep the token restricted.
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    if (tokens.length) await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
    if (institutions.length) {
      await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
    }
  });

  test('a pair the nightly pass links reads transfer_out/transfer_in with group_id = transfer_group_id', async () => {
    const at = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const { f, withdrawal, deposit } = await getDb().transaction(async (tx) => {
      const f = await twoHoldings(tx);
      createdUserIds.push(f.userId);
      createdTokenIds.push(f.tokenId);
      createdInstitutionIds.push(f.institutionId);
      const withdrawal = await insertLeg(tx, f, {
        holdingId: f.from,
        kind: 'withdraw',
        quantity: '-1.0',
        occurredAt: at,
        source: 'kraken-api',
        externalId: 'k-w-1',
      });
      const deposit = await insertLeg(tx, f, {
        holdingId: f.to,
        kind: 'deposit',
        quantity: '0.995',
        occurredAt: new Date(at.getTime() + 5 * 60 * 1000),
        source: 'etherscan',
        externalId: 'e-d-1',
      });
      return { f, withdrawal, deposit };
    });
    // The backfill labels both legs while they are unpaired.
    await Container.get(FoundationClassificationService).classify({
      apply: true,
      userId: f.userId,
    });
    const before = await legLabels(getDb(), [withdrawal.id, deposit.id]);
    expect(before.map((l) => l.ledgerKind).sort()).toEqual(['inflow', 'outflow']);

    const summary = await linker().execute({ userId: f.userId });

    expect(summary.linked).toBe(1);
    const legs = await legLabels(getDb(), [withdrawal.id, deposit.id]);
    const transferGroupId = legs[0]?.transferGroupId ?? null;
    expect(transferGroupId).not.toBeNull();
    expect(legs.find((l) => l.id === withdrawal.id)).toEqual({
      id: withdrawal.id,
      ledgerKind: 'transfer_out',
      groupId: transferGroupId,
      kindOrigin: 'source',
      transferGroupId,
    });
    expect(legs.find((l) => l.id === deposit.id)).toEqual({
      id: deposit.id,
      ledgerKind: 'transfer_in',
      groupId: transferGroupId,
      kindOrigin: 'source',
      transferGroupId,
    });
    await expectLabelsSettled(f.userId);
  });
});
