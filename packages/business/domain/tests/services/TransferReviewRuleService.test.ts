/**
 * `TransferReviewRuleService` integration tests (SC-375).
 *
 * Integration rather than stubbed-DI for the same reason the queue's own tests
 * are: nearly everything asserted here *is* the SQL. That a rule reads the
 * address out of the payload rather than the column is the difference between
 * this feature working and it matching zero rows in production — 215 of 215
 * chain outflows have `counterparty` NULL — and a stubbed repository would
 * assert that a stub returns what it was given.
 *
 * The refusals get as much room as the successes on purpose. The rule key is a
 * field an attacker can write to, so what this service *declines* to make a
 * rule from is the security argument: a row that is not yours, a row that is
 * already answered, and a row with quantity zero (the address-poisoning corpus
 * itself) each get their own test.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, sql } from 'drizzle-orm';
import Container from 'typedi';

import { TransferReviewRuleService } from '../../src/services/TransferReviewRuleService';
import { TransferReviewService } from '../../src/services/TransferReviewService';
import { restoreContainerAfterAll } from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

interface Fixture {
  userId: string;
  otherUserId: string;
  tokenId: string;
  holdingId: string;
  accountId: string;
  institutionId: string;
  institutionTypeId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

let fixture: Fixture | null = null;

/** Two addresses differing in a single character — the shape address
 *  poisoning actually plants. Invented; the single-character difference is the
 *  fixture's whole point, so a replacement that broke it would make every test
 *  below assert nothing. */
const ADDRESS = '0x7A3f91B2c4D5e6F708192a3B4c5D6e7F8091A2b3';
const LOOKALIKE = '0x7A3f91B2c4D5e6F708192a3B4c5D6e7F8091A2b4';

function anchor(): Date {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

async function setupFixture(): Promise<Fixture> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `trr-${randomUUID().slice(0, 8)}@scani.local`, name: 'RuleTest' })
    .returning();
  const [otherUser] = await db
    .insert(schema.users)
    .values({ email: `trr-${randomUUID().slice(0, 8)}@scani.local`, name: 'RuleTestOther' })
    .returning();
  if (!user || !otherUser) throw new Error('user insert failed');

  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `trr-${randomUUID().slice(0, 6)}`, name: 'RR Type' })
    .returning();
  if (!instType) throw new Error('instType insert failed');
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `RR-${randomUUID().slice(0, 6)}`, typeId: instType.id })
    .returning();
  if (!inst) throw new Error('inst insert failed');
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `rr-acct-${randomUUID().slice(0, 6)}`, name: 'RR Account' })
    .returning();
  if (!acctType) throw new Error('acctType insert failed');
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `wallet-${randomUUID().slice(0, 6)}`,
      metadata: { chainId: '1' },
    })
    .returning();
  if (!account) throw new Error('account insert failed');
  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `rr-tok-${randomUUID().slice(0, 6)}`, name: 'RR Token Type' })
    .returning();
  if (!tokenType) throw new Error('tokenType insert failed');
  const [token] = await db
    .insert(schema.tokens)
    .values({ symbol: `RR${randomUUID().toUpperCase()}`, name: 'RR Token', typeId: tokenType.id })
    .returning();
  if (!token) throw new Error('token insert failed');
  const [holding] = await db
    .insert(schema.holdings)
    .values({ userId: user.id, accountId: account.id, tokenId: token.id, balance: '0' })
    .returning();
  if (!holding) throw new Error('holding insert failed');

  return {
    userId: user.id,
    otherUserId: otherUser.id,
    tokenId: token.id,
    holdingId: holding.id,
    accountId: account.id,
    institutionId: inst.id,
    institutionTypeId: instType.id,
    accountTypeId: acctType.id,
    tokenTypeId: tokenType.id,
  };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  await db.delete(schema.users).where(eq(schema.users.id, f.userId));
  await db.delete(schema.users).where(eq(schema.users.id, f.otherUserId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.tokenId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
}

/**
 * An outflow shaped the way production's are: `counterparty` NULL and the
 * destination only in the payload. Passing `counterparty` explicitly is the
 * exception here, not the default, because the default is what 215 of 215
 * chain rows look like.
 */
async function insertOutflow(
  f: Fixture,
  opts: {
    externalId: string;
    to?: string | null;
    counterparty?: string;
    quantity?: string;
    kind?: string;
    source?: string;
    transferReview?: string;
    transferReviewedAt?: Date;
    transferReviewSource?: string;
    transferGroupId?: string;
    userId?: string;
  }
): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: opts.userId ?? f.userId,
      holdingId: f.holdingId,
      tokenId: f.tokenId,
      kind: opts.kind ?? 'withdraw',
      quantity: opts.quantity ?? '-1.0',
      occurredAt: anchor(),
      source: opts.source ?? 'etherscan',
      externalId: opts.externalId,
      ...(opts.to === undefined ? {} : { rawPayload: { to: opts.to } }),
      ...(opts.counterparty ? { counterparty: opts.counterparty } : {}),
      ...(opts.transferReview ? { transferReview: opts.transferReview } : {}),
      ...(opts.transferReviewedAt ? { transferReviewedAt: opts.transferReviewedAt } : {}),
      ...(opts.transferReviewSource ? { transferReviewSource: opts.transferReviewSource } : {}),
      ...(opts.transferGroupId ? { transferGroupId: opts.transferGroupId } : {}),
    })
    .returning();
  if (!row) throw new Error('outflow insert failed');
  return row.id;
}

