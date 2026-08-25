/**
 * `UpdateHoldingUseCase` — the only path a user can edit a manual holding's
 * balance through, and the one that skipped the sync-capture observation
 * every other balance mutation appends (SC-245).
 *
 * **These tests have to assert the observation, not the balance.** The bug
 * was an absent write, so a test checking that the balance changed passes
 * identically against the broken code — it did change, it just left no
 * trace. Verified by reverting the fix and re-running: the two observation
 * tests fail, and nothing else does.
 *
 * That is the same trap as the two-row fixture in #800, where a behavioural
 * assertion went green against the very query that caused the bug.
 *
 * Isolation uses `withTestDb`'s rollback wrapper, which works here only
 * because `execute` now accepts an injected transaction. Before that it
 * opened its own via `withTransaction` and nothing the test could roll back
 * would have contained it.
 */

import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { flowRoleOf } from '../../src/lib/returns/flow-classification';
import { pendingPredicate } from '../../src/lib/transfer-review-queue';
import { HoldingBalanceObservationRepository } from '../../src/repositories/HoldingBalanceObservationRepository';
import {
  HoldingLabelTakenError,
  ManualOutflowAnswerRefused,
  UpdateHoldingUseCase,
} from '../../src/use-cases/UpdateHoldingUseCase';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const useCase = () => Container.get(UpdateHoldingUseCase);

async function scaffold(
  tx: Parameters<Parameters<typeof withTestDb>[0]>[0],
  holdingOverrides: { lastUpdated?: Date } = {}
) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance: '100',
    source: 'manual',
    ...holdingOverrides,
  });
  return { user, account, token, holding };
}

/**
 * A `lastUpdated` far from both clocks in play.
 *
 * The default comes from Postgres `now()`, and the value an edit writes comes
 * from `new Date()` on the host. Those are two different clocks — the compose
 * container's and this machine's — so asserting that one is later than the
 * other by a few milliseconds tests the skew between them, not the code. It
 * passed, then failed three runs in a row on an unrelated change, which is the
 * only reason it was noticed. Seeded months back, no plausible skew reaches it.
 */
const SEEDED_LAST_UPDATED = new Date('2026-01-01T00:00:00.000Z');

function ledgerFor(tx: Parameters<Parameters<typeof withTestDb>[0]>[0], holdingId: string) {
  return tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.holdingId, holdingId))
    .orderBy(asc(schema.holdingTransactions.occurredAt));
}

function observationsFor(tx: Parameters<Parameters<typeof withTestDb>[0]>[0], holdingId: string) {
  return tx
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId));
}

