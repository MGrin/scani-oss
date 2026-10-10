import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { IncomeService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

/**
 * `portfolio.getIncome` (SC-1644): Returns' own input, the user's own scope,
 * and `null` where there is no base currency to value income in.
 */

restoreContainerAfterAll();

const USER = {
  id: '00000000-0000-4000-8000-00000000001c',
  email: 'income@scani.local',
} as typeof schema.users.$inferSelect;

const SUMMARY = {
  baseCurrencyId: 'eur',
  window: { from: new Date('2026-01-01T00:00:00.000Z'), to: new Date('2026-09-30T23:59:59.999Z') },
  months: [{ month: '2026-03', groups: { dividend: { gross: '9', withheld: '1', net: '8' } } }],
  totals: { dividend: { gross: '9', withheld: '1', net: '8' } },
  dividendsBySecurity: [],
  unpricedCount: 0,
  unmatchedWithholdingCount: 0,
};

function stub(outcome: unknown) {
  const asked: unknown[] = [];
  Container.set(IncomeService, {
    compute: async (request: unknown) => {
      asked.push(request);
      return outcome;
    },
  } as unknown as IncomeService);
  return asked;
}

describe('portfolio.getIncome (SC-1644)', () => {
  test('returns the service summary for the user scope', async () => {
    const asked = stub({ status: 'ok', income: SUMMARY });
    const result = await makeAuthedCaller(USER).portfolio.getIncome({ window: { kind: '1y' } });
    expect(result).toEqual({ income: SUMMARY });
    expect(asked).toEqual([{ userId: USER.id, scope: { kind: 'user' }, window: { kind: '1y' } }]);
  });

  test("refuses another user's account scope", async () => {
    const asked = stub({ status: 'ok', income: SUMMARY });
    await expect(
      makeAuthedCaller(USER).portfolio.getIncome({
        window: { kind: 'ytd' },
        scope: { kind: 'account', id: '00000000-0000-4000-8000-0000000000ff' },
      })
    ).rejects.toThrow(/not found/i);
    expect(asked).toEqual([]);
  });

  test('null when the user has no base currency', async () => {
    stub({ status: 'no-base-currency' });
    expect(await makeAuthedCaller(USER).portfolio.getIncome({ window: { kind: 'all' } })).toEqual({
      income: null,
    });
  });
});
