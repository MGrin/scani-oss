/**
 * The caption's count and the review queue are one set (SC-1067).
 *
 * `CoverageNote.tsx` promises it in words — *"the review queue holds exactly
 * those rows and answering them takes the count to zero"* — and until this
 * file nothing tested it. The two numbers are computed by different services
 * over different predicates: the queue by `pendingPredicate` + the active-rule
 * join in `TransferReviewService`, the caption by `countsAsUnreviewed` inside
 * the `CostBasisService` walk. A promise held by two independent expressions
 * is a promise held until one of them is edited.
 *
 * It is asserted end to end against a real database rather than over stubs
 * because the whole of what is under test IS the predicate. A stubbed queue
 * returns what it was handed and would have agreed with anything.
 *
 * **The last case asserts the same SET, not the same count.** Two counts that
 * agree at one moment can be counts of different rows, and every assertion
 * built from a single reading would pass on that. It is settled with a
 * differential rather than by comparing ids, because the caption exposes no
 * ids to compare: the rows are answered ONE AT A TIME through the queue's own
 * `resolve`, and both numbers must fall together at every step. If the two
 * sides held the same count over different sets, answering a row in the
 * queue's set would drop the queue and leave the caption where it was. That is
 * also `CoverageNote.tsx`'s promise stated literally — *answering them takes
 * the count to zero*.
 *
 * **Every case carries a control that moves.** A test that says two zeros are
 * equal passes on a fixture that seeds nothing, on a query that reads the
 * wrong user, and on a service that has been deleted. So each case reads a
 * non-zero baseline first and then asserts the delta — and the rule case
 * revokes the rule and requires BOTH counts to rise, because if neither moves
 * the fixture is not exercising rules at all and the case is vacuous.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import Container from 'typedi';

import { HoldingRepository } from '../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { PnLAtTimeService } from '../../src/services/portfolio/PnLAtTimeService';
import { PriceGraphService } from '../../src/services/pricing/PriceGraphService';
import { TransferReviewRuleService } from '../../src/services/TransferReviewRuleService';
import { TransferReviewService } from '../../src/services/TransferReviewService';
import { restoreContainerAfterAll } from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

interface Fixture {
  userId: string;
  baseCurrencyId: string;
  tokenId: string;
  holdingId: string;
  accountId: string;
  institutionId: string;
  institutionTypeId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

/** Invented addresses. Nothing here is copied from any real ledger. */
const DEST_A = '0x1111111111111111111111111111111111110001';
const DEST_B = '0x1111111111111111111111111111111111110002';
const DEST_C = '0x1111111111111111111111111111111111110003';

let fixture: Fixture | null = null;

function anchor(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

async function setupFixture(): Promise<Fixture> {
  const tag = randomUUID().slice(0, 8);
  const [user] = await db
    .insert(schema.users)
    .values({ email: `trq-${tag}@scani.local`, name: 'QueueCount' })
    .returning();
  if (!user) throw new Error('user insert failed');

  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `trq-${tag}`, name: 'TRQ Type' })
    .returning();
  if (!instType) throw new Error('instType insert failed');
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `TRQ-${tag}`, typeId: instType.id })
    .returning();
  if (!inst) throw new Error('inst insert failed');
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `trq-acct-${tag}`, name: 'TRQ Account' })
    .returning();
  if (!acctType) throw new Error('acctType insert failed');
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst.id,
      typeId: acctType.id,
      name: `wallet-${tag}`,
      metadata: { chainId: '1' },
    })
    .returning();
  if (!account) throw new Error('account insert failed');
  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `trq-tok-${tag}`, name: 'TRQ Token Type' })
    .returning();
  if (!tokenType) throw new Error('tokenType insert failed');
  const [token] = await db
    .insert(schema.tokens)
    .values({ symbol: `TRQ${tag.toUpperCase()}`, name: 'TRQ Token', typeId: tokenType.id })
    .returning();
  if (!token) throw new Error('token insert failed');
  const [base] = await db
    .insert(schema.tokens)
    .values({ symbol: `TRB${tag.toUpperCase()}`, name: 'TRQ Base', typeId: tokenType.id })
    .returning();
  if (!base) throw new Error('base token insert failed');
  const [holding] = await db
    .insert(schema.holdings)
    .values({ userId: user.id, accountId: account.id, tokenId: token.id, balance: '0' })
    .returning();
  if (!holding) throw new Error('holding insert failed');

  return {
    userId: user.id,
    baseCurrencyId: base.id,
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
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.tokenId));
  await db.delete(schema.tokens).where(eq(schema.tokens.id, f.baseCurrencyId));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
}

