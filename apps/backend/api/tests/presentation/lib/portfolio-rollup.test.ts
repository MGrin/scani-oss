import { beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PortfolioValueDailyRepository } from '@scani/domain/repositories';
import { PortfolioValueCache } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { type PORTFOLIO_HISTORY_BACKFILL, PORTFOLIO_HISTORY_LOOKBACK_DAYS } from '@scani/jobs';
import { BullMqEnqueueService, QueueClient } from '@scani/queue';
import { Container } from 'typedi';
import {
  alsoFromFloor,
  enqueuePortfolioRollup,
} from '../../../src/presentation/lib/portfolio-rollup';

// Ten routers call this as `void enqueuePortfolioRollup(...)`, so anything it
// throws is an unhandled rejection that lands on whatever runs next. SC-1396
// added a history query ahead of the enqueue and outside its try; a failure
// there escaped, and Bun charged it to an unrelated test on CI.

restoreContainerAfterAll();

const added: Array<{ lookbackDays: number; fromDay?: string }> = [];

beforeEach(() => {
  added.length = 0;
  Container.set(PortfolioValueCache, { bust: async () => {} } as unknown as PortfolioValueCache);
  Container.set(BullMqEnqueueService, {
    add: async (_descriptor: unknown, data: { lookbackDays: number; fromDay?: string }) => {
      added.push(data);
      return 'job';
    },
  } as unknown as BullMqEnqueueService);
  Container.set(QueueClient, {
    get: () => ({ getJobState: async () => 'unknown', getJob: async () => undefined }),
  } as unknown as QueueClient);
});

describe('enqueuePortfolioRollup', () => {
  test('a user with no history is enqueued with the default lookback — the control', async () => {
    await enqueuePortfolioRollup(randomUUID());
    expect(added).toEqual([
      expect.objectContaining({ lookbackDays: PORTFOLIO_HISTORY_LOOKBACK_DAYS }),
    ]);
  });

  test('a failed history query resolves instead of rejecting', async () => {
    await expect(enqueuePortfolioRollup('not-a-uuid')).resolves.toBeUndefined();
  });

  // The window is the repository's answer, the same one the history recompute
  // script reads (SC-1546), so the two cannot come to different windows.
  test('a user with history older than the default is enqueued with the lookback the repository answers', async () => {
    const userId = randomUUID();
    const wholeHistory = PORTFOLIO_HISTORY_LOOKBACK_DAYS + 331;
    const asked: unknown[][] = [];
    const repository = Container.get(PortfolioValueDailyRepository);
    Container.set(PortfolioValueDailyRepository, {
      findHistoryLookbackDays: async (...args: unknown[]) => {
        asked.push(args);
        return wholeHistory;
      },
    } as unknown as PortfolioValueDailyRepository);
    try {
      await enqueuePortfolioRollup(userId);
    } finally {
      Container.set(PortfolioValueDailyRepository, repository);
    }

    expect(added).toEqual([expect.objectContaining({ userId, lookbackDays: wholeHistory })]);
    expect(asked).toEqual([[userId, PORTFOLIO_HISTORY_LOOKBACK_DAYS]]);
  });
});

// SC-1607: an edit rebuilt the whole history because the enqueue could not say
// where the edit's effect starts.
describe('enqueuePortfolioRollup with a start day (SC-1607)', () => {
  test('a start read before the mutation is carried as is', async () => {
    await enqueuePortfolioRollup(randomUUID(), '2026-09-14');
    expect(added[0]?.fromDay).toBe('2026-09-14');
  });

  test('a start read after the mutation is carried', async () => {
    await enqueuePortfolioRollup(randomUUID(), async () => '2026-08-01');
    expect(added[0]?.fromDay).toBe('2026-08-01');
  });

  test('a start that cannot be read rebuilds the whole window', async () => {
    await enqueuePortfolioRollup(randomUUID(), async () => {
      throw new Error('read failed');
    });
    expect(added).toHaveLength(1);
    expect(added[0]?.fromDay).toBeUndefined();
  });

  test('control: no start rebuilds the whole window, as before', async () => {
    await enqueuePortfolioRollup(randomUUID());
    expect(added[0]?.fromDay).toBeUndefined();
  });
});

