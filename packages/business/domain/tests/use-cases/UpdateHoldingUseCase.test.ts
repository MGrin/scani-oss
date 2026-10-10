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

import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { unexplainedDrift } from '../../src/lib/balances/unexplained-drift';
import { flowRoleOf } from '../../src/lib/returns/flow-classification';
import { pendingPredicate } from '../../src/lib/transfer-review-queue';
import { HoldingBalanceObservationRepository } from '../../src/repositories/HoldingBalanceObservationRepository';
import { HoldingCacheWriter } from '../../src/services/feeds/HoldingCacheWriter';
import { FoundationClassificationService } from '../../src/services/foundation/FoundationClassificationService';
import { ManualEditFeeRefused } from '../../src/services/holdings/ManualBalanceEditService';
import { TransferReviewService } from '../../src/services/TransferReviewService';
import {
  HoldingLabelTakenError,
  ManualOutflowAnswerRefused,
  UpdateHoldingUseCase,
} from '../../src/use-cases/UpdateHoldingUseCase';
import { committedRows } from '../../test/helpers/committed-rows';
import { withTestDb } from '../../test/helpers/db';
import { seedHoldingCache } from '../../test/helpers/engine-guard';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeCheckpoint,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
  makeWalletAccount,
  seedReading,
} from '../../test/helpers/factories-extra';
import { expectHistoryUnchanged, type HistoryReading } from '../../test/helpers/history-neutrality';
import {
  expectLabelsSettled,
  expectPersonRolesAsClassified,
} from '../../test/helpers/labels-settled';
import { backendPid, outcomeOf, waitUntilBlocked } from '../../test/helpers/lock-wait';

const useCase = () => Container.get(UpdateHoldingUseCase);

/**
 * A manual holding stored at 100. `funded` gives it the reading the 100 comes
 * from, as production has had since A2; an edit sized against the engine
 * (A5 D-15) needs it, and a test counting observations does not want it.
 */