/** An acquisition, so the outflows below have lots to pop. */
async function insertBuy(f: Fixture, quantity: string): Promise<void> {
  await db.insert(schema.holdingTransactions).values({
    userId: f.userId,
    holdingId: f.holdingId,
    tokenId: f.tokenId,
    kind: 'buy',
    quantity,
    priceNative: '100',
    priceNativeTokenId: f.baseCurrencyId,
    occurredAt: anchor(30),
    source: 'test',
    externalId: `trq-buy-${randomUUID().slice(0, 8)}`,
  });
}

/**
 * An outflow shaped the way production's are: `counterparty` NULL, the
 * destination only in the payload. That is not incidental — every chain
 * outflow in production is that shape, and a rule matched against the column
 * alone would match nothing here and nothing there.
 */
async function insertOutflow(f: Fixture, opts: { to: string; quantity?: string }): Promise<string> {
  const [row] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: f.userId,
      holdingId: f.holdingId,
      tokenId: f.tokenId,
      kind: 'withdraw',
      quantity: opts.quantity ?? '-1',
      occurredAt: anchor(7),
      source: 'etherscan',
      externalId: `trq-out-${randomUUID().slice(0, 8)}`,
      rawPayload: { to: opts.to },
    })
    .returning();
  if (!row) throw new Error('outflow insert failed');
  return row.id;
}

/** What the review queue holds — the page the caption's link opens. */
async function queueCount(f: Fixture): Promise<number> {
  return (await new TransferReviewService().pendingSummary(f.userId)).count;
}

/**
 * What the caption says, through the wiring that actually produces it.
 *
 * `PnLAtTimeService` rather than `CostBasisService` directly, because the
 * regression this guards against is a real one: the walk takes the rule-hidden
 * set as a parameter that DEFAULTS TO EMPTY, so a caller that forgets to pass
 * it gets the old wrong number and no error. Asserting against the walk with
 * the set handed in by the test would be asserting that the walk does what the
 * test just told it to.
 *
 * The per-holding figures summed, not `result.transfersUnreviewed`: the
 * user-level total drops holdings whose value could not be resolved, while
 * `RollupPortfolioValueDailyUseCase` sums the per-holding numbers ungated and
 * it is the rollup's row the chart's caption is read from. This sums what the
 * reader sees.
 */
async function captionCount(f: Fixture): Promise<number> {
  const result = await Container.get(PnLAtTimeService).getPnL(
    f.userId,
    new Date(),
    f.baseCurrencyId,
    { tx: undefined }
  );
  return result.perHolding.reduce((sum, ph) => sum + ph.transfersUnreviewed, 0);
}