describe('UpdateHoldingUseCase', () => {
  test('a balance edit records a sync-capture observation', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      const before = await observationsFor(tx, holding.id);
      expect(before.length).toBe(0);

      await useCase().execute(holding.id, { balance: '700.25' }, user.id, tx);

      const after = await observationsFor(tx, holding.id);
      expect(after.length).toBe(1);
      expect(after[0]!.balance).toBe('700.25');
      expect(after[0]!.source).toBe('sync-capture');
      expect(after[0]!.userId).toBe(user.id);
    });
  });

  test('the observation carries the NEW balance, not the old one', async () => {
    // Guards the ordering: the row is read back from the UPDATE's
    // `returning()`, so an implementation that observed the pre-update
    // holding would record 100 and look correct in a count-only assertion.
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(holding.id, { balance: '4242.42' }, user.id, tx);

      const [observation] = await observationsFor(tx, holding.id);
      expect(observation!.balance).toBe('4242.42');
      expect(observation!.balance).not.toBe('100');
    });
  });

  test('an isActive toggle records no observation', async () => {
    // A balance observation is a claim about the balance. Writing one when
    // the balance did not move would put a duplicate anchor into the trail
    // `BalanceAtTimeService` reads, at a timestamp nothing happened.
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(holding.id, { isActive: false }, user.id, tx);

      const observations = await observationsFor(tx, holding.id);
      expect(observations.length).toBe(0);
    });
  });

  test('another user cannot edit the holding, and no observation is written', async () => {
    // The `userId` scoping on the UPDATE is the ownership check, and it is
    // the reason this use case writes the table itself instead of going
    // through `HoldingService.updateHoldingBalance`, which keys on
    // `holdingId` alone. If it is ever routed through the service, this
    // test is what fails.
    await withTestDb(async (tx) => {
      const { holding } = await scaffold(tx);
      const intruder = await makeUser(tx);

      await expect(
        useCase().execute(holding.id, { balance: '999999' }, intruder.id, tx)
      ).rejects.toThrow('Holding not found');

      const observations = await observationsFor(tx, holding.id);
      expect(observations.length).toBe(0);

      const [unchanged] = await tx
        .select()
        .from(schema.holdings)
        .where(and(eq(schema.holdings.id, holding.id)));
      expect(unchanged!.balance).toBe('100');
    });
  });

  /**
   * The defect SC-510 is about, asserted where it lives.
   *
   * Before this, a manual balance edit wrote a row to `holdings` and an
   * observation and NOTHING to `holding_transactions` — so the delta reached
   * the value series with no flow to net it out, and the returns engine read
   * the whole of it as performance. Add 5,000 and the engine reports a 5,000
   * gain.
   *
   * The assertion is the ledger row, not the balance, for the same reason the
   * observation tests above assert the observation: the balance moved under
   * the broken code too, so a balance check passes against the bug. Verified
   * by removing the `manualBalanceEditService.record` call — this test fails
   * and none of the observation tests do.
   */
  test('money added to a manual holding is booked as a flow, not as a gain', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);
      const moved = new Date('2026-06-01T00:00:00Z');

      await useCase().execute(
        holding.id,
        { balance: '5100', editCause: 'flow', editOccurredAt: moved },
        user.id,
        tx
      );

      const ledger = await ledgerFor(tx, holding.id);
      expect(ledger.length).toBe(1);
      expect(ledger[0]!.kind).toBe('deposit');
      expect(ledger[0]!.quantity).toBe('5000');
      expect(flowRoleOf(ledger[0]!.kind)).toBe('external');
      expect(ledger[0]!.occurredAt.toISOString()).toBe(moved.toISOString());
    });
  });

  test('the answer is remembered on the holding for the next edit', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(holding.id, { balance: '150', editCause: 'growth' }, user.id, tx);

      const [row] = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.id, holding.id));
      expect(row!.manualEditCause).toBe('growth');
    });
  });

  /**
   * The pre-SC-510 shape, kept working on purpose.
   *
   * `editCause` is optional on the use case, and an edit that arrives without
   * one writes no ledger row rather than picking a cause. That is the
   * conservative reading of a blindness state: the API refuses the request
   * before it reaches here, so the only callers that land in this branch are
   * ones that never claimed to know — and inventing a deposit for them would
   * be the exact failure this feature exists to prevent, in the one place
   * nobody is looking.
   */
  test('an edit with no stated cause writes no transaction rather than guessing one', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(holding.id, { balance: '5100' }, user.id, tx);

      expect(await ledgerFor(tx, holding.id)).toEqual([]);
      // The observation is still written — that half is SC-245 and unrelated.
      expect((await observationsFor(tx, holding.id)).length).toBe(1);
    });
  });

  test('an isActive toggle writes no transaction', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(holding.id, { isActive: false, editCause: 'flow' }, user.id, tx);

      expect(await ledgerFor(tx, holding.id)).toEqual([]);
    });
  });

  /**
   * The correction has to be dated BEFORE this edit's own observation, and
   * the only thing that makes that true is the ordering inside `run`: the
   * synthesis happens before `recordBalanceObservation`. Reverse the two and
   * the correction supersedes itself, restating an interval one millisecond
   * long and leaving the whole delta as a step on today.
   */
  test('a correction lands before the observation this edit appends', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(holding.id, { balance: '120', editCause: 'correction' }, user.id, tx);

      const ledger = await ledgerFor(tx, holding.id);
      const [observation] = await observationsFor(tx, holding.id);
      expect(ledger.length).toBe(1);
      expect(ledger[0]!.kind).toBe('correction');
      expect(ledger[0]!.occurredAt.getTime()).toBeLessThan(observation!.observedAt.getTime());
    });
  });

  /**
   * The reconciliation half of the ticket, and the claim is that it needs no
   * new code.
   *
   * `OpeningBalanceReconciliationService` computes
   * `holdings.balance - sum(real txs)` and backdates the difference as an
   * `opening_balance`. "Real" means every row whose `source` is not
   * `'reconciliation-opening'` — that one string is its entire exclusion.
   * So a synthesized flow is counted, the sum moves with the balance, and the
   * gap the reconciler would backdate does not change.
   *
   * Asserted on the row rather than by calling the reconciler, because
   * `projectHolding` takes no transaction and reads through its repositories
   * on a separate connection — it cannot see anything written inside
   * `withTestDb`'s rolled-back transaction, so a green from it here would mean
   * nothing at all. What IS checkable in this scope is the two facts the
   * reconciler's arithmetic depends on: the row exists with the right signed
   * quantity, and it does not wear the one source that would hide it.
   */
  test('a synthesized flow is a row the reconciler counts, so no phantom opening appears', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(
        holding.id,
        { balance: '5100', editCause: 'flow', editOccurredAt: new Date('2026-06-01T00:00:00Z') },
        user.id,
        tx
      );

      const ledger = await ledgerFor(tx, holding.id);
      const sum = ledger.reduce((acc, row) => acc + Number(row.quantity), 0);
      // 100 -> 5100. The ledger now explains the whole of the change, so
      // `balance - sum(txs)` is exactly what it was before the edit.
      expect(sum).toBe(5000);
      expect(ledger.every((row) => row.source !== 'reconciliation-opening')).toBe(true);
    });
  });
});