async function scaffold(
  tx: Parameters<Parameters<typeof withTestDb>[0]>[0],
  { funded = false, ...holdingOverrides }: { lastUpdated?: Date; funded?: boolean } = {}
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
  if (funded) {
    await seedReading(tx, {
      userId: user.id,
      holdingId: holding.id,
      balance: '100',
      at: new Date('2026-01-01T00:00:00Z'),
    });
  }
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
      const { user, holding } = await scaffold(tx, { funded: true });
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
   * The correction must not be dated AFTER this edit's own observation, and
   * the only thing that makes that true is the ordering inside `run`: the
   * synthesis happens before `SnapshotWriter.record`. Reverse the two and
   * the correction supersedes itself, restating an interval one millisecond
   * long and leaving the whole delta as a step on today.
   *
   * Equal is allowed (SC-1367). Both stamps come from the clock a few
   * statements apart, so under load they share a millisecond, and that is
   * correct: the anchor walk reads `(from, to]`, so a correction stamped on
   * its observation is still inside the interval that observation closes.
   */
  test('a correction is not dated after the observation this edit appends', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(holding.id, { balance: '120', editCause: 'correction' }, user.id, tx);

      const ledger = await ledgerFor(tx, holding.id);
      const [observation] = await observationsFor(tx, holding.id);
      expect(ledger.length).toBe(1);
      expect(ledger[0]!.kind).toBe('correction');
      expect(ledger[0]!.occurredAt.getTime()).toBeLessThanOrEqual(
        observation!.observedAt.getTime()
      );
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
      const { user, holding } = await scaffold(tx, { funded: true });

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

describe('UpdateHoldingUseCase — a hidden holding given a balance (SC-1557)', () => {
  async function editHidden(hiddenBy: 'auto' | 'user') {
    return await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);
      await seedHoldingCache(tx, (calculator) =>
        calculator
          .update(schema.holdings)
          .set({ balance: '0', isHidden: true, hiddenBy })
          .where(eq(schema.holdings.id, holding.id))
      );

      await useCase().execute(holding.id, { balance: '55' }, user.id, tx);

      const [row] = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.id, holding.id));
      return { balance: row!.balance, isHidden: row!.isHidden, hiddenBy: row!.hiddenBy };
    });
  }

  test('one the sweep hid is shown again, and still reads as swept', async () => {
    expect(await editHidden('auto')).toEqual({ balance: '55', isHidden: false, hiddenBy: 'auto' });
  });

  test('one its owner hid stays hidden', async () => {
    expect(await editHidden('user')).toEqual({ balance: '55', isHidden: true, hiddenBy: 'user' });
  });
});

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

  const HOUR = 60 * 60 * 1000;

  async function cashHoldingObservedToday(tx: Tx, previousAgeHours = 12) {
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
    for (const ageHours of [previousAgeHours + 48, previousAgeHours + 24, previousAgeHours]) {
      await Container.get(HoldingBalanceObservationRepository).append(
        {
          userId: user.id,
          holdingId: holding.id,
          balance: '4000',
          observedAt: new Date(Date.now() - ageHours * HOUR),
          source: 'sync-capture',
          sourceMetadata: {},
        },
        tx
      );
    }
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
      // The interval this edit CLOSES, picked by its closing balance rather
      // than by "the first candidate on this holding". With the daily
      // observation chain the fixture now carries there is more than one, and
      // the back-dated flow below manufactures another (SC-612) — so `find`
      // returned a different row from the one this test is about, and would
      // have reported that row's `null` as this one's.
      const gap = candidates.find((row) => row.holdingId === holding.id && row.balance === '2000');

      // Since SC-1474 a back-dated edit explains the interval whose balance it
      // changed, so that interval is no longer a gap at all. Before, it was a
      // gap the edit's stamp had to answer, and the back-dated row raised a
      // second question one interval earlier (SC-612). Either way the queue
      // must not ask: no unanswered, unexplained interval on this holding.
      // `a correction and a growth answer their observation too` below is the
      // control that this fixture does make gaps: `growth` writes no row.
      expect(gap === undefined || gap.gapReview === 'flow').toBe(true);

      // Must-be-FOUND, on THIS fixture (SC-245): the edit really produced a
      // 4000 -> 2000 observation, and the ledger row it wrote accounts for
      // the whole -2000. A fixture that never moved the balance has no such
      // observation and fails here.
      const [observed] = await tx
        .select()
        .from(schema.holdingBalanceObservations)
        .where(
          and(
            eq(schema.holdingBalanceObservations.holdingId, holding.id),
            eq(schema.holdingBalanceObservations.balance, '2000')
          )
        );
      expect(observed?.previousBalance).toBe('4000');
      const edits = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.holdingId, holding.id),
            eq(schema.holdingTransactions.source, 'user-balance-edit')
          )
        );
      expect(edits).toHaveLength(1);
      const moved = edits.reduce((sum, row) => sum.add(row.quantity), new Decimal(0));
      expect(unexplainedDrift('4000', '2000', [moved.toString()]).isZero()).toBe(true);
      const unanswered = candidates.filter(
        (row) =>
          row.holdingId === holding.id &&
          !unexplainedDrift(row.previousBalance, row.balance, [row.explained]).isZero() &&
          row.gapReview === null &&
          row.source === 'sync-capture'
      );
      expect(unanswered).toHaveLength(0);
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

  /**
   * The residual SC-606 left behind, and the number a person actually sees
   * (SC-612).
   *
   * SC-606 stamps `gap_review` on the edit's OWN observation, so the interval
   * the edit closes leaves the queue however the flow is dated. What it cannot
   * do is put the flow in that interval: `useHoldingEditCause` sent local
   * midnight of the current day, and on a UTC+12 box that instant is the
   * previous UTC day — earlier than the observation the daily APY payout wrote
   * this morning. The row then lands in the interval BEFORE the one it
   * explains, whose balance never moved, and manufactures a second question
   * there while the first sits stamped as answered.
   *
   * ## The control, which is the whole measurement
   *
   * Only the previous observation's AGE changes between the two runs below.
   * The flow's date, the balances, the cause and the fixture are identical.
   *
   * | previous observation | unanswered gaps after one edit |
   * |---|---|
   * | 12h ago | 1 |
   * | 72h ago | 0 |
   *
   * Measured 2026-08-25 against this worktree's Postgres. It is the same
   * control the ticket records from the dev stack as 3 → 2 prompts, one
   * balance-gap fewer, counted after SC-606 removed the other two.
   *
   * ## Why the date is an offset and not the date field's own default
   *
   * `bun test` runs in UTC and the app runs in the host's zone, so the very
   * expression under repair produced `2026-08-24T12:00Z` on the dev stack and
   * `2026-08-25T00:00Z` here on the same day — under UTC at 08:23 the
   * "back-dated" instant was LATER than the 12h-old observation and the defect
   * did not reproduce at all. A test written on the default asserts where it
   * ran. `-18h` states the relationship the default has east of Greenwich:
   * before the previous observation, after the one before that.
   */
  describe('where the flow is stamped (SC-612)', () => {
    /** `listPending`'s own first gates, on rows this transaction can see. */
    async function unansweredGaps(tx: Tx, userId: string) {
      const candidates = await Container.get(
        HoldingBalanceObservationRepository
      ).findGapCandidatesForUser(userId, tx);
      return candidates.filter(
        (row) =>
          !unexplainedDrift(row.previousBalance, row.balance, [row.explained]).isZero() &&
          row.gapReview === null &&
          row.source === 'sync-capture'
      );
    }

    // Both read 0 since SC-1474: the flow explains the interval whose balance
    // it changed, whatever day it is dated to, so the 12h case no longer
    // manufactures a question one interval earlier.
    for (const [previousAgeHours, expected] of [
      [12, 0],
      [72, 0],
    ] as const) {
      test(`a flow dated 18h back leaves ${expected} question with the previous observation ${previousAgeHours}h old`, async () => {
        await withTestDb(async (tx) => {
          const { user, holding } = await cashHoldingObservedToday(tx, previousAgeHours);

          await useCase().execute(
            holding.id,
            {
              balance: '2000',
              editCause: 'flow',
              editOccurredAt: new Date(Date.now() - 18 * HOUR),
            },
            user.id,
            tx
          );

          expect(await unansweredGaps(tx, user.id)).toHaveLength(expected);
        });
      });
    }

    test('the same edit dated at the edit instant leaves none', async () => {
      // The fix, from the server's side: the client now sends the instant for
      // an untouched date field, and the flow lands inside the interval whose
      // two observations are the evidence it happened.
      await withTestDb(async (tx) => {
        const { user, holding } = await cashHoldingObservedToday(tx, 12);

        await useCase().execute(
          holding.id,
          { balance: '2000', editCause: 'flow', editOccurredAt: new Date() },
          user.id,
          tx
        );

        expect(await unansweredGaps(tx, user.id)).toHaveLength(0);
      });
    });

    test('a flow the owner deliberately dated three weeks ago is NOT dragged forward', async () => {
      // The must-be-ABSENT control for the fix, and the thing the ticket says
      // not to do: `BalanceGapService.answer` clamps into the interval because
      // it is answering about a PAST one, and clamping here would rewrite a
      // date somebody meant. The extra question is the correct outcome — the
      // money really did leave three weeks ago, and the interval it left
      // behind really is unexplained.
      await withTestDb(async (tx) => {
        const { user, holding } = await cashHoldingObservedToday(tx, 12);
        const threeWeeksAgo = new Date(Date.now() - 21 * 24 * HOUR);

        await useCase().execute(
          holding.id,
          { balance: '2000', editCause: 'flow', editOccurredAt: threeWeeksAgo },
          user.id,
          tx
        );

        const ledger = await ledgerFor(tx, holding.id);
        const withdrawal = ledger.find((row) => row.kind === 'withdraw');
        expect(withdrawal).toBeDefined();
        expect(withdrawal?.occurredAt.getTime()).toBe(threeWeeksAgo.getTime());
      });
    });
  });

  test('an internal destination opens the holding and links the pair there and then', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await cashHoldingObservedToday(tx);
      const other = await makeAccount(tx, { userId: user.id, institutionId: institution.id });

      await useCase().execute(
        holding.id,
        {
          balance: '2000',
          editCause: 'flow',
          editOccurredAt: backdatedBeforeLastObservation(),
          // `holdingId: null` — the account tracks no position in this token
          // yet, so answering OPENS one. It is the only `internal` shape this
          // path accepts; see the refusal below.
          editOutflow: {
            decision: 'internal',
            destination: { accountId: other.id, holdingId: null },
          },
        },
        user.id,
        tx
      );

      const withdrawal = (await ledgerFor(tx, holding.id)).find((row) => row.kind === 'withdraw');
      const [opened] = await tx
        .select()
        .from(schema.holdings)
        .where(and(eq(schema.holdings.accountId, other.id), eq(schema.holdings.tokenId, token.id)));

      // `paired`, not `internal`: this path writes both legs itself now, and
      // `internal` is the answer meaning "nothing imported the arrival".
      expect(withdrawal?.transferReview).toBe('paired');

      // The money is REALLY THERE. This is the assertion SC-614 turned on:
      // the whole defect was an arrival row against a balance that never
      // moved, and a test that checked only for the row would have passed on
      // it.
      expect(opened).toBeDefined();
      expect(opened?.balance).toBe('2000');

      const arrival = (await ledgerFor(tx, opened?.id ?? ''))[0];
      // The link itself. Without a shared group id `CostBasisService` retires
      // the lots here and reopens them there at market, which is the invented
      // gain the whole transfer-review feature exists to stop.
      expect(withdrawal?.transferGroupId).not.toBeNull();
      expect(arrival?.transferGroupId).toBe(withdrawal?.transferGroupId ?? null);

      expect(await pendingOutflows(tx, user.id)).toHaveLength(0);
    });
  });

  test('an internal destination that ALREADY holds the token has its balance moved (SC-614)', async () => {
    // The repair. Two callers needed opposite behaviour out of one function:
    // the queue must NOT move the destination's anchor — the outflow is
    // historical and its own sync already observed the arrival, so moving it
    // double-counts — and this path must, because the user is the only source
    // of truth for both sides and only one of them has moved.
    //
    // So this path no longer calls `writeInflow` at all. It writes the arrival
    // leg the way `RecordHoldingMovementUseCase` does, through this same use
    // case, and both anchors move. `TransferReviewService`'s own
    // `writes the arrival, shares the group id, and moves no balance` is the
    // must-be-ABSENT half of this pair and asserts the queue still does not.
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await cashHoldingObservedToday(tx);
      const other = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const destination = await makeHolding(tx, {
        userId: user.id,
        accountId: other.id,
        tokenId: token.id,
        balance: '500',
        source: 'manual',
      });
      await seedReading(tx, {
        userId: user.id,
        holdingId: destination.id,
        balance: '500',
        at: SEEDED_LAST_UPDATED,
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

      const [arrived] = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.id, destination.id));
      const [left] = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.id, holding.id));

      // THE assertion, and the only one here that failed against the bug.
      // 500 + 2,000. An arrival row existing and a group id being shared were
      // both true for as long as the defect lived.
      expect(arrived?.balance).toBe('2500');
      expect(left?.balance).toBe('2000');

      const withdrawal = (await ledgerFor(tx, holding.id)).find((row) => row.kind === 'withdraw');
      const arrival = (await ledgerFor(tx, destination.id)).find((row) => row.kind === 'deposit');
      expect(arrival?.quantity).toBe('2000');

      // A declared pair, not a discovery. `paired` rather than `internal`
      // because both legs exist — this path wrote them — and `internal` is
      // the answer that means "nothing imported the arrival, write it for me".
      expect(withdrawal?.transferReview).toBe('paired');
      expect(withdrawal?.transferGroupId).not.toBeNull();
      expect(arrival?.transferGroupId).toBe(withdrawal?.transferGroupId ?? null);

      expect(await pendingOutflows(tx, user.id)).toHaveLength(0);
    });
  });

  // D-1 exception U4. The destination's balance is one this path computes, so
  // it is written as a plain decimal; `Decimal`'s own text for it is `5e-8`.
  // The source's balance is the text a person typed, and stays as typed.
  test('a declared transfer of dust writes the destination it computes in plain notation, and the typed balance as typed (U4)', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await cashHoldingObservedToday(tx);
      const other = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const destination = await makeHolding(tx, {
        userId: user.id,
        accountId: other.id,
        tokenId: token.id,
        balance: '0',
        source: 'manual',
      });

      await useCase().execute(
        holding.id,
        {
          // 4,000 less 0.00000005, typed with a trailing zero.
          balance: '3999.999999950',
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

      const balanceOf = async (id: string) =>
        (await tx.select().from(schema.holdings).where(eq(schema.holdings.id, id)))[0]?.balance;
      expect(await balanceOf(destination.id)).toBe('0.00000005');
      expect(await balanceOf(holding.id)).toBe('3999.999999950');

      const copies = await tx
        .select({ balance: schema.holdingBalanceObservations.balance })
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.holdingId, destination.id));
      expect(copies.map((copy) => copy.balance)).toEqual(['0.00000005']);
    });
  });

  test('a declared transfer states its fee: the destination gets what ARRIVED (SC-857)', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await cashHoldingObservedToday(tx);
      const other = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const destination = await makeHolding(tx, {
        userId: user.id,
        accountId: other.id,
        tokenId: token.id,
        balance: '500',
        source: 'manual',
      });
      await seedReading(tx, {
        userId: user.id,
        holdingId: destination.id,
        balance: '500',
        at: SEEDED_LAST_UPDATED,
      });

      await useCase().execute(
        holding.id,
        {
          // 4,000 -> 3,748.67. The owner states what LEFT their account,
          // which is the only figure their statement shows.
          balance: '3748.67',
          editCause: 'flow',
          editOccurredAt: backdatedBeforeLastObservation(),
          editOutflow: {
            decision: 'internal',
            destination: { accountId: other.id, holdingId: destination.id },
            feeQuantity: '1.33',
          },
        },
        user.id,
        tx
      );

      const [arrived] = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.id, destination.id));
      const [left] = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.id, holding.id));

      // THE assertion. 500 + 250.00, not 500 + 251.33. Against the one-amount
      // model this reads 751.33 — the overstatement the owner had to undo.
      expect(arrived?.balance).toBe('750');
      expect(left?.balance).toBe('3748.67');

      const sourceLedger = await ledgerFor(tx, holding.id);
      const withdrawal = sourceLedger.find((row) => row.kind === 'withdraw');
      const fee = sourceLedger.find((row) => row.kind === 'fee');
      const arrival = (await ledgerFor(tx, destination.id)).find((row) => row.kind === 'deposit');

      // Two rows on the source, and the split between them is what makes the
      // fee sayable at all.
      expect(withdrawal?.quantity).toBe('-250');
      expect(fee?.quantity).toBe('-1.33');
      expect(arrival?.quantity).toBe('250');

      // The invariant this design cannot survive losing: what the rows sum to
      // is what the anchor moved by. `OpeningBalanceReconciliationService`
      // computes `holdings.balance - sum(real txs)` and synthesizes an
      // `opening_balance` for the difference, so a fee row added BESIDE a
      // full-amount withdrawal — rather than carved out of it — would
      // manufacture a phantom 1.33 opening on this holding.
      const summed = sourceLedger.reduce((total, row) => total.add(row.quantity), new Decimal(0));
      expect(summed.toString()).toBe('-251.33');

      // The fee is not a leg of the transfer and must never be linked as one:
      // `CostBasisService`'s inflow branch hands the FIRST `transfer_in` every
      // buffered lot and then deletes the bucket, so a second row on this
      // group id would open a fresh market-value lot and invent a gain
      // (SC-150). One group, two legs, exactly as before.
      expect(withdrawal?.transferGroupId).not.toBeNull();
      expect(arrival?.transferGroupId).toBe(withdrawal?.transferGroupId ?? null);
      expect(fee?.transferGroupId).toBeNull();

      // …and it is not a question. `answerIsOwedFor` covers `withdraw` and
      // `transfer_out` only, so a `fee` row cannot reach the review queue —
      // asserted rather than assumed, because a fee that queued would ask the
      // owner where their bank's money went.
      expect(await pendingOutflows(tx, user.id)).toHaveLength(0);

      // A cost the portfolio CONSUMED, so it belongs in the return figure
      // rather than in the owner's contributions. `flowRoleOf` already says
      // so for every imported fee; this asserts the declared one lands in the
      // same place.
      expect(flowRoleOf('fee')).toBe('return');
    });
  });

  test('a fee that consumes the whole movement is refused, not clamped (SC-857)', async () => {
    // A fee equal to or larger than the amount that left leaves nothing to
    // transfer, and the arrival would be zero or negative. Refused rather
    // than clamped for the reason `undoDeclaredTransfer` gives about not
    // clamping: silently losing the difference produces a figure nobody
    // chose, and the owner cannot see that it happened.
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await cashHoldingObservedToday(tx);
      const other = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const destination = await makeHolding(tx, {
        userId: user.id,
        accountId: other.id,
        tokenId: token.id,
        balance: '500',
        source: 'manual',
      });

      await expect(
        useCase().execute(
          holding.id,
          {
            balance: '3748.67',
            editCause: 'flow',
            editOccurredAt: backdatedBeforeLastObservation(),
            editOutflow: {
              decision: 'internal',
              destination: { accountId: other.id, holdingId: destination.id },
              feeQuantity: '251.33',
            },
          },
          user.id,
          tx
        )
      ).rejects.toThrow(ManualEditFeeRefused);
    });
  });

  test('an internal destination naming the holding the money LEFT is refused', async () => {
    // Both legs on one holding is not a transfer, it is a no-op that would
    // park the lots in a group with itself — and `linkDeclaredPair` would see
    // one row where it demands two and roll the whole edit back with a message
    // about half-made pairings. Refused here, in the vocabulary the caller
    // can render.
    await withTestDb(async (tx) => {
      const { user, account, holding } = await cashHoldingObservedToday(tx);

      await expect(
        useCase().execute(
          holding.id,
          {
            balance: '2000',
            editCause: 'flow',
            editOccurredAt: backdatedBeforeLastObservation(),
            editOutflow: {
              decision: 'internal',
              destination: { accountId: account.id, holdingId: holding.id },
            },
          },
          user.id,
          tx
        )
      ).rejects.toBeInstanceOf(ManualOutflowAnswerRefused);
    });
  });

  test('the manual destination list offers an account that already holds the token (SC-614)', async () => {
    // Widened with the repair above, and only with it. While `writeInflow`
    // was the writer this list was scoped to accounts tracking none of the
    // token, because the other branch silently left the destination short.
    // Now that both anchors move, an existing holding is a destination a
    // person can pick — and it is the commoner one.
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await cashHoldingObservedToday(tx);
      const empty = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const occupied = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const sibling = await makeHolding(tx, {
        userId: user.id,
        accountId: occupied.id,
        tokenId: token.id,
        balance: '10',
        source: 'manual',
      });

      const offered = await Container.get(TransferReviewService).listDestinationsForHolding(
        user.id,
        holding.id,
        tx
      );

      // Both shapes, and each is a control on the other: an account with no
      // position offered as "open one", and the existing holding offered by
      // its own id.
      expect(offered).toContainEqual(
        expect.objectContaining({ accountId: empty.id, holdingId: null })
      );
      expect(offered).toContainEqual(
        expect.objectContaining({ accountId: occupied.id, holdingId: sibling.id })
      );
      // must-be-ABSENT: the holding the money is leaving is never a
      // destination, on either list.
      expect(offered.map((row) => row.holdingId)).not.toContain(holding.id);
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

/**
 * Today's edit path, pinned before foundation A2 moves it onto
 * `HoldingCacheWriter` and `SnapshotWriter.record` (Task 17). Everything here
 * passed on the path before the move, so these are that path's figures,
 * instants and legacy columns: the move may label the observation, and may
 * change nothing a reader sees (D-1, R11).
 */
describe('UpdateHoldingUseCase — today’s edit, pinned before it moves (foundation A2)', () => {
  type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

  const EDITED_AT = new Date('2026-03-01T09:30:00.000Z');
  const STATED_LAST_UPDATED = new Date('2026-02-15T00:00:00.000Z');

  afterEach(() => {
    setSystemTime();
  });

  async function rowOf(tx: Tx, holdingId: string) {
    const [row] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
    if (!row) throw new Error(`holding ${holdingId} is gone`);
    return row;
  }

  test('the observation is the legacy row: sync-capture, origin updateHolding, stamped when written, answered at the edit instant', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, { lastUpdated: SEEDED_LAST_UPDATED });
      const before = Date.now();

      await useCase().execute(
        holding.id,
        { balance: '150', editCause: 'growth', editedAt: EDITED_AT },
        user.id,
        tx
      );

      const after = Date.now();
      const rows = await observationsFor(tx, holding.id);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row).toMatchObject({
        userId: user.id,
        balance: '150',
        source: 'sync-capture',
        gapReview: 'growth',
        gapReviewSource: 'user',
      });
      expect(row!.sourceMetadata).toEqual({ origin: 'updateHolding' });
      // Answered at the edit, observed at the write: the two instants differ
      // whenever a caller states `editedAt`.
      expect(row!.gapReviewedAt?.toISOString()).toBe(EDITED_AT.toISOString());
      expect(row!.observedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(row!.observedAt.getTime()).toBeLessThanOrEqual(after);
    });
  });

  test('an edit with no cause writes the legacy row unanswered', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(holding.id, { balance: '150', editedAt: EDITED_AT }, user.id, tx);

      const [row] = await observationsFor(tx, holding.id);
      expect(row).toMatchObject({
        balance: '150',
        source: 'sync-capture',
        gapReview: null,
        gapReviewSource: null,
        gapReviewedAt: null,
      });
      expect(row!.sourceMetadata).toEqual({ origin: 'updateHolding' });
    });
  });

  test('last_updated is the edit instant: editedAt when given, a stated lastUpdated over it, and only on a balance or isActive change', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, { lastUpdated: SEEDED_LAST_UPDATED });

      const edited = await useCase().execute(
        holding.id,
        { balance: '150', editedAt: EDITED_AT },
        user.id,
        tx
      );
      expect(edited.lastUpdated.toISOString()).toBe(EDITED_AT.toISOString());
      expect((await rowOf(tx, holding.id)).lastUpdated.toISOString()).toBe(EDITED_AT.toISOString());

      const stated = await useCase().execute(
        holding.id,
        { balance: '160', editedAt: EDITED_AT, lastUpdated: STATED_LAST_UPDATED },
        user.id,
        tx
      );
      expect(stated.lastUpdated.toISOString()).toBe(STATED_LAST_UPDATED.toISOString());
      expect((await rowOf(tx, holding.id)).lastUpdated.toISOString()).toBe(
        STATED_LAST_UPDATED.toISOString()
      );

      const renamed = await useCase().execute(
        holding.id,
        { label: 'Savings', editedAt: EDITED_AT },
        user.id,
        tx
      );
      expect(renamed.lastUpdated.toISOString()).toBe(STATED_LAST_UPDATED.toISOString());

      const toggled = await useCase().execute(
        holding.id,
        { isActive: false, editedAt: EDITED_AT },
        user.id,
        tx
      );
      expect(toggled.lastUpdated.toISOString()).toBe(EDITED_AT.toISOString());
      expect(toggled.balance).toBe('160');

      const before = Date.now();
      const unstated = await useCase().execute(holding.id, { balance: '170' }, user.id, tx);
      const after = Date.now();
      expect(unstated.lastUpdated.getTime()).toBeGreaterThanOrEqual(before);
      expect(unstated.lastUpdated.getTime()).toBeLessThanOrEqual(after);
      expect(unstated).toEqual(await rowOf(tx, holding.id));

      // Three balance edits, three observations; the rename and the toggle wrote none.
      expect((await observationsFor(tx, holding.id)).map((o) => o.balance).sort()).toEqual([
        '150',
        '160',
        '170',
      ]);
    });
  });

  test('a correction is dated 1 ms after the figure it replaces entered: the last observation, or the edit instant when there is none', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, { lastUpdated: SEEDED_LAST_UPDATED });
      // Its 100 as a ledger row, not a reading: the engine reads 100 and the
      // holding still has no observation for the fallback to find (A5 D-15).
      await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: holding.id,
        kind: 'deposit',
        quantity: '100',
        occurredAt: new Date('2025-12-01T00:00:00Z'),
      });

      await useCase().execute(
        holding.id,
        { balance: '120', editCause: 'correction', editedAt: EDITED_AT },
        user.id,
        tx
      );

      const correction = (await ledgerFor(tx, holding.id)).find((r) => r.kind === 'correction');
      expect(correction).toMatchObject({
        kind: 'correction',
        source: 'user-balance-correction',
        quantity: '20',
        externalId: `manual-edit:${EDITED_AT.toISOString()}`,
        inputId: null,
      });
      // The fallback reads the row the UPDATE returned, whose last_updated is
      // already this edit's instant.
      expect(correction!.occurredAt.getTime()).toBe(EDITED_AT.getTime() + 1);
      expect(correction!.sourceMetadata).toEqual({
        cause: 'correction',
        previousBalance: '100',
        newBalance: '120',
        editedAt: EDITED_AT.toISOString(),
      });
    });

    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, { lastUpdated: SEEDED_LAST_UPDATED });
      const enteredAt = new Date('2026-02-20T12:00:00.000Z');
      await tx.insert(schema.holdingBalanceObservations).values({
        userId: user.id,
        holdingId: holding.id,
        balance: '100',
        observedAt: enteredAt,
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHolding' },
      });

      await useCase().execute(
        holding.id,
        { balance: '90', editCause: 'correction', editedAt: EDITED_AT },
        user.id,
        tx
      );

      const [correction] = await ledgerFor(tx, holding.id);
      expect(correction!.quantity).toBe('-10');
      expect(correction!.occurredAt.getTime()).toBe(enteredAt.getTime() + 1);
    });
  });

  test('a value at an instant the holding already holds from the same source is dropped, and the balance stays the recorded one (R8, A5 D-1)', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, { lastUpdated: SEEDED_LAST_UPDATED });
      setSystemTime(EDITED_AT);

      await useCase().execute(holding.id, { balance: '150' }, user.id, tx);
      const second = await useCase().execute(holding.id, { balance: '175' }, user.id, tx);

      // The 175 was not recorded, so it is not evidence: the engine still
      // reads the 150 that was.
      expect(second.balance).toBe('150');
      expect(second.lastUpdated.toISOString()).toBe(EDITED_AT.toISOString());
      const rows = await observationsFor(tx, holding.id);
      expect(rows.map((o) => [o.balance, o.observedAt.toISOString()])).toEqual([
        ['150', EDITED_AT.toISOString()],
      ]);
    });
  });
});

