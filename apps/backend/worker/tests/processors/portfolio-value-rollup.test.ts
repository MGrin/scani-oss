import { describe, expect, test } from 'bun:test';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { RollupPortfolioValueDailyUseCase, type RollupSummary } from '@scani/domain/use-cases';
import { type RealTimeEvent, RedisRealtimeUpdatesService } from '@scani/realtime';
import { Container } from 'typedi';
import { PortfolioValueRollupProcessor } from '../../src/processors/portfolio-value-rollup';

/**
 * The 04:00 rollup rewrote every user's chart and told no open app, so the
 * chart showed yesterday's history until a reload (SC-1600, from the SC-1598
 * liveness audit).
 */

restoreContainerAfterAll();

function runWith(rolledUpUserIds: string[]) {
  const events: Array<Omit<RealTimeEvent, 'timestamp'>> = [];
  Container.set(RedisRealtimeUpdatesService, {
    broadcast: (event: Omit<RealTimeEvent, 'timestamp'>) => {
      events.push(event);
    },
  } as unknown as RedisRealtimeUpdatesService);
  const summary: RollupSummary = {
    usersProcessed: rolledUpUserIds.length + 1,
    daysComputed: rolledUpUserIds.length * 30,
    usersSkipped: 0,
    errors: [],
    durationMs: 1,
    rolledUpUserIds,
  };
  Container.set(RollupPortfolioValueDailyUseCase, {
    execute: async () => summary,
  } as unknown as RollupPortfolioValueDailyUseCase);
  const processor = new PortfolioValueRollupProcessor();
  return { events, run: () => (processor as unknown as { handle: () => Promise<void> }).handle() };
}

describe('PortfolioValueRollupProcessor (SC-1600)', () => {
  test('each user whose chart the rollup wrote gets one portfolio event', async () => {
    const { events, run } = runWith(['user-a', 'user-b']);
    await run();
    expect(
      events.map(({ entityType, operationType, userId }) => ({ entityType, operationType, userId }))
    ).toEqual([
      { entityType: 'portfolio', operationType: 'sync', userId: 'user-a' },
      { entityType: 'portfolio', operationType: 'sync', userId: 'user-b' },
    ]);
  });

  test('control: a run that wrote nobody tells nobody', async () => {
    const { events, run } = runWith([]);
    await run();
    expect(events).toEqual([]);
  });
});
