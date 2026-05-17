import { describe, expect, test } from 'bun:test';
import type { User } from '@scani/db/schema';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingQueryService } from '../../../src/services/holdings/HoldingQueryService';

// getHiddenHoldings powers the Tokens page "Hidden holdings" section. It
// must surface every holding kept off the dashboard — user-hidden OR
// scam-flagged — and label why, so the UI can offer the right un-hide
// action.

interface FakeRow {
  isHidden: boolean;
  scam: number;
}

function makeService(rows: FakeRow[]): HoldingQueryService {
  const fullDetails = rows.map((r, i) => ({
    holding: {
      id: `holding-${i}`,
      balance: '10',
      source: 'blockchain',
      isHidden: r.isHidden,
    },
    token: {
      id: `token-${i}`,
      symbol: `TOK${i}`,
      name: `Token ${i}`,
      iconUrl: null,
      isScamProbability: r.scam,
    },
    account: { id: `account-${i}`, name: 'Wallet' },
    institution: { id: `inst-${i}`, name: 'Ethereum' },
  }));

  Container.set(HoldingRepository, {
    findByUserWithFullDetails: async () => fullDetails,
  } as unknown as HoldingRepository);

  const instance = new HoldingQueryService();
  Container.set(HoldingQueryService, instance);
  return instance;
}

const user = { id: 'user-1' } as User;

describe('HoldingQueryService.getHiddenHoldings', () => {
  test('omits holdings that are visible on the dashboard', async () => {
    const service = makeService([{ isHidden: false, scam: 0 }]);
    const result = await service.getHiddenHoldings(user);
    expect(result).toEqual([]);
  });

  test('labels a user-hidden holding as user_hidden', async () => {
    const service = makeService([{ isHidden: true, scam: 0 }]);
    const result = await service.getHiddenHoldings(user);
    expect(result.map((r) => r.hiddenReason)).toEqual(['user_hidden']);
  });

  test('labels a scam-flagged holding as scam', async () => {
    const service = makeService([{ isHidden: false, scam: 0.9 }]);
    const result = await service.getHiddenHoldings(user);
    expect(result.map((r) => r.hiddenReason)).toEqual(['scam']);
  });

  test('labels a holding hidden by both mechanisms as both', async () => {
    const service = makeService([{ isHidden: true, scam: 0.9 }]);
    const result = await service.getHiddenHoldings(user);
    expect(result.map((r) => r.hiddenReason)).toEqual(['both']);
  });

  test('returns only the hidden subset from a mixed set', async () => {
    const service = makeService([
      { isHidden: false, scam: 0 },
      { isHidden: true, scam: 0 },
      { isHidden: false, scam: 0.5 },
    ]);
    const result = await service.getHiddenHoldings(user);
    expect(result.length).toBe(2);
  });
});