/**
 * The move's own assertions (foundation A2, Task 17). The observation is
 * written by `SnapshotWriter.record`: its role by Rule P (a snapshot until the
 * holding's feed has begun, a verification after, none on a NULL kind),
 * authority `person`, no input, with the edit's cause and its attestation, and
 * a correction retires the snapshot it restates. The legacy columns above stay.
 */
describe('UpdateHoldingUseCase records through SnapshotWriter (foundation A2)', () => {
  type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

  const EDITED_AT = new Date('2026-03-01T09:30:00.000Z');
  const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

  afterEach(() => {
    setSystemTime();
  });

  async function holdingsOfEveryKind(tx: Tx) {
    const user = await makeUser(tx);
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    const of = async (kind: 'snapshot' | 'feed' | null) =>
      makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
        balance: '100',
        source: 'manual',
        kind,
        startsAt: kind === null ? null : LONG_AGO,
        lastUpdated: LONG_AGO,
      });
    return {
      user,
      snapshot: await of('snapshot'),
      feed: await of('feed'),
      unknown: await of(null),
    };
  }

  async function holdingRowOf(tx: Tx, holdingId: string) {
    const [row] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
    if (!row) throw new Error(`holding ${holdingId} is gone`);
    return row;
  }

  function personSnapshotsOf(tx: Tx, holdingId: string) {
    return tx
      .select()
      .from(schema.holdingBalanceObservations)
      .where(eq(schema.holdingBalanceObservations.holdingId, holdingId))
      .orderBy(asc(schema.holdingBalanceObservations.observedAt));
  }

  test('an edit writes one observation, its role by Rule P, with the cause and the attestation', async () => {
    await withTestDb(async (tx) => {
      const { user, snapshot, feed, unknown } = await holdingsOfEveryKind(tx);
      // The feed has begun, so a value on it is a verification (Rule P).
      await makeCheckpoint(tx, { userId: user.id, holdingId: feed.id, observedAt: LONG_AGO });

      await useCase().execute(
        snapshot.id,
        { balance: '150', editCause: 'growth', editedAt: EDITED_AT },
        user.id,
        tx
      );
      await useCase().execute(
        feed.id,
        { balance: '175', editCause: 'flow', editedAt: EDITED_AT },
        user.id,
        tx
      );
      await useCase().execute(unknown.id, { balance: '90', editedAt: EDITED_AT }, user.id, tx);

      const legacy = {
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHolding' },
        authority: 'person',
        inputId: null,
        supersededAt: null,
      };
      const [onSnapshot] = await observationsFor(tx, snapshot.id);
      expect(await observationsFor(tx, snapshot.id)).toHaveLength(1);
      expect(onSnapshot).toMatchObject({
        ...legacy,
        balance: '150',
        role: 'snapshot',
        cause: 'growth',
        gapReview: 'growth',
        gapReviewSource: 'user',
      });
      expect(onSnapshot!.gapReviewedAt?.toISOString()).toBe(EDITED_AT.toISOString());

      // D-6: a person's value on a feed holding whose feed has begun is a
      // verification, and still sets today's figure (D-1).
      const onFeed = (await observationsFor(tx, feed.id)).filter((o) => o.authority === 'person');
      expect(onFeed).toHaveLength(1);
      expect(onFeed[0]).toMatchObject({
        ...legacy,
        balance: '175',
        role: 'verification',
        cause: 'flow',
        gapReview: 'flow',
      });
      expect((await holdingRowOf(tx, feed.id)).balance).toBe('175');

      // A NULL kind persists no role; the read-time Rule P fills it.
      const onUnknown = await observationsFor(tx, unknown.id);
      expect(onUnknown).toHaveLength(1);
      expect(onUnknown[0]).toMatchObject({
        ...legacy,
        balance: '90',
        role: null,
        cause: null,
        gapReview: null,
      });

      // A value at now lowers no start, and a NULL start stays NULL (D-6).
      for (const [holding, startsAt] of [
        [snapshot, LONG_AGO],
        [feed, LONG_AGO],
        [unknown, null],
      ] as const) {
        const row = await holdingRowOf(tx, holding.id);
        expect(row.startsAt).toEqual(startsAt);
        expect(row.kind).toBe(holding.kind);
      }
    });
  });

  test('a correction supersedes the previous snapshot, and the legacy correction row is still written', async () => {
    await withTestDb(async (tx) => {
      const { user, snapshot } = await holdingsOfEveryKind(tx);
      await tx.insert(schema.holdingBalanceObservations).values({
        userId: user.id,
        holdingId: snapshot.id,
        balance: '100',
        observedAt: LONG_AGO,
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHolding' },
        role: 'snapshot',
        authority: 'person',
        cause: 'flow',
      });

      // A plain value replaces nothing before it.
      await useCase().execute(snapshot.id, { balance: '150', editCause: 'flow' }, user.id, tx);
      await useCase().execute(
        snapshot.id,
        { balance: '140', editCause: 'correction' },
        user.id,
        tx
      );

      const rows = await personSnapshotsOf(tx, snapshot.id);
      expect(
        rows.map((o) => ({ balance: o.balance, cause: o.cause, live: o.supersededAt === null }))
      ).toEqual([
        { balance: '100', cause: 'flow', live: true },
        { balance: '150', cause: 'flow', live: false },
        { balance: '140', cause: 'correction', live: true },
      ]);
      // OD-6: today's restatement row stays beside the snapshot's cause.
      const corrections = (await ledgerFor(tx, snapshot.id)).filter(
        (row) => row.source === 'user-balance-correction'
      );
      expect(corrections.map((row) => [row.kind, row.quantity])).toEqual([['correction', '-10']]);
    });
  });

  test('a same-instant value from the same source is dropped and supersedes nothing (R8)', async () => {
    await withTestDb(async (tx) => {
      const { user, snapshot } = await holdingsOfEveryKind(tx);
      setSystemTime(EDITED_AT);

      await useCase().execute(snapshot.id, { balance: '150', editCause: 'flow' }, user.id, tx);
      await useCase().execute(
        snapshot.id,
        { balance: '140', editCause: 'correction' },
        user.id,
        tx
      );

      // The 140 was dropped, so the cache stays the recorded 150 (A5 D-1).
      expect((await holdingRowOf(tx, snapshot.id)).balance).toBe('150');
      const rows = await personSnapshotsOf(tx, snapshot.id);
      expect(
        rows.map((o) => ({ balance: o.balance, role: o.role, live: o.supersededAt === null }))
      ).toEqual([{ balance: '150', role: 'snapshot', live: true }]);
    });
  });
});

