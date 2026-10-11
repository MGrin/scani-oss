import { describe, expect, test } from 'bun:test';
import type { ReturnsRequest } from '@scani/domain/services';
import { ReturnsWorkerPool, type WorkerLike } from '../src/returns-pool';

/**
 * SC-1671. `getReturns` held the API's one event loop for 6 s per Home load,
 * so it runs in one worker thread. Each case below is a way that thread could
 * take the API down with it: a queue that grows without end, a calculation
 * that never returns, a crash, a heap that grows until the machine is full.
 */

/** A call the test does not await: its later rejection is expected, not a fault. */
const ignore = (call: Promise<unknown>) => void call.catch(() => {});

const REQUEST: ReturnsRequest = { userId: 'u', scope: { kind: 'user' }, window: { kind: 'all' } };

class FakeWorker implements WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Array<{ id: number; dataKey: string }> = [];
  terminated = false;
  postMessage(message: { id: number; dataKey: string }): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function makePool(options: { maxPending?: number; timeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const pool = new ReturnsWorkerPool({
    spawn: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    maxPending: options.maxPending ?? 8,
    timeoutMs: options.timeoutMs ?? 1_000,
  });
  return { pool, workers };
}

describe('ReturnsWorkerPool (SC-1671)', () => {
  test('it starts one worker only when first asked, and answers each call by its id', async () => {
    const { pool, workers } = makePool();
    expect(workers).toHaveLength(0);
    const a = pool.run(REQUEST, 'v1');
    const b = pool.run({ ...REQUEST, window: { kind: 'ytd' } }, 'v1');
    expect(workers).toHaveLength(1);
    const [first, second] = workers[0]?.posted ?? [];
    workers[0]?.reply({ id: second?.id, ok: true, outcome: { status: 'second' } });
    workers[0]?.reply({ id: first?.id, ok: true, outcome: { status: 'first' } });
    expect(await a).toEqual({ status: 'first' } as never);
    expect(await b).toEqual({ status: 'second' } as never);
  });

  test('the queue is bounded: a call past the bound is refused at once', async () => {
    const { pool, workers } = makePool({ maxPending: 2 });
    ignore(pool.run(REQUEST, 'v1'));
    ignore(pool.run(REQUEST, 'v1'));
    await expect(pool.run(REQUEST, 'v1')).rejects.toThrow('returns queue full');
    expect(workers[0]?.posted).toHaveLength(2);
  });

  test('a calculation past the timeout fails every call in flight and replaces the worker', async () => {
    const { pool, workers } = makePool({ timeoutMs: 20 });
    const settled = await Promise.allSettled([pool.run(REQUEST, 'v1'), pool.run(REQUEST, 'v1')]);
    expect(settled.map((s) => (s.status === 'rejected' ? String(s.reason) : 'resolved'))).toEqual([
      'Error: returns timed out',
      'Error: returns timed out',
    ]);
    expect(workers[0]?.terminated).toBe(true);
    const next = pool.run(REQUEST, 'v1');
    expect(workers).toHaveLength(2);
    const [message] = workers[1]?.posted ?? [];
    workers[1]?.reply({ id: message?.id, ok: true, outcome: { status: 'ok' } });
    expect(await next).toEqual({ status: 'ok' } as never);
  });

  test('a crashed worker fails its calls and the next call gets a new one', async () => {
    const { pool, workers } = makePool();
    const call = pool.run(REQUEST, 'v1');
    workers[0]?.fail('boom');
    await expect(call).rejects.toThrow('returns worker failed: boom');
    ignore(pool.run(REQUEST, 'v1'));
    expect(workers).toHaveLength(2);
  });

  test('a worker over its heap cap is replaced, and its calls fail', async () => {
    const { pool, workers } = makePool();
    const call = pool.run(REQUEST, 'v1');
    workers[0]?.reply({ kind: 'heap-cap', heapMb: 512 });
    await expect(call).rejects.toThrow('returns worker over its heap cap');
    expect(workers[0]?.terminated).toBe(true);
    ignore(pool.run(REQUEST, 'v1'));
    expect(workers).toHaveLength(2);
  });

  test('a calculation that fails in the worker fails only that call', async () => {
    const { pool, workers } = makePool();
    const bad = pool.run(REQUEST, 'v1');
    const good = pool.run(REQUEST, 'v1');
    const [first, second] = workers[0]?.posted ?? [];
    workers[0]?.reply({ id: first?.id, ok: false, error: 'no rows' });
    workers[0]?.reply({ id: second?.id, ok: true, outcome: { status: 'ok' } });
    await expect(bad).rejects.toThrow('no rows');
    expect(await good).toEqual({ status: 'ok' } as never);
    expect(workers[0]?.terminated).toBe(false);
  });

  test('the data key travels with the request, so the worker shares loads per version', () => {
    const { pool, workers } = makePool();
    ignore(pool.run(REQUEST, 'u:2026-10-10:v7'));
    expect(workers[0]?.posted[0]?.dataKey).toBe('u:2026-10-10:v7');
  });
});

describe('the real worker thread (SC-1671)', () => {
  test('it boots the domain and answers a calculation', async () => {
    const pool = new ReturnsWorkerPool({ maxPending: 8, timeoutMs: 30_000 });
    try {
      const outcome = await pool.run(
        {
          userId: '00000000-0000-4000-8000-0000000000ff',
          scope: { kind: 'user' },
          window: { kind: 'all' },
        },
        'nobody:v1'
      );
      expect(outcome).toEqual({ status: 'no-base-currency' });
    } finally {
      pool.close();
    }
  }, 60_000);

  test('it stops itself over its heap cap, and the pool says why', async () => {
    const pool = new ReturnsWorkerPool({ maxPending: 8, timeoutMs: 30_000, heapCapMb: 1 });
    try {
      await expect(
        pool.run(
          {
            userId: '00000000-0000-4000-8000-0000000000ff',
            scope: { kind: 'user' },
            window: { kind: 'all' },
          },
          'nobody:v1'
        )
      ).rejects.toThrow('returns worker over its heap cap');
      expect(pool.stats().workerHeapMb).toBeGreaterThan(1);
    } finally {
      pool.close();
    }
  }, 60_000);
});