/**
 * SC-564 — naming a pot that already exists.
 *
 * `holdings.label` shipped with SC-330 and production still held 100 rows with
 * a NULL one, because the only writes were at CREATION time and the four RUB
 * rows the feature was designed for predate the column. These assert the write
 * path that was missing and, more importantly, the three things it must NOT do
 * on the way.
 *
 * **The negative tests are the point.** A rename that also synthesized a flow,
 * appended an observation or bumped `lastUpdated` would still store the name —
 * so a test asserting only "the label is now Savings" passes against every one
 * of those bugs. That is the same trap as the observation tests above.
 */
describe('UpdateHoldingUseCase — pot names (SC-564)', () => {
  test('a name can be set on a holding that already exists', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      const result = await useCase().execute(holding.id, { label: 'Savings' }, user.id, tx);

      expect(result.label).toBe('Savings');
    });
  });

  test('the name is stored trimmed, so it keys the way it displays', async () => {
    // `holdingPositionKey` trims and lowercases. A stored "  Savings  " would
    // key as `savings` and render with its padding, which is one name that
    // looks like two.
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      const result = await useCase().execute(holding.id, { label: '  Savings  ' }, user.id, tx);

      expect(result.label).toBe('Savings');
    });
  });

  test('a blank name clears it rather than storing an empty string', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);
      await useCase().execute(holding.id, { label: 'Savings' }, user.id, tx);

      const result = await useCase().execute(holding.id, { label: '   ' }, user.id, tx);

      // Not `''`: the position key normalises both to the same thing, and two
      // spellings of "no name" in the column is a distinction nothing reads.
      expect(result.label).toBeNull();
    });
  });

  test('a rename writes NO transaction — naming a pot is not money moving', async () => {
    // The load-bearing one. `ManualBalanceEditService.record` synthesizes a
    // deposit for a `flow`, and a rename that reached it would book money that
    // never moved onto the exact rows this feature exists to disambiguate.
    // `editCause` is passed deliberately: the API cannot send one for a
    // label-only edit, so this asserts the use case refuses on its own rather
    // than relying on the router never asking.
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(holding.id, { label: 'Savings', editCause: 'flow' }, user.id, tx);

      expect(await ledgerFor(tx, holding.id)).toEqual([]);
    });
  });

  test('a rename appends NO balance observation', async () => {
    // `BalanceAtTimeService` anchors a past-date balance on the nearest
    // observation and reports full confidence when it finds one. An
    // observation written at a rename would be a confident claim that the
    // balance was re-checked at a moment nobody looked at it.
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(holding.id, { label: 'Savings' }, user.id, tx);

      expect((await observationsFor(tx, holding.id)).length).toBe(0);
    });
  });

  test('a rename does not bump lastUpdated', async () => {
    // `lastUpdated` answers "when did this balance last move" — the sync path
    // skips writing it when a poll returns an unchanged balance. Bumping it on
    // a rename puts a fresh timestamp under a figure nobody re-checked.
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, { lastUpdated: SEEDED_LAST_UPDATED });

      const result = await useCase().execute(holding.id, { label: 'Savings' }, user.id, tx);

      expect(result.lastUpdated.toISOString()).toBe(SEEDED_LAST_UPDATED.toISOString());
    });
  });

  test('a balance edit still bumps lastUpdated', async () => {
    // The control for the test above. Without it, an implementation that never
    // wrote `lastUpdated` at all would pass, and the freshness signal the whole
    // holdings list reads would be dead rather than accurate.
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, { lastUpdated: SEEDED_LAST_UPDATED });

      const result = await useCase().execute(holding.id, { balance: '150' }, user.id, tx);

      expect(result.lastUpdated.getTime()).toBeGreaterThan(SEEDED_LAST_UPDATED.getTime());
    });
  });

  test('a balance edit does not touch the name', async () => {
    // The client sends no `label` key on a balance edit. If the use case read
    // `undefined` as "clear it", every balance edit would silently un-name the
    // pot — and the reader would find out weeks later, looking at four rows
    // that had become indistinguishable again.
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);
      await useCase().execute(holding.id, { label: 'Savings' }, user.id, tx);

      const result = await useCase().execute(holding.id, { balance: '150' }, user.id, tx);

      expect(result.label).toBe('Savings');
    });
  });
});

