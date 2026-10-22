import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { ReturnsLastCompleteRepository } from '../../../src/repositories/ReturnsLastCompleteRepository';
import { BenchmarkReturnService } from '../../../src/services/returns/BenchmarkReturnService';
import {
  lastCompleteWindowKey,
  ReturnsLastCompleteService,
} from '../../../src/services/returns/ReturnsLastCompleteService';
import { type ReturnsRequest, ReturnsService } from '../../../src/services/returns/ReturnsService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

const USER = '00000000-0000-4000-8000-0000000000aa';
const NOW = new Date('2026-10-11T01:30:00.000Z');
const DAY_MS = 86_400_000;

function result(eligible: boolean) {
  return {
    scope: { kind: 'user' },
    baseCurrencyId: 'usd',
    requestedWindow: { kind: 'custom', from: '2026-07-13', to: '2026-10-11' },
    effectiveWindow: { from: '2026-07-12', to: '2026-10-11' },
    startValue: '100',
    endValue: '110',
    netExternalFlow: '0',
    series: [{ date: '2026-10-11', value: '110', netExternalFlow: '0' }],
    twr: { cumulative: '0.1', annualized: null, periods: [{}], measuredPeriods: 1 },
    attribution: null,
    xirr: { status: 'undefined', reason: 'too-few-flows' },
    coverage: {},
    eligibility: eligible
      ? { eligible: true, reasons: [] }
      : { eligible: false, reasons: ['rebuilding-history'] },
    subset: null,
  };
}

function setup(withheld: (request: ReturnsRequest) => boolean = () => false) {
  const asked: ReturnsRequest[] = [];
  const saved: Array<{ windowKey: string; scopeKey: string; answer: unknown; force?: boolean }> =
    [];
  Container.set(ReturnsService, {
    compute: async (request: ReturnsRequest) => {
      asked.push(request);
      return { status: 'ok', returns: result(!withheld(request)) };
    },
  } as unknown as ReturnsService);
  Container.set(BenchmarkReturnService, {
    over: async () => [{ key: 'btc', cumulative: '0.2' }],
  } as unknown as BenchmarkReturnService);
  Container.set(ReturnsLastCompleteRepository, {
    save: async (
      row: { windowKey: string; scopeKey: string; answer: unknown },
      options?: { force?: boolean }
    ) => {
      saved.push({ ...row, force: options?.force });
    },
    find: async () => null,
  } as unknown as ReturnsLastCompleteRepository);
  const service = new ReturnsLastCompleteService();
  return { service, asked, saved };
}

// Home's chart asks for the period on screen and its tile asks for YTD. While a
// rebuild runs, each shows the last answer kept for exactly its window, and a
// window only Home's chart asks for was kept only if someone had the Returns
// tab open at an eligible moment, so mgrin's 3M read "—" (SC-1707).
describe('ReturnsLastCompleteService.refreshHome (SC-1707)', () => {
  test('keeps every window Home offers, under the key getReturns asks with', async () => {
    const { service, saved } = setup();
    await service.refreshHome(USER, { now: NOW, ignoreRebuildJobId: 'job-1' });

    const homeKeys = [7, 30, 90, 180, 365].map((days) =>
      lastCompleteWindowKey({
        kind: 'custom',
        from: new Date(NOW.getTime() - days * DAY_MS),
        to: NOW,
      })
    );
    expect(saved.map((row) => row.windowKey).sort()).toEqual(
      [...homeKeys, lastCompleteWindowKey({ kind: 'ytd' })].sort()
    );
    expect(saved.every((row) => row.scopeKey === '{"kind":"user"}')).toBe(true);
  });

  test('keeps the answer as the wire carries it, benchmarks included', async () => {
    const { service, saved } = setup();
    await service.refreshHome(USER, { now: NOW });
    const answer = saved[0]?.answer as { returns: Record<string, unknown>; benchmarks: unknown };
    expect(answer.benchmarks).toEqual([{ key: 'btc', cumulative: '0.2' }]);
    expect('series' in answer.returns).toBe(false);
  });

  test('replaces what is kept even when it is minutes old: the rebuild changed the data', async () => {
    const { service, saved } = setup();
    await service.refreshHome(USER, { now: NOW });
    expect(saved.every((row) => row.force === true)).toBe(true);
  });

  test('reads past the finishing rebuild, and only that one', async () => {
    const { service, asked } = setup();
    await service.refreshHome(USER, { now: NOW, ignoreRebuildJobId: 'job-1' });
    expect(asked.length).toBe(6);
    expect(asked.every((request) => request.ignoreRebuildJobId === 'job-1')).toBe(true);
    expect(asked.every((request) => request.now?.getTime() === NOW.getTime())).toBe(true);
  });

  test('a window still withheld is not kept; the others are', async () => {
    const { service, saved } = setup((request) => request.window.kind === 'ytd');
    await service.refreshHome(USER, { now: NOW });
    expect(saved.length).toBe(5);
    expect(saved.some((row) => row.windowKey === 'ytd')).toBe(false);
  });
});