/**
 * Committed, because the history helper reads committed rows. A hand-kept
 * holding of 100, observed on 1 June, with a deposit of 10 on 1 July its
 * balance never caught up with; then four edits a person makes, each frozen at
 * its own instant so every figure is the same on every run.
 */
describe('UpdateHoldingUseCase — history across a person’s edits (foundation A2)', () => {
  const created = { users: [] as string[], tokens: [] as string[], institutions: [] as string[] };

  afterEach(async () => {
    setSystemTime();
    const db = getDb();
    const users = created.users.splice(0);
    const tokens = created.tokens.splice(0);
    const institutions = created.institutions.splice(0);
    // Users first: their holdings are what keep the tokens restricted.
    if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
    if (tokens.length) await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
    if (institutions.length) {
      await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
    }
  });

  const at = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

  async function committedHolding(
    kind: 'snapshot' | 'feed' | null = 'snapshot',
    { observed = true }: { observed?: boolean } = {}
  ) {
    return await getDb().transaction(async (tx) => {
      const user = await makeUser(tx);
      const bank = await makeInstitutionType(tx, { code: 'bank' });
      const institution = await makeInstitution(tx, { typeId: bank.id });
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const token = await makeToken(tx);
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '100',
        source: 'manual',
        kind,
        startsAt: kind === null ? null : at('2026-06-01'),
        createdAt: at('2026-06-01'),
        lastUpdated: at('2026-06-01'),
      });
      if (observed) {
        await tx.insert(schema.holdingBalanceObservations).values({
          userId: user.id,
          holdingId: holding.id,
          balance: '100',
          observedAt: at('2026-06-01'),
          source: 'sync-capture',
          sourceMetadata: { origin: 'updateHolding' },
        });
      }
      await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: holding.id,
        kind: 'deposit',
        quantity: '10',
        occurredAt: at('2026-07-01'),
        source: 'user-entered',
      });
      created.users.push(user.id);
      created.tokens.push(token.id);
      created.institutions.push(institution.id);
      return { userId: user.id, holdingId: holding.id };
    });
  }

  /** Each edit in its own committed transaction, at its own frozen instant. */
  async function edit(
    fixture: { userId: string; holdingId: string },
    instant: Date,
    data: Parameters<UpdateHoldingUseCase['execute']>[1]
  ) {
    setSystemTime(instant);
    try {
      await getDb().transaction((tx) =>
        useCase().execute(fixture.holdingId, data, fixture.userId, tx)
      );
    } finally {
      setSystemTime();
    }
  }

  async function aPersonsEdits(fixture: { userId: string; holdingId: string }) {
    await edit(fixture, at('2026-08-01'), {
      balance: '150',
      editCause: 'flow',
      editOccurredAt: at('2026-07-20'),
    });
    await edit(fixture, at('2026-08-10'), { balance: '140', editCause: 'correction' });
    await edit(fixture, at('2026-08-20'), { balance: '145', editCause: 'growth' });
    await edit(fixture, at('2026-09-01'), { balance: '160' });
  }

  test('history unchanged: a flow, a correction, a growth and an uncaused edit read as they did before the move', async () => {
    const fixture = await committedHolding();
    await aPersonsEdits(fixture);

    // Read on the engine since A5 PR-2 (D-10). It walks forward from the
    // latest reading and spreads nothing, so each edit is a step on its own
    // day where the old walk ramped it across the interval before (SC-475
    // fault B).
    //   15 May   before the holding's start: absent (the old walk read 100)
    //   15 Jun   the 1 June 100
    //   10 Jul   100 + the 10 deposited on 1 July
    //   25 Jul   110 + the flow row dated 20 July, 40: the edit sizes it
    //            against the engine's 110 (A5 D-15). Under PR-2 it read 160,
    //            a row of 50 sized against a stored 100 this fixture's
    //            deposit never reached (PR-2 golden trace, case 1).
    //   5 Aug    the correction dated 1 Aug + 1 ms restates the interval: 140
    //   15 Aug   the correction's 140, until the growth on 20 Aug
    //   25 Aug   the growth's 145, until the uncaused 160 on 1 Sep
    //   5 Sep, now   160
    const golden: Array<[Date, string | null]> = [
      [at('2026-05-15'), null],
      [at('2026-06-15'), '100'],
      [at('2026-07-10'), '110'],
      [at('2026-07-25'), '150'],
      [at('2026-08-05'), '140'],
      [at('2026-08-15'), '140'],
      [at('2026-08-25'), '145'],
      [at('2026-09-05'), '160'],
      [new Date(), '160'],
    ];
    const readings: HistoryReading[] = golden.map(([instant, balance]) => ({
      holdingId: fixture.holdingId,
      at: instant,
      balance,
      anchor: null,
    }));

    await expectHistoryUnchanged(readings);
    // The control: a figure the walk does not give is caught.
    await expect(
      expectHistoryUnchanged(readings.map((r, i) => (i === 4 ? { ...r, balance: '150' } : r)))
    ).rejects.toThrow();
  });

  test('expectLabelsSettled after a person’s edits on a backfilled snapshot and feed holding', async () => {
    const snapshot = await committedHolding('snapshot');
    const feed = await committedHolding('feed');
    for (const { userId } of [snapshot, feed]) {
      await Container.get(FoundationClassificationService).classify({ apply: true, userId });
    }

    await aPersonsEdits(snapshot);
    await edit(feed, at('2026-08-01'), { balance: '150', editCause: 'flow' });
    await edit(feed, at('2026-08-10'), { balance: '140', editCause: 'correction' });

    await expectLabelsSettled(snapshot.userId);
    await expectLabelsSettled(feed.userId);
  });

  /**
   * R72. The holdings UPDATE runs before `SnapshotWriter.record`, so a second
   * edit of one holding waits on the first's row lock and reads the first's
   * snapshot once it commits. `FOR UPDATE` on the observations locks nothing
   * when there is no snapshot yet, so without that order both first values
   * would stay live.
   */
  test('two concurrent first values on one holding: the later one supersedes the earlier (R72)', async () => {
    const fixture = await committedHolding('snapshot', { observed: false });
    let wrote!: () => void;
    let release!: () => void;
    const firstWrote = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstPid: number | undefined;
    let secondPid: number | undefined;

    const first = getDb().transaction(async (tx) => {
      firstPid = await backendPid(tx);
      await useCase().execute(
        fixture.holdingId,
        { balance: '120', editCause: 'correction' },
        fixture.userId,
        tx
      );
      wrote();
      await released;
    });
    let second: Promise<unknown> = Promise.resolve();
    let blocked = false;
    try {
      // Raced with the transaction itself, so a first edit that throws fails
      // the test rather than leaving it waiting for a write that never comes.
      await Promise.race([firstWrote, first]);
      second = getDb().transaction(async (tx) => {
        secondPid = await backendPid(tx);
        await useCase().execute(
          fixture.holdingId,
          { balance: '130', editCause: 'correction' },
          fixture.userId,
          tx
        );
      });
      // Release the first only once the second is waiting on it, so the
      // interleaving is the race and not a sequence that happened to be safe.
      blocked = await waitUntilBlocked({ pid: () => secondPid, settled: second }, firstPid!);
    } finally {
      // Always, so a failed wait cannot leave the first holding the row lock
      // that the cleanup's user delete would then block on.
      release();
    }
    await Promise.all([first, second]);
    expect(blocked).toBe(true);

    const rows = await getDb()
      .select()
      .from(schema.holdingBalanceObservations)
      .where(eq(schema.holdingBalanceObservations.holdingId, fixture.holdingId))
      .orderBy(asc(schema.holdingBalanceObservations.observedAt));
    expect(
      rows.map((o) => ({ balance: o.balance, role: o.role, live: o.supersededAt === null }))
    ).toEqual([
      { balance: '120', role: 'snapshot', live: false },
      { balance: '130', role: 'snapshot', live: true },
    ]);
  });

  /**
   * A feed's order, its entry first and then its balance, with the edit
   * arriving in between. Released once the edit waits on the feed, or once it
   * has settled without waiting.
   */
  async function anEditBesideAFeed(data: Parameters<UpdateHoldingUseCase['execute']>[1]) {
    const fixture = await committedHolding('snapshot');
    let inserted!: () => void;
    let proceed!: () => void;
    const entryInserted = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    const proceeded = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let feedPid: number | undefined;
    let editPid: number | undefined;

    const feed = getDb().transaction(async (tx) => {
      feedPid = await backendPid(tx);
      await makeHoldingTransaction(tx, {
        userId: fixture.userId,
        holdingId: fixture.holdingId,
        kind: 'deposit',
        quantity: '5',
        occurredAt: at('2026-07-15'),
        source: 'user-entered',
      });
      inserted();
      await proceeded;
      await Container.get(HoldingCacheWriter).apply(
        fixture.userId,
        [{ holdingId: fixture.holdingId, balance: '200' }],
        tx
      );
    });
    let edit: Promise<unknown> = Promise.resolve();
    let blocked = false;
    try {
      await Promise.race([entryInserted, feed]);
      edit = getDb().transaction(async (tx) => {
        editPid = await backendPid(tx);
        await useCase().execute(fixture.holdingId, data, fixture.userId, tx);
      });
      blocked = await waitUntilBlocked({ pid: () => editPid, settled: edit }, feedPid!);
    } finally {
      proceed();
    }
    const outcomes = await Promise.allSettled([feed, edit]);
    return { blocked, outcomes: outcomes.map(outcomeOf) };
  }

  /**
   * R75's lock is NO KEY UPDATE, the lock an UPDATE takes, and not FOR UPDATE.
   * Every ledger row and observation that names a holding holds KEY SHARE on
   * it for its foreign key until it commits, and FOR UPDATE waits on that. A
   * cause-less edit writes no ledger row and already holds the row from its
   * cache write, so with FOR UPDATE it would wait on a feed's uncommitted entry
   * while the feed's own balance write waited on the edit, and Postgres would
   * break that cycle by failing one.
   */
  test('a cause-less edit does not wait on a transaction that only names the holding, so one writing its balance next cannot deadlock with it (R75)', async () => {
    expect(await anEditBesideAFeed({ balance: '150' })).toEqual({
      blocked: false,
      outcomes: ['fulfilled', 'fulfilled'],
    });
  });

  /**
   * An edit whose cause writes a ledger row upserts it, and the upsert locks
   * the holding FOR UPDATE, which waits on that KEY SHARE (R82). So the edit
   * takes FOR UPDATE before its cache write and waits out the feed without
   * holding the row the feed writes next. NO KEY UPDATE at the cache write and
   * FOR UPDATE at the upsert was an upgrade: each held what the other waited on.
   */
  test('an edit whose cause writes a ledger row waits out a transaction that names the holding and then writes it: both commit (no 40P01) (R82)', async () => {
    expect(await anEditBesideAFeed({ balance: '150', editCause: 'flow' })).toEqual({
      blocked: true,
      outcomes: ['fulfilled', 'fulfilled'],
    });
  });

  test('an edit whose cause writes no ledger row (growth) keeps the cause-less lock and does not wait (R82)', async () => {
    expect(await anEditBesideAFeed({ balance: '150', editCause: 'growth' })).toEqual({
      blocked: false,
      outcomes: ['fulfilled', 'fulfilled'],
    });
  });
});