/** Constructed directly rather than through the container, for the reason
 *  `TransferReviewService.test.ts` gives: a `Container.set` in a sibling test
 *  file is permanent for the process. */
function service(): TransferReviewRuleService {
  return new TransferReviewRuleService();
}

beforeEach(async () => {
  // Three sibling files (`ReviewFeedService*.test.ts`) put a STUB
  // `TransferReviewService` on the container, and a `Container.set` is
  // permanent for the process — so whether `rules.create` reaches a real
  // service depends on file order. It is re-seeded here rather than worked
  // around, because `create` genuinely delegates to it now (SC-380): the
  // own-wallet refusal and the apply-on-author both live there, and stubbing
  // them out would leave these tests asserting that a fake returns what it was
  // handed.
  Container.set(TransferReviewService, new TransferReviewService());
  fixture = await setupFixture();
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

describe('TransferReviewRuleService — authoring', () => {
  test('copies the destination off the transaction, normalized', async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, { externalId: 'r-1', to: ADDRESS });

    const result = await service().create(f.userId, {
      transactionId: txId,
      verdict: 'not_a_disposal',
      note: 'my Bybit deposit',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Stored lowercased, and stored WHOLE. The truncated form the UI renders
    // is twelve characters two addresses can share cheaply.
    expect(result.rule.matchCounterparty).toBe(ADDRESS.toLowerCase());
    expect(result.rule.verdict).toBe('not_a_disposal');
    expect(result.rule.note).toBe('my Bybit deposit');
  });

  test('reads the address from the payload when the column is null', async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, { externalId: 'r-2', to: ADDRESS });

    const [row] = await db
      .select({ counterparty: schema.holdingTransactions.counterparty })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, txId));
    // The precondition, asserted rather than assumed: this is the production
    // state of every chain outflow, and a rule engine reading the column would
    // find nothing here and report success (SC-329's bug shape).
    expect(row?.counterparty).toBeNull();

    const result = await service().create(f.userId, {
      transactionId: txId,
      verdict: 'ask_me',
      note: 'from the payload',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rule.matchCounterparty).toBe(ADDRESS.toLowerCase());
  });

  test('prefers the stored column when it is filled', async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, {
      externalId: 'r-3',
      to: LOOKALIKE,
      counterparty: ADDRESS,
    });

    const result = await service().create(f.userId, {
      transactionId: txId,
      verdict: 'ask_me',
      note: 'column wins',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rule.matchCounterparty).toBe(ADDRESS.toLowerCase());
  });

  test("refuses a transaction that is not the caller's", async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, { externalId: 'r-4', to: ADDRESS });

    const result = await service().create(f.otherUserId, {
      transactionId: txId,
      verdict: 'not_a_disposal',
      note: 'not mine',
    });
    expect(result).toEqual({ ok: false, reason: 'gone' });
    expect(await service().list(f.otherUserId)).toEqual([]);
  });

  test('refuses a transfer that already carries an answer, and leaves the answer alone', async () => {
    const f = fixture!;
    const answeredAt = new Date();
    const txId = await insertOutflow(f, {
      externalId: 'r-5',
      to: ADDRESS,
      transferReview: 'left_control',
      transferReviewedAt: answeredAt,
      transferReviewSource: 'user',
    });

    const result = await service().create(f.userId, {
      transactionId: txId,
      verdict: 'not_a_disposal',
      note: 'would overwrite',
    });
    expect(result).toEqual({ ok: false, reason: 'gone' });

    // The invariant stated as a test rather than a comment: a rule never reads
    // or writes a row that has an answer, so "never overwrite a `user` answer"
    // is true by construction — there is no path from here to that column.
    const [row] = await db
      .select({
        review: schema.holdingTransactions.transferReview,
        source: schema.holdingTransactions.transferReviewSource,
      })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, txId));
    expect(row?.review).toBe('left_control');
    expect(row?.source).toBe('user');
  });

  test('refuses a zero-quantity row — the address-poisoning corpus', async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, { externalId: 'r-6', to: ADDRESS, quantity: '0' });

    const result = await service().create(f.userId, {
      transactionId: txId,
      verdict: 'not_a_disposal',
      note: 'planted',
    });
    // These rows appear on no screen — the queue excludes them — so a rule
    // authored from one could not have been read by anybody, which is exactly
    // the transcription the authoring path exists to prevent.
    expect(result).toEqual({ ok: false, reason: 'gone' });
  });

  test('refuses a transfer with no destination anywhere', async () => {
    const f = fixture!;
    // 202 of 470 production outflows are this: a Kraken withdrawal record does
    // not say where the money went, Solana rows carry no payload at all, and
    // no design fixes either.
    const txId = await insertOutflow(f, { externalId: 'r-7' });

    const result = await service().create(f.userId, {
      transactionId: txId,
      verdict: 'not_a_disposal',
      note: 'nowhere',
    });
    expect(result).toEqual({ ok: false, reason: 'no_counterparty' });
  });

  test('refuses a second active rule on the same destination, and names it', async () => {
    const f = fixture!;
    const first = await insertOutflow(f, { externalId: 'r-8a', to: ADDRESS });
    // A second transfer to the same place, written in the other case EVM
    // addresses travel in.
    const second = await insertOutflow(f, { externalId: 'r-8b', to: ADDRESS.toLowerCase() });

    expect(
      (
        await service().create(f.userId, {
          transactionId: first,
          verdict: 'not_a_disposal',
          note: 'first',
        })
      ).ok
    ).toBe(true);

    const result = await service().create(f.userId, {
      transactionId: second,
      verdict: 'ask_me',
      note: 'second',
    });
    expect(result).toEqual({
      ok: false,
      reason: 'duplicate',
      counterparty: ADDRESS.toLowerCase(),
    });
    expect(await service().list(f.userId)).toHaveLength(1);
  });
});

