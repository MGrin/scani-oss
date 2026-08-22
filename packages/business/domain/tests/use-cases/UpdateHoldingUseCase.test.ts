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
import {
  HoldingLabelTakenError,
  UpdateHoldingUseCase,
} from '../../src/use-cases/UpdateHoldingUseCase';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const useCase = () => Container.get(UpdateHoldingUseCase);

async function scaffold(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
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
  return { user, account, token, holding };
}

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
      const { user, holding } = await scaffold(tx);

      const result = await useCase().execute(holding.id, { label: 'Savings' }, user.id, tx);

      expect(result.lastUpdated.toISOString()).toBe(holding.lastUpdated.toISOString());
    });
  });

  test('a balance edit still bumps lastUpdated', async () => {
    // The control for the test above. Without it, an implementation that never
    // wrote `lastUpdated` at all would pass, and the freshness signal the whole
    // holdings list reads would be dead rather than accurate.
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      const result = await useCase().execute(holding.id, { balance: '150' }, user.id, tx);

      expect(result.lastUpdated.getTime()).toBeGreaterThan(holding.lastUpdated.getTime());
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