/**
 * The refusal, and the two things it deliberately allows.
 *
 * The rule is `collidingHoldingTokens` in `@scani/shared` — the same function
 * the review screen and the create use case refuse on. What is asserted here is
 * that this path reaches it and reaches it with the right population.
 */
describe('UpdateHoldingUseCase — a name has to tell the rows apart (SC-564)', () => {
  async function twoRubRows(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
    const user = await makeUser(tx);
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const token = await makeToken(tx);
    const first = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
      balance: '89354.60',
      source: 'manual',
    });
    const second = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
      balance: '5675.47',
      source: 'manual',
    });
    return { user, account, token, first, second };
  }

  test('a name another row in the account already wears is refused', async () => {
    await withTestDb(async (tx) => {
      const { user, first, second } = await twoRubRows(tx);
      await useCase().execute(first.id, { label: 'Savings' }, user.id, tx);

      await expect(useCase().execute(second.id, { label: 'Savings' }, user.id, tx)).rejects.toThrow(
        HoldingLabelTakenError
      );
    });
  });

  test('the refusal is case- and space-insensitive, like the key', async () => {
    // `holdingPositionKey` lowercases and trims. Refusing "Savings" while
    // accepting " savings " would put two rows on screen that read as the same
    // pot to a human and as two keys to the code — the worst of both.
    await withTestDb(async (tx) => {
      const { user, first, second } = await twoRubRows(tx);
      await useCase().execute(first.id, { label: 'Savings' }, user.id, tx);

      await expect(
        useCase().execute(second.id, { label: '  sAvInGs ' }, user.id, tx)
      ).rejects.toThrow(HoldingLabelTakenError);
    });
  });

  test('renaming a row to the name it already has is not a collision with itself', async () => {
    // The sibling set has to exclude the row being renamed. Without that, every
    // re-save of an unchanged name is refused, and the control the user is
    // looking at appears broken on the second press.
    await withTestDb(async (tx) => {
      const { user, first } = await twoRubRows(tx);
      await useCase().execute(first.id, { label: 'Savings' }, user.id, tx);

      const result = await useCase().execute(first.id, { label: 'Savings' }, user.id, tx);

      expect(result.label).toBe('Savings');
    });
  });

  test('a different name on the sibling is accepted — four pots is the point', async () => {
    // The control that proves the guard is not simply refusing every rename in
    // a contested group. If this ever goes red the feature is inert: the four
    // Tinkoff rows could never be told apart, which is the whole ticket.
    await withTestDb(async (tx) => {
      const { user, first, second } = await twoRubRows(tx);
      await useCase().execute(first.id, { label: 'Current' }, user.id, tx);

      const result = await useCase().execute(second.id, { label: 'Savings' }, user.id, tx);

      expect(result.label).toBe('Savings');
    });
  });

  test('clearing a name is allowed even while a sibling is unnamed', async () => {
    // Deliberate, and the reason is in `refuseIfLabelTaken`: an empty name
    // returns the row to the unnamed population it came from, which is an
    // ambiguity that already exists rather than a new one. Guarding it would
    // key every unnamed row to the same position and leave a user who named
    // one pot unable to ever un-name it — stuck in a state their own edit
    // created. Someone will read this refusal as a hole and try to close it;
    // this test is what they have to argue with.
    await withTestDb(async (tx) => {
      const { user, first } = await twoRubRows(tx);
      await useCase().execute(first.id, { label: 'Savings' }, user.id, tx);

      const result = await useCase().execute(first.id, { label: null }, user.id, tx);

      expect(result.label).toBeNull();
    });
  });

  test('a synced sibling does not block the name — that pair is two positions', async () => {
    // `findUnsyncedByAccountAndTokens` is the population, matching the create
    // path: an importer owns its own row and overwrites it every sync, so a
    // hand-named pot beside a synced row is two positions rather than one
    // duplicated. Production has exactly this at Airwallex — a manual USD pot
    // with its own APY schedule beside the synced USD balance.
    await withTestDb(async (tx) => {
      const { user, account, token, first } = await twoRubRows(tx);
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '601.50',
        source: 'import_airwallex',
        externalId: 'USD',
        label: 'Savings',
      });

      const result = await useCase().execute(first.id, { label: 'Savings' }, user.id, tx);

      expect(result.label).toBe('Savings');
    });
  });

  test("another account's row with the same name does not block it", async () => {
    // The key is (account, token). Six of the nine "duplicate" groups SC-564
    // was filed about were different USERS' accounts that shared a name, and a
    // guard keyed on anything wider than the account id would refuse a rename
    // because of a row the user cannot even see.
    await withTestDb(async (tx) => {
      const { user, token, first } = await twoRubRows(tx);
      const otherInstitution = await makeInstitution(tx);
      const otherAccount = await makeAccount(tx, {
        userId: user.id,
        institutionId: otherInstitution.id,
      });
      await makeHolding(tx, {
        userId: user.id,
        accountId: otherAccount.id,
        tokenId: token.id,
        balance: '10',
        source: 'manual',
        label: 'Savings',
      });

      const result = await useCase().execute(first.id, { label: 'Savings' }, user.id, tx);

      expect(result.label).toBe('Savings');
    });
  });
});

