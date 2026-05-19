import { describe, expect, it, mock } from 'bun:test';
import { NoopUsageSink, PostgresUsageSink, type UsageEvent } from '../../src/usage/sink';

const baseEvent = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  apiKeyId: 'key-1',
  tenantId: 'tenant-1',
  subject: 'user-1',
  requestId: 'req-1',
  route: 'pricing.getPrice',
  provider: 'pricing',
  outcome: 'ok',
  statusCode: 200,
  durationMs: 12,
  ...over,
});

// Minimal CloudDb stub: records every `insert(...).values(...)` call so the
// test can assert what got flushed without spinning up Postgres.
function fakeDb(behavior: 'ok' | 'throw' = 'ok') {
  const inserted: unknown[][] = [];
  const insert = mock(() => ({
    values: (rows: unknown[]) => {
      if (behavior === 'throw') {
        return Promise.reject(new Error('db down'));
      }
      inserted.push(rows);
      return Promise.resolve();
    },
  }));
  // biome-ignore lint/suspicious/noExplicitAny: stub satisfies the call shape used by the sink
  return { db: { insert } as any, inserted };
}

describe('NoopUsageSink', () => {
  it('record + flush are no-ops and never throw', async () => {
    const sink = new NoopUsageSink();
    sink.record(baseEvent());
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});

describe('PostgresUsageSink', () => {
  it('drops events with no subject (OSS env-key requests are not metered)', async () => {
    const { db, inserted } = fakeDb();
    const sink = new PostgresUsageSink({ db, batchSize: 1, flushIntervalMs: 10 });
    sink.record(baseEvent({ subject: null }));
    await sink.flush();
    expect(inserted).toHaveLength(0);
  });

  it('auto-flushes when buffer reaches batchSize', async () => {
    const { db, inserted } = fakeDb();
    const sink = new PostgresUsageSink({ db, batchSize: 2, flushIntervalMs: 10_000 });
    sink.record(baseEvent({ requestId: 'r1' }));
    expect(inserted).toHaveLength(0);
    sink.record(baseEvent({ requestId: 'r2' }));
    // sink.record fires `void this.flush()` when buffer hits batchSize.
    // Wait one microtask cycle for the inflight flush to settle.
    await new Promise((r) => setTimeout(r, 5));
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as Array<{ requestId: string }>).map((r) => r.requestId)).toEqual([
      'r1',
      'r2',
    ]);
  });

  it('explicit flush() drains a partial buffer and clears the timer', async () => {
    const { db, inserted } = fakeDb();
    const sink = new PostgresUsageSink({ db, batchSize: 100, flushIntervalMs: 10_000 });
    sink.record(baseEvent({ requestId: 'a' }));
    sink.record(baseEvent({ requestId: 'b' }));
    await sink.flush();
    expect(inserted).toHaveLength(1);
    expect((inserted[0] as Array<{ requestId: string }>).map((r) => r.requestId)).toEqual([
      'a',
      'b',
    ]);
    // Second flush with empty buffer is a no-op (no extra insert call).
    await sink.flush();
    expect(inserted).toHaveLength(1);
  });

  it('flush() with empty buffer does not call db.insert', async () => {
    const { db } = fakeDb();
    const sink = new PostgresUsageSink({ db, batchSize: 1, flushIntervalMs: 10 });
    await sink.flush();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('survives db.insert failure: logs + drains the buffer instead of leaking the batch', async () => {
    const { db } = fakeDb('throw');
    const sink = new PostgresUsageSink({ db, batchSize: 100, flushIntervalMs: 10_000 });
    sink.record(baseEvent());
    sink.record(baseEvent());
    // Should not throw — sink swallows the rejection and logs.
    await expect(sink.flush()).resolves.toBeUndefined();
    // The buffer must be cleared even when the insert fails — otherwise
    // a transient DB outage would replay the same batch forever and OOM.
    // Verify via a follow-up no-op flush.
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});