type DestinationTx = Parameters<Parameters<typeof withTestDb>[0]>[0];

const WITHDRAWN_AT = new Date('2026-09-01T08:00:00.000Z');

/** A manual source at 100, an unsynced account and a wallet account, one user. */
async function sourceAndDestinations(tx: DestinationTx) {
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
  });
  await seedReading(tx, {
    userId: user.id,
    holdingId: holding.id,
    balance: '100',
    at: new Date('2026-08-01T00:00:00Z'),
  });
  const fresh = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const wallet = await makeWalletAccount(tx, { userId: user.id, institutionId: institution.id });
  return { user, token, holding, fresh, wallet };
}

/** Sets the source to `balance` as a flow and answers it `internal` into `accountId`. */
async function answeredInto(
  tx: DestinationTx,
  from: { userId: string; holdingId: string; tokenId: string },
  accountId: string,
  balance: string,
  editedAt: Date
) {
  await useCase().execute(
    from.holdingId,
    {
      balance,
      editCause: 'flow',
      editOccurredAt: WITHDRAWN_AT,
      editedAt,
      editOutflow: { decision: 'internal', destination: { accountId, holdingId: null } },
    },
    from.userId,
    tx
  );
  const [opened] = await tx
    .select()
    .from(schema.holdings)
    .where(
      and(eq(schema.holdings.accountId, accountId), eq(schema.holdings.tokenId, from.tokenId))
    );
  if (!opened) throw new Error('no destination');
  return opened;
}