/**
 * One manual edit, one question (SC-606).
 *
 * ## What was measured before any of this was written
 *
 * On a dev stack, 2026-08-25, on a UTC+12 box: a manual USD savings holding
 * edited 4,000 → 2,000, answered `flow`, date field left at its default.
 * `ReviewFeedService.listPending` then held **two** items — a transfer-review
 * and a balance-gap — on top of the dialog itself. Three prompts from one
 * edit, which is what was reported. With the prior observation aged from 12h
 * to 72h and nothing else changed, the balance-gap item disappeared and the
 * count fell to two: the third prompt is the DATE interaction, not a property
 * of manual editing. Answered in full, the same edit now leaves zero.
 *
 * ## Why these assert PREDICATES rather than call the queues
 *
 * `BalanceGapService.listPending` and `TransferReviewService.pendingSummary`
 * read the global `db`, and everything here lives in a transaction that is
 * rolled back — so calling them would count zero whatever the code did, which
 * is a test that passes against the bug. `pendingPredicate` is the queue's OWN
 * gate and `findGapCandidatesForUser` takes a transaction, so both can be
 * asked about rows this test can see.
 *
 * Each carries its must-be-FOUND control in the same test: the gap candidate
 * has to still EXIST and be answered, and the withdrawal has to have been
 * WRITTEN and be out of the queue. Asserting only "not in the queue" would
 * pass just as well against a fixture that never produced one.
 */