beforeEach(async () => {
  // Sibling files stub these on the process-global container and a
  // `Container.set` is permanent, so whether this file reaches a real
  // repository would otherwise depend on file order (SC-448).
  Container.set(HoldingRepository, new HoldingRepository());
  Container.set(HoldingTransactionRepository, new HoldingTransactionRepository());
  Container.set(PriceGraphService, new PriceGraphService());
  Container.set(TransferReviewService, new TransferReviewService());
  fixture = await setupFixture();
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

describe('the caption count and the review queue are one set (SC-1067)', () => {
  test('two plain unanswered outflows are on both sides', async () => {
    const f = fixture!;
    await insertBuy(f, '10');
    await insertOutflow(f, { to: DEST_A });
    await insertOutflow(f, { to: DEST_B });

    // Non-zero on both, which is what makes every equality below a reading
    // rather than a pair of empty queries agreeing.
    expect(await queueCount(f)).toBe(2);
    expect(await captionCount(f)).toBe(2);
  });

  test('a zero-quantity outflow is on neither side', async () => {
    const f = fixture!;
    await insertBuy(f, '10');
    await insertOutflow(f, { to: DEST_A });

    const queueBefore = await queueCount(f);
    const captionBefore = await captionCount(f);
    expect(queueBefore).toBe(1);
    expect(captionBefore).toBe(1);

    // The address-poisoning corpus: a zero-value `Transfer` on a real token
    // contract, sprayed to plant a lookalike address in the victim's history.
    // `pendingPredicate` excludes it because no answer to it can change any
    // figure — and for exactly that reason it cannot be understating one.
    const zero = await insertOutflow(f, { to: DEST_B, quantity: '0' });

    // Two unchanged counts is also what a row that was never inserted, or was
    // inserted answered, would produce. This says the row is really there and
    // really unanswered, so the agreement below is about the quantity.
    const [stored] = await db
      .select({
        quantity: schema.holdingTransactions.quantity,
        transferReview: schema.holdingTransactions.transferReview,
        transferGroupId: schema.holdingTransactions.transferGroupId,
      })
      .from(schema.holdingTransactions)
      .where(eq(schema.holdingTransactions.id, zero));
    expect(Number(stored?.quantity)).toBe(0);
    expect(stored?.transferReview).toBeNull();
    expect(stored?.transferGroupId).toBeNull();

    expect(await queueCount(f)).toBe(queueBefore);
    expect(await captionCount(f)).toBe(captionBefore);
  });

  test('a not_a_disposal rule takes a row off both sides, and revoking it puts it back', async () => {
    const f = fixture!;
    await insertBuy(f, '10');
    const hidden = await insertOutflow(f, { to: DEST_A });
    await insertOutflow(f, { to: DEST_B });

    expect(await queueCount(f)).toBe(2);
    expect(await captionCount(f)).toBe(2);

    const created = await new TransferReviewRuleService().create(f.userId, {
      transactionId: hidden,
      verdict: 'not_a_disposal',
      note: 'my own account',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // The rule asserts the destination is not a disposal, so nothing about
    // that row is missing from realized PnL and the caption must not claim it
    // is. The queue already knows; this is the half that did not.
    expect(await queueCount(f)).toBe(1);
    expect(await captionCount(f)).toBe(1);

    // The control. If the rule were matching nothing, every assertion above
    // would still pass and this one would not: both counts have to come back.
    await db
      .update(schema.transferReviewRules)
      .set({ revokedAt: new Date() })
      .where(eq(schema.transferReviewRules.id, created.rule.id));

    expect(await queueCount(f)).toBe(2);
    expect(await captionCount(f)).toBe(2);
  });

  test('answering one row at a time takes both counts down together, to zero', async () => {
    const f = fixture!;
    await insertBuy(f, '20');
    const hidden = await insertOutflow(f, { to: DEST_A });
    await insertOutflow(f, { to: DEST_B });
    await insertOutflow(f, { to: DEST_C });

    const rule = await new TransferReviewRuleService().create(f.userId, {
      transactionId: hidden,
      verdict: 'not_a_disposal',
      note: 'my own account',
    });
    expect(rule.ok).toBe(true);

    // Three outflows, one of them rule-hidden, so the set under test is not
    // simply "every outflow" — a caption that ignored rules would start at 3
    // here and stay one ahead all the way down.
    expect(await queueCount(f)).toBe(2);
    expect(await captionCount(f)).toBe(2);

    const reviews = new TransferReviewService();
    const pending = await reviews.listPending(f.userId);
    expect(pending).toHaveLength(2);

    // The differential. Each answer removes ONE row from the queue's set; if
    // the caption were counting a different set of the same size, one of these
    // steps would leave it behind.
    let expected = 2;
    for (const row of pending) {
      await reviews.resolve(f.userId, row.transactionId, 'left_control', {});
      expected -= 1;
      expect(await queueCount(f)).toBe(expected);
      expect(await captionCount(f)).toBe(expected);
    }

    // The promise in `CoverageNote.tsx`, literally: answering them takes the
    // count to zero. A rule-hidden row still sits in the ledger and must not
    // hold the caption above zero.
    expect(expected).toBe(0);
    expect(await queueCount(f)).toBe(0);
    expect(await captionCount(f)).toBe(0);
  });
});
