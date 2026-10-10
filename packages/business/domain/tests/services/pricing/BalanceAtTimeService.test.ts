import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { EngineEvidenceRepository } from '../../../src/repositories/EngineEvidenceRepository';
import {
  type BalanceAtTimeResult,
  BalanceAtTimeService,
} from '../../../src/services/pricing/BalanceAtTimeService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeObservations,
  makeToken,
} from '../../../test/helpers/factories-extra';

/**
 * A5 flip PR-2: history's balance reads come from the engine's `balanceAt`
 * over classified evidence (D-6), mapped onto the result shape every reader
 * already consumes (D-10). The engine's own rules are pinned in
 * `tests/engine/`; these pin the mapping, the two behaviours the old walk had
 * and the engine does not, and the batched load (D-11).
 */

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

async function holdingOf(tx: DatabaseTransaction, createdAt = day('2026-01-01')) {
  const user = await makeUser(tx);
  const account = await makeAccount(tx, {
    userId: user.id,
    institutionId: (await makeInstitution(tx)).id,
  });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    createdAt,
  });
  return { userId: user.id, holding };
}

/** A person's value, as `SnapshotWriter` records it. */
function snapshot(userId: string, holdingId: string, observedAt: Date, balance: string) {
  return {
    userId,
    holdingId,
    observedAt,
    balance,
    source: 'sync-capture',
    role: 'snapshot' as const,
    authority: 'person' as const,
    cause: 'flow' as const,
  };
}

const service = () => Container.get(BalanceAtTimeService);

describe('BalanceAtTimeService.getBalance answers from the engine (D-10)', () => {
  test('before the holding starts, the balance is absent and marked before-records', async () => {
    await withTestDb(async (tx) => {
      const { userId, holding } = await holdingOf(tx);
      await makeObservations(tx, [snapshot(userId, holding.id, day('2026-02-01'), '100')]);

      const result = await service().getBalance(holding.id, day('2025-12-01'), tx);

      expect(result).toEqual({
        balance: null,
        anchor: null,
        anchorAt: null,
        beforeRecords: true,
      });
    });
  });

  test('after a reading, the walk runs forward from it', async () => {
    await withTestDb(async (tx) => {
      const { userId, holding } = await holdingOf(tx);
      await makeObservations(tx, [snapshot(userId, holding.id, day('2026-02-01'), '100')]);
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: holding.id,
        kind: 'deposit',
        quantity: '10',
        occurredAt: day('2026-02-05'),
      });

      const result = await service().getBalance(holding.id, day('2026-02-10'), tx);

      expect(result.balance?.toString()).toBe('110');
      expect(result.anchor).toBe('observation-before');
      expect(result.anchorAt?.toISOString()).toBe(day('2026-02-01').toISOString());
      expect(result.beforeRecords).toBe(false);
    });
  });

  test('before the first reading of a snapshot holding, its first value stands', async () => {
    await withTestDb(async (tx) => {
      const { userId, holding } = await holdingOf(tx);
      await makeObservations(tx, [snapshot(userId, holding.id, day('2026-02-01'), '100')]);

      const result = await service().getBalance(holding.id, day('2026-01-15'), tx);

      expect(result.balance?.toString()).toBe('100');
      expect(result.anchor).toBe('observation-after');
      expect(result.beforeRecords).toBe(false);
    });
  });

  test('a holding with a ledger and no reading sums its ledger, with no anchor', async () => {
    await withTestDb(async (tx) => {
      const { userId, holding } = await holdingOf(tx);
      for (const [quantity, at] of [
        ['10', '2026-02-01'],
        ['5', '2026-02-03'],
      ] as const) {
        await makeHoldingTransaction(tx, {
          userId,
          holdingId: holding.id,
          kind: 'deposit',
          quantity,
          occurredAt: day(at),
        });
      }

      const result = await service().getBalance(holding.id, day('2026-02-10'), tx);

      expect(result.balance?.toString()).toBe('15');
      expect(result.anchor).toBeNull();
      expect(result.beforeRecords).toBe(false);
    });
  });
});

describe('BalanceAtTimeService.getBalance: what the old walk did and the engine does not', () => {
  test('an unexplained gap is not spread: the day reads the reading before it', async () => {
    // The old walk drew a straight line from 100 to 170 (SC-475 fault B) and
    // read ~135 here, flagged interpolated. The engine records no event
    // between the two readings, so the balance is the last one measured.
    await withTestDb(async (tx) => {
      const { userId, holding } = await holdingOf(tx);
      await makeObservations(tx, [
        snapshot(userId, holding.id, day('2026-02-01'), '100'),
        snapshot(userId, holding.id, day('2026-04-12'), '170'),
      ]);

      const result = await service().getBalance(holding.id, day('2026-03-08'), tx);

      expect(result.balance?.toString()).toBe('100');
    });
  });

  test('a walk below zero is reported as it is, not floored', async () => {
    await withTestDb(async (tx) => {
      const { userId, holding } = await holdingOf(tx);
      await makeObservations(tx, [snapshot(userId, holding.id, day('2026-02-01'), '5')]);
      await makeHoldingTransaction(tx, {
        userId,
        holdingId: holding.id,
        kind: 'withdraw',
        quantity: '-10',
        occurredAt: day('2026-02-05'),
      });

      const result = await service().getBalance(holding.id, day('2026-02-10'), tx);

      expect(result.balance?.toString()).toBe('-5');
    });
  });
});

describe('BalanceAtTimeService.balancesFor loads evidence in batches (D-11)', () => {
  test('answers every holding at every instant, as getBalance does, 25 holdings per load', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const account = await makeAccount(tx, {
        userId: user.id,
        institutionId: (await makeInstitution(tx)).id,
      });
      const ids: string[] = [];
      for (let i = 0; i < 30; i++) {
        const token = await makeToken(tx);
        const holding = await makeHolding(tx, {
          userId: user.id,
          accountId: account.id,
          tokenId: token.id,
          createdAt: day('2026-01-01'),
        });
        await makeObservations(tx, [
          snapshot(user.id, holding.id, day('2026-02-01'), String(100 + i)),
        ]);
        ids.push(holding.id);
      }
      const instants = [day('2025-12-01'), day('2026-01-15'), day('2026-02-10')];

      const repository = Container.get(EngineEvidenceRepository);
      const original = repository.findHoldingEvidence.bind(repository);
      const loads: number[] = [];
      repository.findHoldingEvidence = async (scope, t) => {
        loads.push(scope.holdingIds?.length ?? -1);
        return original(scope, t);
      };
      let answers: Map<string, Map<number, BalanceAtTimeResult>>;
      try {
        answers = await service().balancesFor(user.id, ids, instants, tx);
      } finally {
        repository.findHoldingEvidence = original;
      }

      expect(loads).toEqual([25, 5]);
      for (const id of ids) {
        for (const at of instants) {
          const single = await service().getBalance(id, at, tx);
          expect(answers.get(id)?.get(at.getTime())).toEqual(single);
        }
      }
    });
  });

  test('getBalance answers from a handed-in answer without loading anything', async () => {
    const at = day('2026-02-10');
    const handed: BalanceAtTimeResult = {
      balance: new Decimal('42'),
      anchor: 'observation-before',
      anchorAt: day('2026-02-01'),
      beforeRecords: false,
    };
    const result = await service().getBalance('no-such-holding', at, undefined, {
      balances: new Map([['no-such-holding', new Map([[at.getTime(), handed]])]]),
    });
    expect(result).toBe(handed);
  });
});