describe('UpdateHoldingUseCase — one edit, one question (SC-606)', () => {
  type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

  /** The queue's own gate, so this cannot drift from what the page shows. */
  function pendingOutflows(tx: Tx, userId: string) {
    return tx.select().from(schema.holdingTransactions).where(pendingPredicate(userId));
  }

  /**
   * A cash holding with the observation the daily APY payout leaves behind.
   *
   * `sync-capture` because that is what `HoldingService.recordBalanceObservation`
   * writes whatever the caller — which is why `BalanceGapService`'s
   * `owner-stated` suppression has never fired on the manual path, however
   * confidently its docblock says SC-510 already asked.
   */
  async function cashHoldingObservedToday(tx: Tx) {
    const user = await makeUser(tx);
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const [fiat] = await tx
      .insert(schema.tokenTypes)
      .values({ code: `fiat-${crypto.randomUUID().slice(0, 8)}`, name: 'Fiat' })
      .returning();
    const token = await makeToken(tx, { typeId: fiat?.id });
    const holding = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
      balance: '4000',
      source: 'manual',
    });
    await Container.get(HoldingBalanceObservationRepository).append(
      {
        userId: user.id,
        holdingId: holding.id,
        balance: '4000',
        observedAt: new Date(Date.now() - 12 * 60 * 60 * 1000),
        source: 'sync-capture',
        sourceMetadata: {},
      },
      tx
    );
    return { user, institution, account, token, holding };
  }

  /**
   * A flow dated BEFORE the holding's previous observation, which is the
   * condition that leaves the interval unexplained.
   *
   * Stated as an explicit instant rather than reproduced through the date
   * field's local-midnight default, and the difference is not cosmetic: `bun
   * test` runs in UTC while the app runs in the host's zone — measured
   * 2026-08-25, the same expression gave `2026-08-24T12:00Z` under the dev
   * stack and `2026-08-25T00:00Z` under the suite. A test written on the
   * default would assert the runner's timezone and pass or fail on where it
   * ran.
   *
   * The route a real user takes to this state IS that default: a date field
   * collects a day, a day becomes local midnight, and in any zone east of UTC
   * that instant is yesterday — earlier than an observation the daily APY
   * payout wrote this morning. `BALANCE_GAP_DATE_PROMPT_MIN_SPAN_MS` carries
   * the same measurement from the other side of the same problem.
   */
  function backdatedBeforeLastObservation(): Date {
    return new Date(Date.now() - 48 * 60 * 60 * 1000);
  }

  test('the edit answers its own observation, so the balance-gap queue does not ask again', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await cashHoldingObservedToday(tx);

      await useCase().execute(
        holding.id,
        { balance: '2000', editCause: 'flow', editOccurredAt: backdatedBeforeLastObservation() },
        user.id,
        tx
      );

      const candidates = await Container.get(
        HoldingBalanceObservationRepository
      ).findGapCandidatesForUser(user.id, tx);
      const gap = candidates.find((row) => row.holdingId === holding.id);

      // Must-be-FOUND: the interval really is an unexplained gap. Without this
      // the assertion below would pass on a fixture that never made one, which
      // is the whole failure this suite was written against in SC-245.
      expect(gap).toBeDefined();
      expect(gap?.source).toBe('sync-capture');

      // …and it is answered, in the vocabulary the queue itself writes, so
      // `listPending` skips it at `candidate.gapReview !== null`.
      expect(gap?.gapReview).toBe('flow');
    });
  });

  test('a correction and a growth answer their observation too', async () => {
    // The stamp is the CAUSE, not the string 'flow'. An implementation that
    // hard-coded one value would leave the other two edits asking again, and
    // `growth` writes no ledger row at all — so nothing else on that path
    // could ever explain its interval.
    for (const cause of ['correction', 'growth'] as const) {
      await withTestDb(async (tx) => {
        const { user, holding } = await cashHoldingObservedToday(tx);

        await useCase().execute(holding.id, { balance: '2000', editCause: cause }, user.id, tx);

        const [observation] = await tx
          .select()
          .from(schema.holdingBalanceObservations)
          .where(
            and(
              eq(schema.holdingBalanceObservations.holdingId, holding.id),
              eq(schema.holdingBalanceObservations.gapReviewSource, 'user')
            )
          );
        expect(observation?.gapReview).toBe(cause);
      });
    }
  });

  test('an edit with no cause leaves its observation unanswered', async () => {
    // The must-be-ABSENT control. A priced holding's edit is derived rather
    // than stated, and a sync's observation is nobody's answer — stamping
    // either would hide a real gap behind a claim no person made.
    await withTestDb(async (tx) => {
      const { user, holding } = await cashHoldingObservedToday(tx);

      await useCase().execute(holding.id, { balance: '2000' }, user.id, tx);

      const rows = await tx
        .select()
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.holdingId, holding.id));
      const written = rows.find((row) => row.balance === '2000');
      expect(written?.gapReview).toBeNull();
      expect(written?.gapReviewSource).toBeNull();
    });
  });

  test('a destination given with the edit settles the withdrawal it wrote', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await cashHoldingObservedToday(tx);

      await useCase().execute(
        holding.id,
        {
          balance: '2000',
          editCause: 'flow',
          editOccurredAt: backdatedBeforeLastObservation(),
          editOutflow: { decision: 'left_control' },
        },
        user.id,
        tx
      );

      const ledger = await ledgerFor(tx, holding.id);
      const withdrawal = ledger.find((row) => row.kind === 'withdraw');

      // Must-be-FOUND: the outflow was written. "Not in the queue" is worth
      // nothing if the row this is about does not exist.
      expect(withdrawal).toBeDefined();
      expect(withdrawal?.quantity).toBe('-2000');

      expect(withdrawal?.transferReview).toBe('left_control');
      // `answerSourceOf` reads this as `user`, which is what every repair and
      // the rule engine gate on.
      expect(withdrawal?.transferReviewSource).toBe('user');

      expect(await pendingOutflows(tx, user.id)).toHaveLength(0);
    });
  });

  test('without a destination the withdrawal stays in the queue, exactly as before', async () => {
    // The must-be-ABSENT control for the whole feature, and the compatibility
    // claim: a client that sends nothing behaves as every pre-SC-606 one did.
    // Nothing here infers a destination — a guess would book a disposal, or
    // decline to, on nobody's authority.
    await withTestDb(async (tx) => {
      const { user, holding } = await cashHoldingObservedToday(tx);

      await useCase().execute(
        holding.id,
        { balance: '2000', editCause: 'flow', editOccurredAt: backdatedBeforeLastObservation() },
        user.id,
        tx
      );

      const pending = await pendingOutflows(tx, user.id);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.kind).toBe('withdraw');
    });
  });

  test('an internal destination links the pair there and then', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await cashHoldingObservedToday(tx);
      const other = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const destination = await makeHolding(tx, {
        userId: user.id,
        accountId: other.id,
        tokenId: token.id,
        balance: '10',
        source: 'manual',
      });

      await useCase().execute(
        holding.id,
        {
          balance: '2000',
          editCause: 'flow',
          editOccurredAt: backdatedBeforeLastObservation(),
          editOutflow: {
            decision: 'internal',
            destination: { accountId: other.id, holdingId: destination.id },
          },
        },
        user.id,
        tx
      );

      const withdrawal = (await ledgerFor(tx, holding.id)).find((row) => row.kind === 'withdraw');
      const arrival = (await ledgerFor(tx, destination.id))[0];

      expect(withdrawal?.transferReview).toBe('internal');
      expect(arrival).toBeDefined();
      // The link itself. Without a shared group id `CostBasisService` retires
      // the lots here and reopens them there at market, which is the invented
      // gain the whole transfer-review feature exists to stop.
      expect(withdrawal?.transferGroupId).not.toBeNull();
      expect(arrival?.transferGroupId).toBe(withdrawal?.transferGroupId ?? null);

      expect(await pendingOutflows(tx, user.id)).toHaveLength(0);
    });
  });

  test('a destination beside an edit that writes no withdrawal is refused', async () => {
    // A deposit, a `correction` and a `growth` have no outflow for a
    // destination to describe. Refusing loudly rather than dropping the field:
    // a client that sends one has a bug, and silently ignoring it would leave
    // the person believing they had answered.
    //
    // NOT asserted here: that the refusal rolls the edit back. It does —
    // `execute` wraps `run` in `withTransaction` — but this suite injects its
    // own transaction precisely so it can roll back, so the injected path
    // hands the rollback to the caller and there is nothing for the test to
    // observe. Said rather than implied.
    await withTestDb(async (tx) => {
      const { user, holding } = await cashHoldingObservedToday(tx);

      await expect(
        useCase().execute(
          holding.id,
          { balance: '9000', editCause: 'flow', editOutflow: { decision: 'left_control' } },
          user.id,
          tx
        )
      ).rejects.toBeInstanceOf(ManualOutflowAnswerRefused);
    });
  });
});
