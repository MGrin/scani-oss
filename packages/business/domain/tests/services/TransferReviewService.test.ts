/**
 * `TransferReviewService` integration tests (SC-150).
 *
 * Same isolation shape as `LinkTransferPairsUseCase.test.ts` and for the same
 * reason: the service reaches for the global `db` rather than an injected
 * transaction, so `withTestDb`'s rollback cannot wrap it. A fresh user per
 * test scopes every query naturally, and `afterEach` cascades it away.
 *
 * These are integration tests rather than stubbed-DI ones on purpose. Nearly
 * everything this service asserts *is* the SQL — that the queue is exactly the
 * rows the matcher declined, that a decision is atomic across two rows, that
 * reopening clears both legs — and a stubbed repository would be a test of the
 * stub.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';

import { TransferReviewService } from '../../src/services/TransferReviewService';

interface Fixture {
  userId: string;
  tokenId: string;
  outHoldingId: string;
  inHoldingId: string;
  institutionTypeId: string;
  institutionId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

let fixture: Fixture | null = null;

/** Recent enough that nothing ages out of any lookback window. */
function anchor(): Date {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

async function setupFixture(): Promise<Fixture> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `tr-${randomUUID().slice(0, 8)}@scani.local`, name: 'TransferReviewTest' })
    .returning();
  if (!user) throw new Error('user insert failed');

  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `tr-${randomUUID().slice(0, 6)}`, name: 'TR Type' })
    .returning();
  if (!instType) throw new Error('instType insert failed');
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `TR-${randomUUID().slice(0, 6)}`, typeId: instType.id })
    .returning();
  if (!inst) throw new Error('inst insert failed');
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `tr-acct-${randomUUID().slice(0, 6)}`, name: 'TR Account' })
    .returning();
  if (!acctType) throw new Error('acctType insert failed');

  const [outAccount] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `exchange-${randomUUID().slice(0, 6)}`,
    })
    .returning();
  const [inAccount] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `wallet-${randomUUID().slice(0, 6)}`,
    })
    .returning();
  if (!outAccount || !inAccount) throw new Error('account insert failed');

  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `tr-tok-${randomUUID().slice(0, 6)}`, name: 'TR Token Type' })
    .returning();
  if (!tokenType) throw new Error('tokenType insert failed');
  const [token] = await db
    .insert(schema.tokens)
    .values({
      symbol: `TR${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'TR Token',
      typeId: tokenType.id,
    })
    .returning();
  if (!token) throw new Error('token insert failed');

  const [outHolding] = await db
    .insert(schema.holdings)
    .values({ userId: user.id, accountId: outAccount.id, tokenId: token.id, balance: '0' })
    .returning();
  const [inHolding] = await db
    .insert(schema.holdings)
    .values({ userId: user.id, accountId: inAccount.id, tokenId: token.id, balance: '1' })
    .returning();
  if (!outHolding || !inHolding) throw new Error('holding insert failed');

  return {
    userId: user.id,
    tokenId: token.id,
    outHoldingId: outHolding.id,
    inHoldingId: inHolding.id,
    institutionTypeId: instType.id,
    institutionId: inst.id,
    accountTypeId: acctType.id,
    tokenTypeId: tokenType.id,
  };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, f.userId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.tokenId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
}

async function insertOutflow(
  f: Fixture,
  opts: {
    at: Date;
    quantity?: string;
    externalId: string;
    kind?: string;
    transferGroupId?: string;
    transferReview?: string;
  }
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: f.outHoldingId,
      tokenId: f.tokenId,
      kind: opts.kind ?? 'withdraw',
      quantity: opts.quantity ?? '-1.0',
      occurredAt: opts.at,
      source: 'kraken-api',
      externalId: opts.externalId,
      ...(opts.transferGroupId ? { transferGroupId: opts.transferGroupId } : {}),
      ...(opts.transferReview ? { transferReview: opts.transferReview } : {}),
    })
    .returning();
  if (!row) throw new Error('outflow insert failed');
  return row.id;
}

async function insertInflow(
  f: Fixture,
  opts: { at: Date; quantity: string; externalId: string; transferGroupId?: string }
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: f.inHoldingId,
      tokenId: f.tokenId,
      kind: 'deposit',
      quantity: opts.quantity,
      occurredAt: opts.at,
      source: 'etherscan',
      externalId: opts.externalId,
      ...(opts.transferGroupId ? { transferGroupId: opts.transferGroupId } : {}),
    })
    .returning();
  if (!row) throw new Error('inflow insert failed');
  return row.id;
}

/**
 * A real instance, constructed directly rather than pulled from the container.
 *
 * `ReviewFeedService.test.ts` stubs `TransferReviewService` on the container to
 * isolate the feed's own collector, and a `Container.set` is permanent for the
 * process — so `Container.get` here returns that stub whenever the two files
 * share a `bun test` run. In isolation the tests passed and in the suite they
 * failed with "listPending is not a function", which is the same trap the DI
 * note in CLAUDE.md describes from the other direction.
 *
 * Constructing it runs the class-field initialisers against whatever the
 * container holds for its own dependencies, which is what we want: these tests
 * exercise the real SQL.
 */
function service(): TransferReviewService {
  return new TransferReviewService();
}

beforeEach(async () => {
  fixture = await setupFixture();
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

describe('TransferReviewService — the queue', () => {
  test('is empty when there is nothing to answer', async () => {
    const f = fixture!;
    expect(await service().listPending(f.userId)).toEqual([]);
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('holds an unpaired outflow, and drops it once a group id is set', async () => {
    const f = fixture!;
    await insertOutflow(f, { at: anchor(), externalId: 'q-1' });
    expect((await service().pendingSummary(f.userId)).count).toBe(1);

    await db
      .update(schema.holdingTransactions)
      .set({ transferGroupId: randomUUID() })
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('excludes an outflow a human has already answered', async () => {
    const f = fixture!;
    await insertOutflow(f, { at: anchor(), externalId: 'q-2', transferReview: 'untracked' });
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('ignores inflows entirely — only an outflow can be a question', async () => {
    const f = fixture!;
    await insertInflow(f, { at: anchor(), quantity: '1.0', externalId: 'q-3' });
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });
});

describe('TransferReviewService — candidates', () => {
  test('labels a same-window same-amount deposit as ambiguous only when another matches too', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'c-1' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 5 * 60_000),
      quantity: '0.999',
      externalId: 'c-in-1',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates).toHaveLength(1);
    // One viable candidate. The matcher would have taken it — which is why it
    // is marked `withinStrictTolerance` — and the only reason this row is in
    // the queue at all in a real system is that the matcher had not yet run.
    expect(item?.candidates[0]?.withinStrictTolerance).toBe(true);
    expect(item?.candidates[0]?.reason).toBe('ambiguous');
  });

  test('explains a deposit that is the right amount but hours late', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'c-2' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 4 * 60 * 60_000),
      quantity: '1.0',
      externalId: 'c-in-2',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates[0]?.reason).toBe('time_outside_window');
    expect(item?.candidates[0]?.withinStrictTolerance).toBe(false);
    // Signed: the deposit landed after the withdrawal.
    expect(item?.candidates[0]?.timeDeltaMs).toBeGreaterThan(0);
  });

  test('explains a deposit that is on time but outside the fee tolerance', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'c-3' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '0.95',
      externalId: 'c-in-3',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates[0]?.reason).toBe('quantity_outside_tolerance');
    // 5% smaller than the outflow — negative, which is the ordinary
    // fee-shaped direction.
    expect(item?.candidates[0]?.quantityDeltaPct).toBeCloseTo(-5, 3);
  });

  test('does not offer a deposit whose amount is nowhere near, even in the window', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'c-4' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '0.4',
      externalId: 'c-in-4',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates).toEqual([]);
  });

  test('does not offer a deposit already paired to something else', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'c-5' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '1.0',
      externalId: 'c-in-5',
      transferGroupId: randomUUID(),
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates).toEqual([]);
  });

  test('ranks the candidate the matcher would have taken above the near misses', async () => {
    const f = fixture!;
    const at = anchor();
    await insertOutflow(f, { at, externalId: 'c-6' });
    await insertInflow(f, {
      at: new Date(at.getTime() + 3 * 60 * 60_000),
      quantity: '1.0',
      externalId: 'c-in-6a',
    });
    await insertInflow(f, {
      at: new Date(at.getTime() + 2 * 60_000),
      quantity: '0.998',
      externalId: 'c-in-6b',
    });

    const [item] = await service().listPending(f.userId);
    expect(item?.candidates[0]?.reason).toBe('ambiguous');
    expect(item?.candidates[1]?.reason).toBe('time_outside_window');
  });
});

describe('TransferReviewService — answers', () => {
  test('pairing writes one group id across both legs and stamps the decision', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, externalId: 'a-1' });
    const inId = await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '1.0',
      externalId: 'a-in-1',
    });

    expect(await service().resolve(f.userId, outId, 'paired', inId)).toBe(true);

    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    const out = rows.find((r) => r.id === outId);
    const inflow = rows.find((r) => r.id === inId);
    expect(out?.transferGroupId).toBeTruthy();
    expect(inflow?.transferGroupId).toBe(out?.transferGroupId ?? null);
    expect(out?.transferReview).toBe('paired');
    expect(out?.transferReviewedAt).toBeTruthy();
    // The inflow is *linked*, not *reviewed*: the question was asked about the
    // withdrawal, and stamping the deposit too would claim someone answered a
    // question that was never put to them.
    expect(inflow?.transferReview).toBeNull();
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('a disposal and an untracked move both leave the queue without a group id', async () => {
    const f = fixture!;
    const leftId = await insertOutflow(f, { at: anchor(), externalId: 'a-2' });
    const goneId = await insertOutflow(f, { at: anchor(), externalId: 'a-3' });

    expect(await service().resolve(f.userId, leftId, 'left_control')).toBe(true);
    expect(await service().resolve(f.userId, goneId, 'untracked')).toBe(true);

    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect(rows.find((r) => r.id === leftId)?.transferReview).toBe('left_control');
    expect(rows.find((r) => r.id === goneId)?.transferReview).toBe('untracked');
    expect(rows.every((r) => r.transferGroupId === null)).toBe(true);
    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('answering the same row twice is a no-op, not a second write', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), externalId: 'a-4' });
    expect(await service().resolve(f.userId, outId, 'untracked')).toBe(true);
    expect(await service().resolve(f.userId, outId, 'left_control')).toBe(false);

    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, outId));
    expect(row?.transferReview).toBe('untracked');
  });

  test('refuses to pair with a deposit that was claimed in the meantime', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, externalId: 'a-5' });
    const inId = await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '1.0',
      externalId: 'a-in-5',
      transferGroupId: randomUUID(),
    });

    expect(await service().resolve(f.userId, outId, 'paired', inId)).toBe(false);

    // And crucially: the outflow is untouched, still in the queue. A refused
    // pairing that half-applied would leave a group id pointing at nothing.
    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, outId));
    expect(row?.transferGroupId).toBeNull();
    expect(row?.transferReview).toBeNull();
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('will not answer another user’s transfer', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), externalId: 'a-6' });
    expect(await service().resolve(randomUUID(), outId, 'untracked')).toBe(false);
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('reopening a pairing clears the group id from BOTH legs', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, externalId: 'a-7' });
    const inId = await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '1.0',
      externalId: 'a-in-7',
    });
    await service().resolve(f.userId, outId, 'paired', inId);

    expect(await service().reopen(f.userId, outId)).toBe(true);

    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    expect(rows.every((r) => r.transferGroupId === null)).toBe(true);
    expect(rows.find((r) => r.id === outId)?.transferReview).toBeNull();
    expect(rows.find((r) => r.id === outId)?.transferReviewedAt).toBeNull();
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('reopening something nobody answered is a no-op', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), externalId: 'a-8' });
    expect(await service().reopen(f.userId, outId)).toBe(false);
  });

  test('a "paired" decision with no partner is a programming error, not a silent write', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), externalId: 'a-9' });
    await expect(service().resolve(f.userId, outId, 'paired')).rejects.toThrow(
      /requires matchTransactionId/
    );
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });
});

/**
 * Answering PART of a transfer (SC-181).
 *
 * The reported case is the first test verbatim: a 4,000 USD Airwallex
 * withdrawal of which 3,500 moved to an untracked account and 500 genuinely
 * left. Every SC-150 answer is about the whole row, so before this the only
 * options were to overstate the realized gain by 3,500 or understate it by
 * 500 — wrong in a direction either way.
 */
describe('TransferReviewService — a divided answer', () => {
  test('records the reported 3,500 untracked / 500 disposed division', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, {
      at: anchor(),
      quantity: '-4000',
      externalId: 's-1',
    });

    const result = await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '3500' },
      { decision: 'left_control', quantity: '500' },
    ]);

    expect(result).toEqual({ ok: true });
    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, outId));
    expect(row?.transferReview).toBe('split');
    expect(row?.transferReviewSplit).toEqual([
      { decision: 'untracked', quantity: '3500' },
      { decision: 'left_control', quantity: '500' },
    ]);
    expect(row?.transferReviewedAt).not.toBeNull();
  });

  test('a split leaves the queue — the count still reaches zero', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 's-2' });
    expect((await service().pendingSummary(f.userId)).count).toBe(1);

    await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '60' },
      { decision: 'left_control', quantity: '40' },
    ]);

    expect((await service().pendingSummary(f.userId)).count).toBe(0);
  });

  test('refuses parts that do not add up, and says what they should add up to', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-4000', externalId: 's-3' });

    const short = await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '3500' },
      { decision: 'left_control', quantity: '400' },
    ]);
    expect(short).toEqual({ ok: false, reason: 'sum', expected: '4000' });

    const over = await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '3500' },
      { decision: 'left_control', quantity: '600' },
    ]);
    expect(over).toEqual({ ok: false, reason: 'sum', expected: '4000' });

    // Nothing was written by either attempt — the row is still a question.
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('rejects a one-part "split", which is a whole answer wearing a list', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 's-4' });
    const result = await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '100' },
    ]);
    expect(result.ok).toBe(false);
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('rejects the same outcome twice', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 's-5' });
    const result = await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '60' },
      { decision: 'untracked', quantity: '40' },
    ]);
    expect(result.ok).toBe(false);
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('a paired part links its deposit and writes the group id on both legs', async () => {
    const f = fixture!;
    const at = anchor();
    // The fee-shaped case: 4,000 left, 3,500 arrived, 500 was the fee. The
    // matcher refuses it at 12.5% outside its ±1%, and neither whole answer is
    // true of it.
    const outId = await insertOutflow(f, { at, quantity: '-4000', externalId: 's-6' });
    const inId = await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '3500',
      externalId: 's-in-6',
    });

    const result = await service().resolveSplit(f.userId, outId, [
      { decision: 'paired', quantity: '3500', matchTransactionId: inId },
      { decision: 'left_control', quantity: '500' },
    ]);

    expect(result).toEqual({ ok: true });
    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    const out = rows.find((r) => r.id === outId);
    const inflow = rows.find((r) => r.id === inId);
    expect(out?.transferGroupId).not.toBeNull();
    expect(inflow?.transferGroupId).toBe(out?.transferGroupId ?? '');
    expect(out?.transferReview).toBe('split');
  });

  test('refuses a paired part whose deposit was claimed in the meantime', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, quantity: '-4000', externalId: 's-7' });
    const inId = await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '3500',
      externalId: 's-in-7',
      transferGroupId: randomUUID(),
    });

    const result = await service().resolveSplit(f.userId, outId, [
      { decision: 'paired', quantity: '3500', matchTransactionId: inId },
      { decision: 'left_control', quantity: '500' },
    ]);

    expect(result).toEqual({ ok: false, reason: 'partner_gone' });
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('a split is reversible — reopening clears the parts and both group ids', async () => {
    const f = fixture!;
    const at = anchor();
    const outId = await insertOutflow(f, { at, quantity: '-4000', externalId: 's-8' });
    const inId = await insertInflow(f, {
      at: new Date(at.getTime() + 60_000),
      quantity: '3500',
      externalId: 's-in-8',
    });
    await service().resolveSplit(f.userId, outId, [
      { decision: 'paired', quantity: '3500', matchTransactionId: inId },
      { decision: 'untracked', quantity: '500' },
    ]);

    expect(await service().reopen(f.userId, outId)).toBe(true);

    const rows = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.userId, f.userId));
    const out = rows.find((r) => r.id === outId);
    expect(out?.transferReview).toBeNull();
    expect(out?.transferReviewSplit).toBeNull();
    expect(rows.every((r) => r.transferGroupId === null)).toBe(true);
    expect((await service().pendingSummary(f.userId)).count).toBe(1);
  });

  test('answering whole after a split clears the division', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 's-9' });
    await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '60' },
      { decision: 'left_control', quantity: '40' },
    ]);
    await service().reopen(f.userId, outId);
    expect(await service().resolve(f.userId, outId, 'left_control')).toBe(true);

    const [row] = await db
      .select()
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, outId));
    expect(row?.transferReview).toBe('left_control');
    expect(row?.transferReviewSplit).toBeNull();
  });

  test('will not divide another user’s transfer', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-100', externalId: 's-10' });
    const result = await service().resolveSplit(randomUUID(), outId, [
      { decision: 'untracked', quantity: '60' },
      { decision: 'left_control', quantity: '40' },
    ]);
    expect(result).toEqual({ ok: false, reason: 'gone' });
  });
});

/**
 * The route back to an answer already given (SC-181).
 *
 * 573 transfers were answered `left_control` in one bulk pass before an answer
 * could apply to part of a transaction, so a list that only ever shows
 * unanswered rows leaves the reported withdrawal unreachable.
 */
describe('TransferReviewService — answered transfers', () => {
  test('lists answered outflows and never unanswered ones', async () => {
    const f = fixture!;
    const answeredId = await insertOutflow(f, {
      at: anchor(),
      externalId: 'an-1',
      transferReview: 'left_control',
    });
    await insertOutflow(f, { at: anchor(), externalId: 'an-2' });

    const rows = await service().listAnswered(f.userId);
    expect(rows.map((r) => r.transactionId)).toEqual([answeredId]);
    expect(rows[0]?.decision).toBe('left_control');
    expect(rows[0]?.split).toBeNull();
  });

  test('carries the parts of a divided answer', async () => {
    const f = fixture!;
    const outId = await insertOutflow(f, { at: anchor(), quantity: '-4000', externalId: 'an-3' });
    await service().resolveSplit(f.userId, outId, [
      { decision: 'untracked', quantity: '3500' },
      { decision: 'left_control', quantity: '500' },
    ]);

    const rows = await service().listAnswered(f.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe('split');
    expect(rows[0]?.split).toEqual([
      { decision: 'untracked', quantity: '3500' },
      { decision: 'left_control', quantity: '500' },
    ]);
    expect(rows[0]?.quantity).toBe('4000');
  });

  test('is nobody else’s list', async () => {
    const f = fixture!;
    await insertOutflow(f, { at: anchor(), externalId: 'an-4', transferReview: 'untracked' });
    expect(await service().listAnswered(randomUUID())).toEqual([]);
  });
});
