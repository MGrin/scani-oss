import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import type { ShadowRunSummary } from '../../src/repositories/EngineShadowReportRepository';
import {
  type BalanceShadowInput,
  BalanceShadowService,
} from '../../src/services/foundation/BalanceShadowService';
import {
  type ValueShadowInput,
  ValueShadowService,
} from '../../src/services/foundation/ValueShadowService';
import {
  type EngineShadowRunResult,
  RunEngineShadowsUseCase,
} from '../../src/use-cases/RunEngineShadowsUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

restoreContainerAfterAll();

const summary = (compared: number): ShadowRunSummary => ({
  compared,
  matched: compared,
  byCategory: {},
  durationMs: 1,
});

function harness(fails: { balance?: Error } = {}) {
  // Every shadow run and every report, in the order they happened.
  const events: string[] = [];
  const balanceInputs: BalanceShadowInput[] = [];
  Container.set(BalanceShadowService, {
    run: async (input: BalanceShadowInput) => {
      events.push('ran balance');
      balanceInputs.push(input);
      if (fails.balance) throw fails.balance;
      return { runId: 'balance-run', summary: summary(3) };
    },
  } as unknown as BalanceShadowService);
  const valueInputs: ValueShadowInput[] = [];
  Container.set(ValueShadowService, {
    run: async (input: ValueShadowInput) => {
      events.push('ran value');
      valueInputs.push(input);
      return { runId: 'value-run', summary: summary(2) };
    },
  } as unknown as ValueShadowService);
  const onRecorded = async (run: EngineShadowRunResult) => {
    events.push(`recorded ${run.runId}`);
  };
  return { useCase: new RunEngineShadowsUseCase(), events, balanceInputs, valueInputs, onRecorded };
}

describe('RunEngineShadowsUseCase', () => {
  test('runs the balance shadow, 7 and 30 days back too, then the value shadow at asOf', async () => {
    const { useCase, events, balanceInputs, valueInputs } = harness();
    const asOf = new Date('2026-03-01T00:00:00.000Z');

    const runs = await useCase.execute({ asOf });

    expect(events).toEqual(['ran balance', 'ran value']);
    expect(valueInputs).toEqual([{ asOf, userId: undefined }]);
    expect(balanceInputs).toEqual([{ asOf, userId: undefined }]);
    expect(runs).toEqual([
      { kind: 'balance', runId: 'balance-run', summary: summary(3) },
      { kind: 'value', runId: 'value-run', summary: summary(2) },
    ]);
  });

  test('kinds narrows the run, and a kind named twice runs once', async () => {
    const asOf = new Date('2026-03-01T00:00:00.000Z');

    const none = harness();
    expect(await none.useCase.execute({ asOf, kinds: [] })).toEqual([]);
    expect(none.events).toEqual([]);

    const balance = harness();
    const runs = await balance.useCase.execute({
      asOf,
      userId: 'user-1',
      kinds: ['balance', 'balance'],
    });
    expect(balance.events).toEqual(['ran balance']);
    expect(balance.balanceInputs[0]?.userId).toBe('user-1');
    expect(runs.map((r) => r.kind)).toEqual(['balance']);
  });

  test('each run is reported, and the report awaited, before execute returns', async () => {
    const { useCase, events } = harness();

    await useCase.execute({
      asOf: new Date(),
      onRecorded: async (run) => {
        events.push(`reporting ${run.runId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`reported ${run.runId}`);
      },
    });
    events.push('returned');

    expect(events).toEqual([
      'ran balance',
      'reporting balance-run',
      'reported balance-run',
      'ran value',
      'reporting value-run',
      'reported value-run',
      'returned',
    ]);
  });

  test('a failing shadow is rethrown, and nothing is reported', async () => {
    const failure = new Error('balance shadow broke');
    const { useCase, events, onRecorded } = harness({ balance: failure });

    await expect(useCase.execute({ asOf: new Date(), onRecorded })).rejects.toBe(failure);
    expect(events).toEqual(['ran balance']);
  });

  test('a report that throws is rethrown', async () => {
    const { useCase } = harness();
    const failure = new Error('could not print');

    const outcome = useCase.execute({
      asOf: new Date(),
      onRecorded: async () => {
        throw failure;
      },
    });

    await expect(outcome).rejects.toBe(failure);
  });
});