/**
 * The destination an `internal` answer opens through `DeclaredTransferService`,
 * pinned on today's code before that INSERT moves onto `HoldingResolver`
 * (foundation A2). Every assertion here reads the same after the move (D-1).
 */
describe('UpdateHoldingUseCase — the destination an internal answer opens, pinned before it moves (foundation A2)', () => {
  const created = committedRows();

  afterEach(created.drop);

  test('it opens a manual row in an unsynced account and a blockchain row in a wallet account, at zero, moved by the arrival with one observation', async () => {
    await withTestDb(async (tx) => {
      const { user, token, holding, fresh, wallet } = await sourceAndDestinations(tx);
      const from = { userId: user.id, holdingId: holding.id, tokenId: token.id };

      for (const [accountId, source, balance, editedAt] of [
        [fresh.id, 'manual', '60', new Date('2026-09-02T10:00:00.000Z')],
        [wallet.id, 'blockchain', '20', new Date('2026-09-02T11:00:00.000Z')],
      ] as const) {
        const opened = await answeredInto(tx, from, accountId, balance, editedAt);

        expect({
          balance: opened.balance,
          source: opened.source,
          arrival: opened.arrival,
          externalId: opened.externalId,
          label: opened.label,
          isActive: opened.isActive,
          isHidden: opened.isHidden,
          manualEditCause: opened.manualEditCause,
          lastUpdated: opened.lastUpdated,
        }).toEqual({
          balance: '40',
          source,
          arrival: 'user_confirmed',
          externalId: null,
          label: null,
          isActive: true,
          isHidden: false,
          manualEditCause: 'flow',
          lastUpdated: editedAt,
        });
        const arrival = await ledgerFor(tx, opened.id);
        expect(
          arrival.map((r) => ({ kind: r.kind, quantity: r.quantity, occurredAt: r.occurredAt }))
        ).toEqual([{ kind: 'deposit', quantity: '40', occurredAt: WITHDRAWN_AT }]);
        expect(
          (await observationsFor(tx, opened.id)).map((o) => ({
            balance: o.balance,
            source: o.source,
            sourceMetadata: o.sourceMetadata,
            gapReview: o.gapReview,
            authority: o.authority,
            cause: o.cause,
          }))
        ).toEqual([
          {
            balance: '40',
            source: 'sync-capture',
            sourceMetadata: { origin: 'updateHolding' },
            gapReview: 'flow',
            authority: 'person',
            cause: 'flow',
          },
        ]);
      }
    });
  });

  test('history across an internal answer into a created destination reads as it did before the move', async () => {
    const at = (iso: string) => new Date(iso);
    const fixture = await getDb().transaction(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      // One source per destination, each observed once: a second answer dated
      // before the first one's observation would leave drift in the first
      // interval, spread over a span that ends at the wall clock.
      const observedSource = async () => {
        const token = await makeToken(tx);
        created.tokens.push(token.id);
        const holding = await makeHolding(tx, {
          userId: user.id,
          accountId: account.id,
          tokenId: token.id,
          balance: '100',
          source: 'manual',
          createdAt: at('2026-06-01T00:00:00.000Z'),
          lastUpdated: at('2026-06-01T00:00:00.000Z'),
        });
        await tx.insert(schema.holdingBalanceObservations).values({
          userId: user.id,
          holdingId: holding.id,
          balance: '100',
          observedAt: at('2026-06-01T00:00:00.000Z'),
          source: 'sync-capture',
          sourceMetadata: { origin: 'updateHolding' },
        });
        return { userId: user.id, holdingId: holding.id, tokenId: token.id };
      };
      const fresh = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const wallet = await makeWalletAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
      });
      created.users.push(user.id);
      created.institutions.push(institution.id);
      return {
        intoFresh: await observedSource(),
        intoWallet: await observedSource(),
        freshId: fresh.id,
        walletId: wallet.id,
      };
    });

    const fresh = await getDb().transaction((tx) =>
      answeredInto(tx, fixture.intoFresh, fixture.freshId, '60', at('2026-09-02T10:00:00.000Z'))
    );
    const wallet = await getDb().transaction((tx) =>
      answeredInto(tx, fixture.intoWallet, fixture.walletId, '80', at('2026-09-02T11:00:00.000Z'))
    );

    // Before the withdrawal, after it, and now. Each source falls by exactly
    // what left, so no drift is spread; each destination reads the arrival
    // after it. Since A5 PR-2 (D-10) a destination reads absent before its
    // start, the withdrawal, where the old walk read 0.
    const before = at('2026-08-31T00:00:00.000Z');
    const after = at('2026-09-02T00:00:00.000Z');
    const now = new Date();
    const golden: Array<[string, Date, string | null]> = [
      [fixture.intoFresh.holdingId, before, '100'],
      [fixture.intoFresh.holdingId, after, '60'],
      [fixture.intoFresh.holdingId, now, '60'],
      [fixture.intoWallet.holdingId, before, '100'],
      [fixture.intoWallet.holdingId, after, '80'],
      [fixture.intoWallet.holdingId, now, '80'],
      [fresh.id, before, null],
      [fresh.id, after, '40'],
      [fresh.id, now, '40'],
      [wallet.id, before, null],
      [wallet.id, after, '20'],
      [wallet.id, now, '20'],
    ];
    const readings: HistoryReading[] = golden.map(([holdingId, instant, balance]) => ({
      holdingId,
      at: instant,
      balance,
      anchor: null,
    }));

    await expectHistoryUnchanged(readings);
    // The control: a figure the walk does not give is caught.
    await expect(
      expectHistoryUnchanged(readings.map((r, i) => (i === 7 ? { ...r, balance: '0' } : r)))
    ).rejects.toThrow();
  });
});