describe('TransferReviewRuleService — listing and undo', () => {
  test('counts the queue rows each rule applies to', async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, { externalId: 'l-1', to: ADDRESS });
    await insertOutflow(f, { externalId: 'l-2', to: ADDRESS.toLowerCase() });
    // Same user, different destination — and a one-character lookalike, so the
    // count also proves the match is exact rather than near.
    await insertOutflow(f, { externalId: 'l-3', to: LOOKALIKE });

    const created = await service().create(f.userId, {
      transactionId: txId,
      verdict: 'not_a_disposal',
      note: 'three rows, two of them mine',
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.rule.affectedCount).toBe(2);

    const [listed] = await service().list(f.userId);
    expect(listed?.affectedCount).toBe(2);
  });

  test('an answered row is not counted, because a rule cannot reach it', async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, { externalId: 'l-4', to: ADDRESS });
    await insertOutflow(f, {
      externalId: 'l-5',
      to: ADDRESS,
      transferReview: 'left_control',
      transferReviewedAt: new Date(),
      transferReviewSource: 'user',
    });

    const created = await service().create(f.userId, {
      transactionId: txId,
      verdict: 'not_a_disposal',
      note: 'one open, one answered',
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.rule.affectedCount).toBe(1);
  });

  test('revoking is idempotent and frees the address to be ruled again', async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, { externalId: 'u-1', to: ADDRESS });
    const created = await service().create(f.userId, {
      transactionId: txId,
      verdict: 'not_a_disposal',
      note: 'first take',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect((await service().revoke(f.userId, created.rule.id)).ok).toBe(true);
    expect((await service().revoke(f.userId, created.rule.id)).ok).toBe(false);
    expect(await service().list(f.userId)).toEqual([]);

    // The revoked row is kept: it is the only record of why those transfers
    // were not being asked about for as long as it was in force.
    const rows = await db
      .select({ revokedAt: schema.transferReviewRules.revokedAt })
      .from(schema.transferReviewRules)
      .where(eq(schema.transferReviewRules.userId, f.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();

    const again = await service().create(f.userId, {
      transactionId: txId,
      verdict: 'ask_me',
      note: 'second take',
    });
    expect(again.ok).toBe(true);
  });

  test("will not revoke another user's rule", async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, { externalId: 'u-2', to: ADDRESS });
    const created = await service().create(f.userId, {
      transactionId: txId,
      verdict: 'not_a_disposal',
      note: 'mine',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect((await service().revoke(f.otherUserId, created.rule.id)).ok).toBe(false);
    expect(await service().list(f.userId)).toHaveLength(1);
  });
});

