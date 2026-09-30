process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../../src/repositories/HoldingBalanceObservationRepository';
import { HoldingService } from '../../../src/services/holdings/HoldingService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

// SC-1427: an observation is stamped when the SOURCE says the balance was
// true. With no as-of it is now; an as-of in the future is a clock error at
// the source, and an observation dated ahead of the present would outrank
// every real one, so it is clamped to now.
describe('HoldingService.recordBalanceObservation — observed_at', () => {
  const HOLDING = { id: 'h1', userId: 'u1', accountId: 'a1', tokenId: 't1', balance: '10' };

  function service(): { svc: HoldingService; appended: Array<{ observedAt: Date }> } {
    const appended: Array<{ observedAt: Date }> = [];
    Container.set(HoldingBalanceObservationRepository, {
      append: async (row: { observedAt: Date }) => {
        appended.push(row);
      },
    } as unknown as HoldingBalanceObservationRepository);
    return { svc: new HoldingService(), appended };
  }

  test('an as-of from the source is the observation time', async () => {
    const { svc, appended } = service();
    const asOf = new Date('2026-08-14T20:00:00.000Z');
    await svc.recordBalanceObservation(HOLDING, undefined, undefined, undefined, undefined, asOf);
    expect(appended[0]?.observedAt).toEqual(asOf);
  });

  test('no as-of: now', async () => {
    const { svc, appended } = service();
    const before = Date.now();
    await svc.recordBalanceObservation(HOLDING);
    const at = appended[0]?.observedAt.getTime() ?? 0;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  test('an as-of in the future is clamped to now', async () => {
    const { svc, appended } = service();
    const before = Date.now();
    await svc.recordBalanceObservation(
      HOLDING,
      undefined,
      undefined,
      undefined,
      undefined,
      new Date(Date.now() + 86_400_000)
    );
    const at = appended[0]?.observedAt.getTime() ?? 0;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });
});
