import { describe, expect, test } from 'bun:test';
import { Semaphore } from '../../src/consumer/semaphore';

describe('Semaphore', () => {
  test('grants slots immediately while under capacity', async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(sem.stats()).toEqual({ inFlight: 2, capacity: 2, queued: 0 });
    r1();
    r2();
    expect(sem.stats()).toEqual({ inFlight: 0, capacity: 2, queued: 0 });
  });

  test('queues acquires past capacity and releases them on free', async () => {
    const sem = new Semaphore(1);
    const r1 = await sem.acquire();
    let r2: (() => void) | undefined;
    const second = sem.acquire().then((release) => {
      r2 = release;
    });
    // r2 should be pending until r1 releases.
    await Promise.resolve();
    expect(sem.stats().queued).toBe(1);
    expect(r2).toBeUndefined();
    r1();
    await second;
    expect(r2).toBeDefined();
    expect(sem.stats()).toEqual({ inFlight: 1, capacity: 1, queued: 0 });
    r2?.();
  });

  test('FIFO ordering — first waiter resumes first', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const r1 = await sem.acquire();
    const w1 = sem.acquire().then((release) => {
      order.push(1);
      release();
    });
    const w2 = sem.acquire().then((release) => {
      order.push(2);
      release();
    });
    r1();
    await Promise.all([w1, w2]);
    expect(order).toEqual([1, 2]);
  });

  test('rejects invalid capacity', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(Number.NaN)).toThrow();
  });
});