// The SC-1592 hole on the edit path: an add onto a RUNNING job with the same id
// is dropped by `add_job`'s ON CONFLICT, and that run's snapshot may predate
// the edit. Two edits in one 30s bucket also share an id, so the second one's
// earlier start was lost behind the first (SC-1607).
describe('an edit never lands on a running rebuild (SC-1607)', () => {
  type Row = { data: { requestId: string; fromDay?: string }; state: 'delayed' | 'active' };

  function queueOf(rows: Map<string, Row>) {
    Container.set(BullMqEnqueueService, {
      add: async (descriptor: typeof PORTFOLIO_HISTORY_BACKFILL, data: Row['data']) => {
        const id = descriptor.computeJobId(data as never);
        if (!rows.has(id)) rows.set(id, { data, state: 'delayed' });
        return id;
      },
    } as unknown as BullMqEnqueueService);
    Container.set(QueueClient, {
      get: () => ({
        getJobState: async (id: string) => rows.get(id)?.state ?? 'unknown',
        getJob: async (id: string) => {
          const row = rows.get(id);
          return row
            ? {
                data: row.data,
                updateData: async (data: Row['data']) => {
                  row.data = data;
                },
              }
            : undefined;
        },
      }),
    } as unknown as QueueClient);
    return () => [...rows.values()].filter((r) => r.state === 'delayed');
  }

  test('an edit while its rebuild is running queues one to run after it', async () => {
    const rows = new Map<string, Row>();
    const pending = queueOf(rows);
    const userId = randomUUID();
    await enqueuePortfolioRollup(userId, '2026-09-20');
    const [first] = rows.values();
    first!.state = 'active';

    await enqueuePortfolioRollup(userId, '2026-09-25');
    expect(pending()).toHaveLength(1);
    expect(pending()[0]!.data.requestId).not.toBe(first!.data.requestId);
  });

  test('a second edit in the same window moves the pending rebuild to the earlier start', async () => {
    const rows = new Map<string, Row>();
    const pending = queueOf(rows);
    const userId = randomUUID();
    await enqueuePortfolioRollup(userId, '2026-09-25');
    await enqueuePortfolioRollup(userId, '2026-09-02');
    expect(pending()).toHaveLength(1);
    expect(pending()[0]!.data.fromDay).toBe('2026-09-02');
  });

  test('control: two edits in one window still make one pending rebuild', async () => {
    const rows = new Map<string, Row>();
    const pending = queueOf(rows);
    const userId = randomUUID();
    await enqueuePortfolioRollup(userId, '2026-09-02');
    await enqueuePortfolioRollup(userId, '2026-09-25');
    expect(pending()).toHaveLength(1);
    expect(pending()[0]!.data.fromDay).toBe('2026-09-02');
  });
});

// Feeds (#22804): a floor below zero read BEFORE the write wins over the start
// read after it, because the write can lift the floor to 0.
describe('a floor read before the write (SC-1607)', () => {
  test('a holding below zero before the edit starts the rebuild at its first record', async () => {
    await enqueuePortfolioRollup(
      randomUUID(),
      alsoFromFloor('2025-01-01', async () => '2025-06-01')
    );
    expect(added[0]?.fromDay).toBe('2025-01-01');
  });

  test('a floor that could not be read rebuilds the whole window', async () => {
    await enqueuePortfolioRollup(
      randomUUID(),
      alsoFromFloor(undefined, async () => '2025-06-01')
    );
    expect(added[0]?.fromDay).toBeUndefined();
  });

  test('control: no holding below zero leaves the start read after the write', async () => {
    await enqueuePortfolioRollup(
      randomUUID(),
      alsoFromFloor(null, async () => '2025-06-01')
    );
    expect(added[0]?.fromDay).toBe('2025-06-01');
  });
});
