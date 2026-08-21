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
import { UpdateHoldingUseCase } from '../../src/use-cases/UpdateHoldingUseCase';
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
