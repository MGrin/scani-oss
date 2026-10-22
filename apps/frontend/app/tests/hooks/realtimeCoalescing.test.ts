import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  createRealtimeInvalidator,
  invalidatePortfolioQueries,
} from '../../src/hooks/invalidatePortfolioQueries';

/**
 * SC-1754. Every `entity_changed` invalidated the whole portfolio set, and
 * React Query does not dedupe that: `invalidateQueries` refetches with
 * `cancelRefetch: true`, so each event cancels the fetch in flight and starts
 * another, while the server keeps computing the cancelled one. Production ran
 * the home set 5-15 times in one minute.
 *
 * These run against a real QueryClient, because the defect lives in its
 * semantics and a recording stub cannot see it.
 */

type Utils = Parameters<typeof invalidatePortfolioQueries>[0];
const ROUTERS = [
  'accounts',
  'holdings',
  'institutions',
  'dashboard',
  'vaults',
  'groups',
  'transactions',
  'liabilities',
  'portfolio',
  'review',
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const clients: QueryClient[] = [];
const unsubscribes: (() => void)[] = [];
afterEach(() => {
  for (const u of unsubscribes.splice(0)) u();
  for (const c of clients.splice(0)) c.clear();
});

/** A client with one mounted `dashboard` query whose server state moves per event. */
function harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  const server = { version: 0, fetches: 0 };
  const observer = new QueryObserver(client, {
    queryKey: ['dashboard'],
    queryFn: async () => {
      server.fetches += 1;
      const seen = server.version;
      await sleep(30);
      return seen;
    },
  });
  unsubscribes.push(observer.subscribe(() => {}));
  const router = (name: string) => ({
    invalidate: (_input?: unknown, opts?: { refetchType?: 'all' | 'active' }) =>
      client.invalidateQueries({ queryKey: [name], refetchType: opts?.refetchType ?? 'active' }),
  });
  const utils = Object.fromEntries(ROUTERS.map((n) => [n, router(n)])) as unknown as Utils;
  return { client, server, utils, observer };
}

async function settled(h: ReturnType<typeof harness>) {
  await sleep(0);
  while (h.client.isFetching() > 0) await sleep(5);
}

describe('a burst of realtime events (SC-1754)', () => {
  test('control: one invalidation per event costs one server fetch per event', async () => {
    const h = harness();
    await settled(h);
    const before = h.server.fetches;
    for (let i = 0; i < 5; i++) {
      h.server.version += 1;
      void invalidatePortfolioQueries(h.utils);
      await sleep(10);
    }
    await settled(h);
    expect(h.server.fetches - before).toBe(5);
  });

  test('coalesced, the same burst costs one fetch, and it reads the last event', async () => {
    const h = harness();
    await settled(h);
    const before = h.server.fetches;
    // The quiet window is 15x the gap, so a loaded runner stretching each
    // sleep still cannot make the burst look like two.
    const inv = createRealtimeInvalidator(() => h.utils, { quietMs: 150, maxWaitMs: 5000 });
    for (let i = 0; i < 5; i++) {
      h.server.version += 1;
      inv.entity('holding');
      await sleep(10);
    }
    await sleep(200);
    await settled(h);
    expect(h.server.fetches - before).toBe(1);
    expect(h.observer.getCurrentResult().data).toBe(5);
    inv.dispose();
  });

  test('a burst that never goes quiet still refreshes within the max wait', async () => {
    const h = harness();
    await settled(h);
    const before = h.server.fetches;
    // Quiet never elapses here (it is longer than the max wait), so every
    // flush is the max-wait one: one per 100ms of burst, however slow the box.
    const inv = createRealtimeInvalidator(() => h.utils, { quietMs: 1000, maxWaitMs: 100 });
    const started = performance.now();
    for (let i = 0; i < 30; i++) {
      inv.entity('account');
      await sleep(10);
    }
    const elapsed = performance.now() - started;
    const during = h.server.fetches - before;
    inv.dispose();
    expect(during).toBeGreaterThanOrEqual(2);
    expect(during).toBeLessThanOrEqual(Math.ceil(elapsed / 100) + 1);
    expect(during).toBeLessThan(30);
  });

  test('control: an event nothing maps to schedules no fetch', async () => {
    const h = harness();
    await settled(h);
    const before = h.server.fetches;
    const inv = createRealtimeInvalidator(() => h.utils, { quietMs: 10, maxWaitMs: 50 });
    inv.entity('schedule');
    inv.job({ state: 'progress' });
    await sleep(80);
    await settled(h);
    expect(h.server.fetches - before).toBe(0);
    inv.dispose();
  });

  test('dispose drops a pending refresh', async () => {
    const h = harness();
    await settled(h);
    const before = h.server.fetches;
    const inv = createRealtimeInvalidator(() => h.utils, { quietMs: 20, maxWaitMs: 50 });
    inv.entity('holding');
    inv.dispose();
    await sleep(80);
    expect(h.server.fetches - before).toBe(0);
  });
});
