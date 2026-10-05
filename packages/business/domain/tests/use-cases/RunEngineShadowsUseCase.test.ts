import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import type { ShadowRunSummary } from '../../src/repositories/EngineShadowReportRepository';
import {
  type BalanceShadowInput,
  BalanceShadowService,
} from '../../src/services/foundation/BalanceShadowService';
import {
  type PriceShadowInput,
  PriceShadowService,
} from '../../src/services/foundation/PriceShadowService';
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

function harness(fails: { balance?: Error; price?: Error } = {}) {
  // Every shadow run and every report, in the order they happened.
  const events: string[] = [];
  const balanceInputs: BalanceShadowInput[] = [];
  const priceInputs: PriceShadowInput[] = [];
  Container.set(BalanceShadowService, {
    run: async (input: BalanceShadowInput) => {
      events.push('ran balance');
      balanceInputs.push(input);
      if (fails.balance) throw fails.balance;
      return { runId: 'balance-run', summary: summary(3) };
    },
  } as unknown as BalanceShadowService);
  Container.set(PriceShadowService, {
    run: async (input: PriceShadowInput) => {
      events.push('ran price');
      priceInputs.push(input);
      if (fails.price) throw fails.price;
      return { runId: 'price-run', summary: summary(2) };
    },
  } as unknown as PriceShadowService);
  const onRecorded = async (run: EngineShadowRunResult) => {
    events.push(`recorded ${run.runId}`);
  };
  return { useCase: new RunEngineShadowsUseCase(), events, balanceInputs, priceInputs, onRecorded };
}

describe('RunEngineShadowsUseCase', () => {
  test('runs both shadows: the balance shadow 7 and 30 days back too, the price shadow at five past day closes', async () => {
    const { useCase, events, balanceInputs, priceInputs } = harness();
    const asOf = new Date('2026-03-01T00:00:00.000Z');

    const runs = await useCase.execute({ asOf });

    expect(events).toEqual(['ran price', 'ran balance']);
    expect(balanceInputs).toEqual([
      {
        asOf,
        pastInstants: [new Date('2026-02-22T00:00:00.000Z'), new Date('2026-01-30T00:00:00.000Z')],
        userId: undefined,
      },
    ]);
    expect(priceInputs).toEqual([
      {
        asOf,
        pastInstants: [
          new Date('2026-02-28T23:59:59.999Z'),
          new Date('2026-02-26T23:59:59.999Z'),
          new Date('2026-02-22T23:59:59.999Z'),
          new Date('2026-01-30T23:59:59.999Z'),
          new Date('2025-03-01T23:59:59.999Z'),
        ],
        userId: undefined,
      },
    ]);
    expect(runs).toEqual([
      { kind: 'price', runId: 'price-run', summary: summary(2) },
      { kind: 'balance', runId: 'balance-run', summary: summary(3) },
    ]);
  });

  test('kinds narrows the run', async () => {
    const asOf = new Date('2026-03-01T00:00:00.000Z');

    const price = harness();
    const priceRuns = await price.useCase.execute({ asOf, userId: 'user-1', kinds: ['price'] });
    expect(price.events).toEqual(['ran price']);
    expect(price.priceInputs).toEqual([
      { asOf, pastInstants: expect.any(Array), userId: 'user-1' },
    ]);
    expect(priceRuns.map((r) => r.kind)).toEqual(['price']);

    const balance = harness();
    const balanceRuns = await balance.useCase.execute({
      asOf,
      userId: 'user-1',
      kinds: ['balance'],
    });
    expect(balance.events).toEqual(['ran balance']);
    expect(balance.balanceInputs[0]?.userId).toBe('user-1');
    expect(balanceRuns.map((r) => r.kind)).toEqual(['balance']);
  });

  test('a kind named twice runs once, and the order is always price then balance', async () => {
    const { useCase, events } = harness();

    await useCase.execute({ asOf: new Date(), kinds: ['balance', 'price', 'balance'] });

    expect(events).toEqual(['ran price', 'ran balance']);
  });

  test('each run is reported, and the report awaited, before the next kind starts', async () => {
    const { useCase, events } = harness();

    await useCase.execute({
      asOf: new Date(),
      onRecorded: async (run) => {
        events.push(`reporting ${run.runId}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`reported ${run.runId}`);
      },
    });

    expect(events).toEqual([
      'ran price',
      'reporting price-run',
      'reported price-run',
      'ran balance',
      'reporting balance-run',
      'reported balance-run',
    ]);
  });

  test('a failing price shadow still lets the balance shadow run, then rethrows', async () => {
    const failure = new Error('price shadow broke');
    const { useCase, events, onRecorded } = harness({ price: failure });

    await expect(useCase.execute({ asOf: new Date(), onRecorded })).rejects.toBe(failure);
    expect(events).toEqual(['ran price', 'ran balance', 'recorded balance-run']);
  });

  test('a run that completed is reported before a failing balance shadow is rethrown', async () => {
    const failure = new Error('balance shadow broke');
    const { useCase, events, onRecorded } = harness({ balance: failure });

    await expect(useCase.execute({ asOf: new Date(), onRecorded })).rejects.toBe(failure);
    expect(events).toEqual(['ran price', 'recorded price-run', 'ran balance']);
  });

  test('a report that throws fails its own kind, and the other kind still runs', async () => {
    const { useCase, events } = harness();
    const failure = new Error('could not print');

    const outcome = useCase.execute({
      asOf: new Date(),
      onRecorded: async (run) => {
        events.push(`recorded ${run.runId}`);
        if (run.kind === 'price') throw failure;
      },
    });

    await expect(outcome).rejects.toBe(failure);
    expect(events).toEqual([
      'ran price',
      'recorded price-run',
      'ran balance',
      'recorded balance-run',
    ]);
  });

  test("when both fail, an AggregateError carries both in run order, its message each cause's first line", async () => {
    const priceFailure = new Error('price shadow broke\n    at somewhere (price.ts:1)');
    const balanceFailure = new Error('balance shadow broke\n    at elsewhere (balance.ts:2)');
    const { useCase, events } = harness({ balance: balanceFailure, price: priceFailure });

    const thrown = await useCase.execute({ asOf: new Date() }).catch((err: unknown) => err);

    expect(events).toEqual(['ran price', 'ran balance']);
    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors).toEqual([priceFailure, balanceFailure]);
    expect(aggregate.message).toBe(
      'the price and balance shadows failed: price: price shadow broke; balance: balance shadow broke'
    );
  });
});