/**
 * The key a payment rail's prose collapses to (SC-381).
 *
 * mgrin wrote the first real rule minutes after SC-375 deployed and it could
 * fire exactly once, because the string it was keyed on carried the amount:
 * `pay 9450000.25 idr to amara sitanggang (dividends)`. His sentence was
 * *"the next transfer will have a different amount but I still need it to be
 * applied"*, and that is the whole of what these assert.
 *
 * The descriptions below have production's SHAPE — 14 rows, two recipients,
 * one typo of the kind the source data actually contains — but the second
 * recipient's name and amounts are INVENTED. They were a real third party's,
 * and this repository is public.
 *
 * The shape is what matters and it is preserved: amounts that vary row to row
 * (which is why keying on the whole string failed), a two-word name, and a
 * `(purpose)` suffix. Do not restore real values here — the failure this
 * guards was never that the data was authentic, it was that the shape of the
 * keys was never looked at.
 *
 * **What is NOT asserted is as load-bearing as what is.** Nothing here matches
 * a substring, a prefix or a near-miss. The key is a field an attacker can
 * write to (SC-375), so the last two tests are the security half: a
 * one-character lookalike still misses, and two recipients who share a prefix
 * stay apart.
 */
describe('TransferReviewRuleService — payment descriptions', () => {
  /** One row per outflow shape a payment rail produces when it names a
   *  recipient. Second recipient's name and amounts invented. */
  const OWNER = [
    'Pay 2500.00 USD to Teodor Vance (Dividends)',
    'Pay 300.00 USD to Teodor Vance (Dividends)',
    'Pay 3000.00 USD to Teodor Vance (Dividends)',
    'Pay 4000.00 USD to Teodor Vance (Dividends)',
    'Pay 4500 USD to Teodor Vance (Dividends)',
    'Pay 500.00 USD to Teodor Vance (Dividends)',
    'Pay 500.00 USD to Teodor Vance (Dividends)',
  ];
  const AMARA = [
    'Pay 11200000.50 IDR to Amara Sitanggang (Dividends)',
    'Pay 9450000.25 IDR to Amara Sitanggang (Dividends)',
    'Pay 13100000.75 IDR to Amara Sitanggang (Dividends)',
    'Pay 15900000.10 IDR to Amara Sitanggang (Dividends)',
    'Pay 7300000.60 IDR to Amara Sitanggang (Dividends)',
  ];

  async function payment(f: Fixture, externalId: string, description: string): Promise<string> {
    return insertOutflow(f, { externalId, source: 'airwallex-api', counterparty: description });
  }

  test('keys on the recipient, so the next payment at another amount matches', async () => {
    const f = fixture!;
    // The row the rule was authored from, and the one before it.
    const authored = await payment(f, 'p-1', 'Pay 9450000.25 IDR to Amara Sitanggang (Dividends)');
    await payment(f, 'p-2', 'Pay 7300000.60 IDR to Amara Sitanggang (Dividends)');

    const result = await service().create(f.userId, {
      transactionId: authored,
      verdict: 'not_a_disposal',
      note: 'Amara Sitanggang',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The amount and currency are gone; the recipient and the purpose they
    // were paid for are not. `(Dividends)` stays because it is a distinction
    // the user chose — a rule about dividends must not swallow a loan.
    expect(result.rule.matchCounterparty).toBe('amara sitanggang (dividends)');
    // Two rows, from one rule, at two different amounts. Under SC-375 this was
    // 1 and would have stayed 1 forever.
    expect(result.rule.affectedCount).toBe(2);
  });

  test('two rules cover every dividend payment in the set', async () => {
    const f = fixture!;
    for (const [i, description] of [...OWNER, ...AMARA].entries()) {
      await payment(f, `p-all-${i}`, description);
    }

    const owner = await service().create(f.userId, {
      transactionId: await payment(f, 'p-all-n', OWNER[0]!),
      verdict: 'ask_me',
      note: 'Teodor, dividends',
    });
    const amara = await service().create(f.userId, {
      transactionId: await payment(f, 'p-all-v', AMARA[0]!),
      verdict: 'ask_me',
      note: 'Amara, dividends',
    });

    expect(owner.ok && amara.ok).toBe(true);
    if (!owner.ok || !amara.ok) return;
    expect(owner.rule.matchCounterparty).toBe('teodor vance (dividends)');
    expect(amara.rule.matchCounterparty).toBe('amara sitanggang (dividends)');
    // 7 + 1 authored-from, and 5 + 1 authored-from: every row, from two rules.
    expect(owner.rule.affectedCount).toBe(OWNER.length + 1);
    expect(amara.rule.affectedCount).toBe(AMARA.length + 1);
  });

  test("the source data's own typo keys separately, and that is correct", async () => {
    const f = fixture!;
    await payment(f, 'p-typo-1', 'Pay 2500.00 USD to Teodor Vance (Dividends)');
    const typo = await payment(f, 'p-typo-2', 'Pay 1500.00 USD to Teodor Vance (Dividents)');

    const result = await service().create(f.userId, {
      transactionId: typo,
      verdict: 'ask_me',
      note: 'the typo row',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `Dividents` is a real typo in the source data, on a couple of the rows.
    // Closing that gap needs edit distance, and edit distance over a field an
    // attacker writes is the hole this ticket refused to open. Matching all
    // but those is the transformation; the stragglers are typed again.
    expect(result.rule.matchCounterparty).toBe('teodor vance (dividents)');
    expect(result.rule.affectedCount).toBe(1);
  });

  test('prose that is not a payment instruction is left whole', async () => {
    const f = fixture!;
    // The other two shapes production's `counterparty` carries. Neither begins
    // with a `Pay <amount> <CCY> to ` preamble, so neither is touched: the
    // pattern is anchored and complete, not a search for the word "to".
    const deposit = await payment(f, 'p-prose-1', 'Deposit to account 1234567890');
    const invoice = await payment(f, 'p-prose-2', 'INVOICE 42 , EXAMPLE LTD');

    for (const [txId, expected] of [
      [deposit, 'deposit to account 1234567890'],
      [invoice, 'invoice 42 , example ltd'],
    ] as const) {
      const result = await service().create(f.userId, {
        transactionId: txId,
        verdict: 'ask_me',
        note: 'prose',
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.rule.matchCounterparty).toBe(expected);
    }
  });

  test('an address is unchanged by the normalization, and a lookalike still misses', async () => {
    const f = fixture!;
    const real = await insertOutflow(f, { externalId: 'p-addr-1', to: ADDRESS });
    await insertOutflow(f, { externalId: 'p-addr-2', to: LOOKALIKE });

    const result = await service().create(f.userId, {
      transactionId: real,
      verdict: 'not_a_disposal',
      note: 'my Bybit deposit',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No address begins with `Pay `, so the chain half of this feature is
    // byte-identical to what SC-375 shipped — including the one-character
    // lookalike still being a different rule.
    expect(result.rule.matchCounterparty).toBe(ADDRESS.toLowerCase());
    expect(result.rule.affectedCount).toBe(1);
  });

  test('two recipients sharing a prefix stay apart', async () => {
    const f = fixture!;
    const first = await payment(f, 'p-prefix-1', 'Pay 100.00 USD to Teodor Vance');
    await payment(f, 'p-prefix-2', 'Pay 100.00 USD to Teodor Vancea');

    const result = await service().create(f.userId, {
      transactionId: first,
      verdict: 'not_a_disposal',
      note: 'Teodor',
    });

    expect(result.ok).toBe(true);
    // The comparison is still exact full-string equality — what changed is
    // what both sides are normalized to, never how they are compared. A
    // `starts_with` or an `ilike` here would take a second person's transfers
    // out of the queue, which for an adversary-writable key is the whole risk.
    if (result.ok) expect(result.rule.affectedCount).toBe(1);
  });

  test('re-keying an already-normalized key is a no-op', async () => {
    const f = fixture!;
    // What the migration relies on to be safe to run over every existing rule:
    // the function's output no longer carries a preamble, so applying it twice
    // is applying it once.
    const [row] = await db.execute<{ once: string | null; twice: string | null }>(
      sql`select
            transfer_counterparty_key('Pay 500.00 USD to Teodor Vance (Dividends)') as once,
            transfer_counterparty_key(
              transfer_counterparty_key('Pay 500.00 USD to Teodor Vance (Dividends)')
            ) as twice`
    );
    expect(row?.once).toBe('teodor vance (dividends)');
    expect(row?.twice).toBe(row?.once ?? null);
    expect(f.userId).toBeTruthy();
  });
});

/**
 * The marking half (SC-380) — the slice where a rule can book a capital gain.
 *
 * These tests are weighted almost entirely toward what the engine REFUSES to
 * write, and that is the point rather than defensiveness. SC-375's containment
 * was that no verdict could assert a disposal at all; `always_a_disposal`
 * removes it, so what remains has to be demonstrated one refusal at a time:
 * an answer the user gave, a row the matcher linked, the address-poisoning
 * corpus, somebody else's ledger, and a row whose rule answer the reader has
 * personally taken back.
 *
 * Integration rather than stubbed, for the reason the file's header gives and
 * more so here: every one of those refusals IS a SQL predicate. A stub would
 * assert that a fake returned what it was handed.
 */
describe('TransferReviewRuleService — marking a destination a disposal', () => {
  function reviews(): TransferReviewService {
    return Container.get(TransferReviewService);
  }

  async function mark(f: Fixture, txId: string, note = 'my exchange deposit') {
    return service().create(f.userId, {
      transactionId: txId,
      verdict: 'always_a_disposal',
      note,
    });
  }

  async function reviewColumns(txId: string) {
    const [row] = await db
      .select({
        transferReview: schema.holdingTransactions.transferReview,
        transferReviewSource: schema.holdingTransactions.transferReviewSource,
        transferReviewRuleId: schema.holdingTransactions.transferReviewRuleId,
        transferReviewedAt: schema.holdingTransactions.transferReviewedAt,
      })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, txId));
    return row;
  }

  test('answers every unanswered transfer to the marked destination, as the rule', async () => {
    const f = fixture!;
    const authoredFrom = await insertOutflow(f, { externalId: 'm-1', to: ADDRESS });
    const sibling = await insertOutflow(f, { externalId: 'm-2', to: ADDRESS.toLowerCase() });
    // A different destination entirely. Matching is exact on the normalized
    // key, so one character is a different rule and a different answer.
    const elsewhere = await insertOutflow(f, { externalId: 'm-3', to: LOOKALIKE });

    const created = await mark(f, authoredFrom);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    for (const txId of [authoredFrom, sibling]) {
      const row = await reviewColumns(txId);
      expect(row?.transferReview).toBe('left_control');
      expect(row?.transferReviewSource).toBe('rule');
      expect(row?.transferReviewRuleId).toBe(created.rule.id);
      // Stamped like a repair: the column says WHEN, only the source says WHO.
      expect(row?.transferReviewedAt).not.toBeNull();
    }
    expect((await reviewColumns(elsewhere))?.transferReview).toBeNull();

    // `affectedCount` is 0 because nothing is left waiting, which is exactly
    // what a rule matching nothing looks like — hence the second number.
    expect(created.rule.answeredCount).toBe(2);
    const [listed] = await service().list(f.userId);
    expect(listed?.answeredCount).toBe(2);
    expect(listed?.affectedCount).toBe(0);
  });

  test('never overwrites an answer the user gave', async () => {
    const f = fixture!;
    const authoredFrom = await insertOutflow(f, { externalId: 'm-4', to: ADDRESS });
    const answered = await insertOutflow(f, {
      externalId: 'm-5',
      to: ADDRESS,
      transferReview: 'untracked',
      transferReviewedAt: new Date(),
      transferReviewSource: 'user',
    });

    expect((await mark(f, authoredFrom)).ok).toBe(true);

    const row = await reviewColumns(answered);
    expect(row?.transferReview).toBe('untracked');
    expect(row?.transferReviewSource).toBe('user');
    expect(row?.transferReviewRuleId).toBeNull();
  });

  test('never writes onto a matcher-linked row, which would book nothing while reading as answered', async () => {
    const f = fixture!;
    const authoredFrom = await insertOutflow(f, { externalId: 'm-6', to: ADDRESS });
    // 29 of production's 236 unanswered outflows are in exactly this state:
    // a `transfer_group_id` the matcher wrote, no answer, invisible to the
    // queue. `outflowPortions` reads the group id BEFORE `isConfirmedDisposal`,
    // so a `left_control` here books nothing and looks decided (SC-382).
    const linked = await insertOutflow(f, {
      externalId: 'm-7',
      to: ADDRESS,
      transferGroupId: randomUUID(),
    });

    expect((await mark(f, authoredFrom)).ok).toBe(true);

    const row = await reviewColumns(linked);
    expect(row?.transferReview).toBeNull();
    expect(row?.transferReviewSource).toBeNull();
  });

  test('never writes onto the address-poisoning corpus', async () => {
    const f = fixture!;
    const authoredFrom = await insertOutflow(f, { externalId: 'm-8', to: ADDRESS });
    // A zero-value `transferFrom` on the real USDC contract, sprayed to plant a
    // lookalike in the victim's history. 113 of them in production, and they
    // appear on no screen — so no answer to one could ever be read.
    const poisoning = await insertOutflow(f, {
      externalId: 'm-9',
      to: ADDRESS,
      quantity: '0',
    });

    expect((await mark(f, authoredFrom)).ok).toBe(true);
    expect((await reviewColumns(poisoning))?.transferReview).toBeNull();
  });

  test("never writes onto another user's transfer to the same destination", async () => {
    const f = fixture!;
    const authoredFrom = await insertOutflow(f, { externalId: 'm-10', to: ADDRESS });
    const theirs = await insertOutflow(f, {
      externalId: 'm-11',
      to: ADDRESS,
      userId: f.otherUserId,
    });

    expect((await mark(f, authoredFrom)).ok).toBe(true);
    expect((await reviewColumns(theirs))?.transferReview).toBeNull();
  });

  test("refuses to mark one of the reader's own wallets, and writes nothing", async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, { externalId: 'm-12', to: ADDRESS });
    await db.insert(schema.userWallets).values({
      userId: f.userId,
      // Registered in EIP-55 mixed case, matched lowercased — the SC-350 bug
      // was a case-sensitive comparison reporting "not yours" about the wallet
      // named in the very next field.
      walletAddress: ADDRESS,
    });

    const result = await mark(f, txId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('own_wallet');
    expect((await reviewColumns(txId))?.transferReview).toBeNull();
    expect(await service().list(f.userId)).toEqual([]);

    // And the preview says the same thing, before the attempt — the whole
    // point of surfacing it is that a rejected write teaches nobody which
    // address it was about.
    const preview = await service().markPreview(f.userId, txId);
    expect(preview.refusal).toBe('own_wallet');
    expect(preview.affectedCount).toBe(0);
  });

  test('previews the count before anything is written', async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, { externalId: 'm-13', to: ADDRESS });
    await insertOutflow(f, { externalId: 'm-14', to: ADDRESS });

    const preview = await service().markPreview(f.userId, txId);
    expect(preview.refusal).toBeNull();
    expect(preview.counterpartyKey).toBe(ADDRESS.toLowerCase());
    expect(preview.affectedCount).toBe(2);
    // Nothing is written by asking.
    expect((await reviewColumns(txId))?.transferReview).toBeNull();
  });

  test('a per-row undo is permanent: the rule never answers that transfer again', async () => {
    const f = fixture!;
    const authoredFrom = await insertOutflow(f, { externalId: 'm-15', to: ADDRESS });
    const sibling = await insertOutflow(f, { externalId: 'm-16', to: ADDRESS });
    expect((await mark(f, authoredFrom)).ok).toBe(true);

    expect(await reviews().reopen(f.userId, sibling)).toBe(true);

    const withdrawn = await reviewColumns(sibling);
    expect(withdrawn?.transferReview).toBeNull();
    // The exemption marker. Without it the next read would re-answer the row
    // and the undo would be a loop the reader can watch fail.
    expect(withdrawn?.transferReviewSource).toBe('user');
    expect(withdrawn?.transferReviewRuleId).toBeNull();

    expect(await reviews().applyDisposalMarks(f.userId)).toBe(0);
    expect((await reviewColumns(sibling))?.transferReview).toBeNull();
    // The other row is untouched by any of this.
    expect((await reviewColumns(authoredFrom))?.transferReview).toBe('left_control');
  });

  test('a transfer imported after the mark is answered on the next read', async () => {
    const f = fixture!;
    const authoredFrom = await insertOutflow(f, { externalId: 'm-17', to: ADDRESS });
    expect((await mark(f, authoredFrom)).ok).toBe(true);

    const arrived = await insertOutflow(f, { externalId: 'm-18', to: ADDRESS });
    expect((await reviewColumns(arrived))?.transferReview).toBeNull();

    await reviews().pendingSummary(f.userId);
    expect((await reviewColumns(arrived))?.transferReview).toBe('left_control');
  });

  test('revoking reports what it did NOT undo, and can undo it on request', async () => {
    const f = fixture!;
    const authoredFrom = await insertOutflow(f, { externalId: 'm-19', to: ADDRESS });
    const sibling = await insertOutflow(f, { externalId: 'm-20', to: ADDRESS });
    const created = await mark(f, authoredFrom);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Plain revoke: the rule stops firing and the two booked disposals stay
    // booked. A revoke that reported success in silence would leave the reader
    // believing they had undone them.
    const kept = await service().revoke(f.userId, created.rule.id);
    expect(kept).toEqual({ ok: true, withdrawn: 0, answered: 2 });
    expect((await reviewColumns(sibling))?.transferReview).toBe('left_control');

    // Marking the destination again is a fresh decision and owns nothing the
    // first rule answered: those rows carry an answer now, so they are outside
    // the write gate, and `answeredCount` counts by rule id rather than by
    // re-matching the key.
    const fresh = await insertOutflow(f, { externalId: 'm-19b', to: ADDRESS });
    const second = await mark(f, fresh, 'again');
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.rule.answeredCount).toBe(1);
    expect((await reviewColumns(sibling))?.transferReviewRuleId).toBe(created.rule.id);
  });

  test("withdrawing a rule's answers leaves an answer the user has since given alone", async () => {
    const f = fixture!;
    const authoredFrom = await insertOutflow(f, { externalId: 'm-21', to: ADDRESS });
    const sibling = await insertOutflow(f, { externalId: 'm-22', to: ADDRESS });
    const created = await mark(f, authoredFrom);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // The reader takes one back and answers it themselves. That answer is
    // theirs and revoking the rule must not reach into it.
    expect(await reviews().reopen(f.userId, sibling)).toBe(true);
    await db
      .update(schema.holdingTransactions)
      .set({
        transferReview: 'untracked',
        transferReviewedAt: new Date(),
        transferReviewSource: 'user',
      })
      .where(eq(schema.holdingTransactions.id, sibling));

    const result = await service().revoke(f.userId, created.rule.id, { withdrawAnswers: true });
    expect(result.withdrawn).toBe(1);
    expect((await reviewColumns(authoredFrom))?.transferReview).toBeNull();
    expect((await reviewColumns(authoredFrom))?.transferReviewSource).toBeNull();
    expect((await reviewColumns(sibling))?.transferReview).toBe('untracked');
    expect((await reviewColumns(sibling))?.transferReviewSource).toBe('user');
  });

  test('the answered list says a rule answered it, and names the rule', async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, { externalId: 'm-23', to: ADDRESS });
    const created = await mark(f, txId, 'my Bybit deposit address');
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const page = await reviews().listAnswered(f.userId);
    const row = page.items.find((item) => item.transactionId === txId);
    expect(row?.answerSource).toBe('rule');
    // The note, not just the provenance. "Answered by a rule" three years from
    // now is the `unattributed` failure with better manners.
    expect(row?.ruleNote).toBe('my Bybit deposit address');

    // And it survives revocation, which is why `revoked_at` is a soft delete.
    await service().revoke(f.userId, created.rule.id);
    const after = await reviews().listAnswered(f.userId);
    expect(after.items.find((item) => item.transactionId === txId)?.ruleNote).toBe(
      'my Bybit deposit address'
    );
  });

  test('an overruled row carries the rule and its verdict back into the queue', async () => {
    const f = fixture!;
    const txId = await insertOutflow(f, { externalId: 'm-24', to: ADDRESS });
    expect((await mark(f, txId, 'exchange deposit')).ok).toBe(true);
    expect(await reviews().reopen(f.userId, txId)).toBe(true);

    const pending = await reviews().listPending(f.userId);
    const row = pending.find((item) => item.transactionId === txId);
    // Present, so the reader can be told the standing sentence about this
    // destination is a disposal AND that this transfer is out from under it.
    expect(row?.matchedRule?.verdict).toBe('always_a_disposal');
    expect(row?.matchedRule?.note).toBe('exchange deposit');
    expect(row?.answerWithdrawnBy).toBe('user');
  });
});
