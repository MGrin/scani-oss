import { beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PortfolioValueCache } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { PORTFOLIO_HISTORY_LOOKBACK_DAYS } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { Container } from 'typedi';
import { enqueuePortfolioRollup } from '../../../src/presentation/lib/portfolio-rollup';

// Ten routers call this as `void enqueuePortfolioRollup(...)`, so anything it
// throws is an unhandled rejection that lands on whatever runs next. SC-1396
// added a history query ahead of the enqueue and outside its try; a failure
// there escaped, and Bun charged it to an unrelated test on CI.

restoreContainerAfterAll();

const added: Array<{ lookbackDays: number }> = [];

beforeEach(() => {
  added.length = 0;
  Container.set(PortfolioValueCache, { bust: async () => {} } as unknown as PortfolioValueCache);
  Container.set(BullMqEnqueueService, {
    add: async (_descriptor: unknown, data: { lookbackDays: number }) => {
      added.push(data);
      return 'job';
    },
  } as unknown as BullMqEnqueueService);
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
});
