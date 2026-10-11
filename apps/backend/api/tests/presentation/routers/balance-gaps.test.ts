import { beforeEach, describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { BalanceGapService, PortfolioValueCache } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { ReconcilePaymentsUseCase } from '@scani/domain/use-cases';
import { BullMqEnqueueService, QueueClient } from '@scani/queue';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

/**
 * SC-1665 Part 4. A gap answered as money in or out is a ledger row, and a
 * bill that row pays is marked paid at once rather than by hand.
 */

restoreContainerAfterAll();

const USER = '00000000-0000-4000-8000-000000000001';
const OBSERVATION = '00000000-0000-4000-8000-0000000000aa';
const dbUser = { id: USER, email: 'gap@test.local' } as typeof schema.users.$inferSelect;

let reconciled: string[] = [];

function answering(wroteKind: string | null, reconcile: () => Promise<unknown>) {
  Container.set(BalanceGapService, {
    answer: async () => ({
      result: { observationId: OBSERVATION, answer: 'flow', wroteKind, occurredAt: null },
    }),
  } as unknown as BalanceGapService);
  Container.set(ReconcilePaymentsUseCase, {
    execute: async (userId: string) => {
      reconciled.push(userId);
      return reconcile();
    },
  } as unknown as ReconcilePaymentsUseCase);
}

beforeEach(() => {
  reconciled = [];
  Container.set(PortfolioValueCache, { bust: async () => {} } as unknown as PortfolioValueCache);
  Container.set(BullMqEnqueueService, {
    add: async () => 'job',
  } as unknown as BullMqEnqueueService);
  Container.set(QueueClient, {
    get: () => ({ getJobState: async () => 'unknown', getJob: async () => undefined }),
  } as unknown as QueueClient);
});

describe('balanceGaps.answer marks the bill the answer pays', () => {
  test('an answer that wrote a deposit matches bills for that user', async () => {
    answering('deposit', async () => ({ scanned: 1, matched: 1 }));
    await makeAuthedCaller(dbUser).balanceGaps.answer({
      observationId: OBSERVATION,
      answer: 'flow',
    });
    expect(reconciled).toEqual([USER]);
  });

  test('a withdrawal is matched too: a bill can be money out', async () => {
    answering('withdraw', async () => ({ scanned: 1, matched: 1 }));
    await makeAuthedCaller(dbUser).balanceGaps.answer({
      observationId: OBSERVATION,
      answer: 'flow',
    });
    expect(reconciled).toEqual([USER]);
  });

  test('control: an answer that wrote no flow row matches nothing', async () => {
    answering(null, async () => ({ scanned: 0, matched: 0 }));
    await makeAuthedCaller(dbUser).balanceGaps.answer({
      observationId: OBSERVATION,
      answer: 'unknown',
    });
    expect(reconciled).toEqual([]);
  });

  test('a failed match still returns the answer, which is already saved', async () => {
    answering('deposit', async () => {
      throw new Error('vendor lookup timed out');
    });
    const result = await makeAuthedCaller(dbUser).balanceGaps.answer({
      observationId: OBSERVATION,
      answer: 'flow',
    });
    expect(result.wroteKind).toBe('deposit');
    expect(reconciled).toEqual([USER]);
  });
});

describe('balanceGaps.answer passes the parts through (SC-1665)', () => {
  test('a divided answer reaches the service whole, not dropped by the router', async () => {
    let received: unknown;
    Container.set(BalanceGapService, {
      answer: async (_userId: string, input: unknown) => {
        received = input;
        return {
          result: { observationId: OBSERVATION, answer: 'flow', wroteKind: null, occurredAt: null },
        };
      },
    } as unknown as BalanceGapService);
    Container.set(ReconcilePaymentsUseCase, {
      execute: async () => ({ scanned: 0, matched: 0 }),
    } as unknown as ReconcilePaymentsUseCase);
    const parts = [
      {
        decision: 'internal' as const,
        quantity: '120',
        destination: { accountId: crypto.randomUUID(), holdingId: crypto.randomUUID() },
      },
      { decision: 'left_control' as const, quantity: '80' },
    ];
    await makeAuthedCaller(dbUser).balanceGaps.answer({
      observationId: OBSERVATION,
      answer: 'flow',
      parts,
    });
    expect(received).toMatchObject({ parts });
  });
});
