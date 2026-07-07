process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import type { Holding } from '@scani/db/schema';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { Container } from 'typedi';
import { HoldingService } from '../../../src/services/holdings/HoldingService';
import { HoldingsSyncHelper } from '../../../src/services/holdings/HoldingsSyncHelper';
import { TokenService } from '../../../src/services/tokens/TokenService';

// typedi's Container is process-global — restore real @Service() instances
// after this suite so stubs don't leak into other test files.
afterAll(() => {
  Container.set(TokenService, new TokenService());
  Container.set(HoldingService, new HoldingService());
  Container.set(HoldingsSyncHelper, new HoldingsSyncHelper());
});

const USD_TOKEN_ID = 'usd-token';

interface Calls {
  updates: Array<{ holdingId: string; balance: string }>;
  creates: Array<{ tokenId: string; balance: string; source: string }>;
}

function setup(): { helper: HoldingsSyncHelper; calls: Calls } {
  const calls: Calls = { updates: [], creates: [] };

  Container.set(TokenService, {
    // The sync only reads `token.id` off the result.
    findOrCreateTokenFromIntegration: async () => ({ token: { id: USD_TOKEN_ID } }),
  } as unknown as TokenService);

  Container.set(HoldingService, {
    updateHoldingBalanceWithEvent: async (input: { holdingId: string; balance: string }) => {
      calls.updates.push({ holdingId: input.holdingId, balance: input.balance });
    },
    createHoldingWithEvent: async (input: { tokenId: string; balance: string; source: string }) => {
      calls.creates.push({ tokenId: input.tokenId, balance: input.balance, source: input.source });
    },
  } as unknown as HoldingService);

  const helper = new HoldingsSyncHelper();
  Container.set(HoldingsSyncHelper, helper);
  return { helper, calls };
}

function usdHolding(overrides: Partial<Holding>): Holding {
  return {
    id: 'holding-id',
    userId: 'user-1',
    accountId: 'acct-1',
    tokenId: USD_TOKEN_ID,
    balance: '0',
    source: 'manual',
    externalId: null,
    isHidden: false,
    isActive: true,
    lastUpdated: new Date(),
    createdAt: new Date(),
    ...overrides,
  } as Holding;
}

function usdSnapshot(balance: string): HoldingSnapshot {
  return {
    externalId: 'USD',
    balance,
    capturedAt: new Date(),
    tokenType: 'fiat',
    tokenIdentity: { symbol: 'USD', name: 'United States Dollar' },
  } as HoldingSnapshot;
}

const BASE_INPUT = {
  account: { id: 'acct-1', userId: 'user-1' },
  userId: 'user-1',
  userBaseCurrencyId: null,
  cryptoTokenTypeId: 'crypto-type',
  tokenTypeMap: { fiat: 'fiat-type', crypto: 'crypto-type' },
  staleStrategy: 'zero' as const,
  dedupStrategy: 'tokenId' as const,
  sourceTag: 'sync_exchange_balances',
  defaultDecimals: 8,
  respectHiddenForCounts: false,
  skipUnchangedUpdates: true,
  updateOnly: false,
  tx: undefined as never,
};

describe('HoldingsSyncHelper — manual holdings are off-limits to exchange sync', () => {
  test('updates its own synced holding, never the manual one, when both share a token', async () => {
    const { helper, calls } = setup();

    // Manual row is listed LAST so the buggy token-id map keeps it and
    // the sync would otherwise overwrite it.
    const auto = usdHolding({
      id: 'auto-id',
      source: 'import_airwallex',
      externalId: 'USD',
      balance: '585.44',
    });
    const manual = usdHolding({
      id: 'manual-id',
      source: 'manual',
      externalId: null,
      balance: '500',
    });

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [usdSnapshot('1186.19')],
      existingHoldings: [auto, manual],
    });

    expect(calls.updates.map((u) => u.holdingId)).not.toContain('manual-id');
    expect(calls.updates).toContainEqual({ holdingId: 'auto-id', balance: '1186.19' });
  });

  test('creates its own holding instead of overwriting a manual-only holding', async () => {
    const { helper, calls } = setup();

    const manual = usdHolding({
      id: 'manual-id',
      source: 'manual',
      externalId: null,
      balance: '3000.69',
    });

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [usdSnapshot('1186.19')],
      existingHoldings: [manual],
    });

    expect(calls.updates.map((u) => u.holdingId)).not.toContain('manual-id');
    expect(calls.creates).toContainEqual({
      tokenId: USD_TOKEN_ID,
      balance: '1186.19',
      source: 'sync_exchange_balances',
    });
  });
});
