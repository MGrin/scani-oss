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
import { and, eq } from 'drizzle-orm';
import { Container } from 'typedi';
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
});