/**
 * The destination an `internal` answer opens comes from `HoldingResolver`
 * (foundation A2, D-4, D-6): feed in a sync-owned account, else snapshot,
 * starting at the withdrawal's date, opened with no observation. The row, the
 * ledger and the cache are the characterization's above (D-1).
 */
describe('UpdateHoldingUseCase — the destination an internal answer opens comes from HoldingResolver (foundation A2)', () => {
  const created = committedRows();

  afterEach(created.drop);

  // Rule P (D7, R85): neither feed has produced evidence, so both arrivals are
  // snapshots, as the backfill would label them.
  test('a snapshot holding in an unsynced account and a feed one in a wallet account, each starting at the withdrawal’s date, the arrival a snapshot on both before any feed evidence', async () => {
    await withTestDb(async (tx) => {
      const { user, token, holding, fresh, wallet } = await sourceAndDestinations(tx);
      const from = { userId: user.id, holdingId: holding.id, tokenId: token.id };

      for (const [accountId, kind, role, balance, editedAt] of [
        [fresh.id, 'snapshot', 'snapshot', '60', new Date('2026-09-02T10:00:00.000Z')],
        [wallet.id, 'feed', 'snapshot', '20', new Date('2026-09-02T11:00:00.000Z')],
      ] as const) {
        const opened = await answeredInto(tx, from, accountId, balance, editedAt);

        expect({ kind: opened.kind, startsAt: opened.startsAt }).toEqual({
          kind,
          startsAt: WITHDRAWN_AT,
        });
        expect(
          (await observationsFor(tx, opened.id)).map((o) => ({
            balance: o.balance,
            role: o.role,
            authority: o.authority,
            inputId: o.inputId,
            cause: o.cause,
            supersededAt: o.supersededAt,
          }))
        ).toEqual([
          {
            balance: '40',
            role,
            authority: 'person',
            inputId: null,
            cause: 'flow',
            supersededAt: null,
          },
        ]);
      }
      await expectPersonRolesAsClassified(user.id, tx);
    });
  });

  test('expectLabelsSettled after internal answers open a snapshot and a feed destination', async () => {
    const fixture = await getDb().transaction(async (tx) => {
      const opened = await sourceAndDestinations(tx);
      const institution = await tx
        .select({ id: schema.accounts.institutionId })
        .from(schema.accounts)
        .where(eq(schema.accounts.id, opened.fresh.id));
      created.users.push(opened.user.id);
      created.tokens.push(opened.token.id);
      created.institutions.push(...institution.map((row) => row.id));
      return opened;
    });
    const from = {
      userId: fixture.user.id,
      holdingId: fixture.holding.id,
      tokenId: fixture.token.id,
    };
    // The source settled first, as the backfill leaves it.
    await Container.get(FoundationClassificationService).classify({
      apply: true,
      userId: from.userId,
    });

    await getDb().transaction((tx) =>
      answeredInto(tx, from, fixture.fresh.id, '60', new Date('2026-09-02T10:00:00.000Z'))
    );
    await getDb().transaction((tx) =>
      answeredInto(tx, from, fixture.wallet.id, '20', new Date('2026-09-02T11:00:00.000Z'))
    );

    await expectLabelsSettled(from.userId);
  });
});
