process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { Holding } from '@scani/db/schema';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { Container } from 'typedi';
import { HoldingService } from '../../../src/services/holdings/HoldingService';
import { HoldingsSyncHelper } from '../../../src/services/holdings/HoldingsSyncHelper';
import { TokenService } from '../../../src/services/tokens/TokenService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

const USD_TOKEN_ID = 'usd-token';

interface Calls {
  updates: Array<{ holdingId: string; balance: string }>;
  creates: Array<{ tokenId: string; balance: string; source: string; arrival?: string }>;
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
    createHoldingWithEvent: async (input: {
      tokenId: string;
      balance: string;
      source: string;
      arrival: string;
    }) => {
      calls.creates.push({
        tokenId: input.tokenId,
        balance: input.balance,
        source: input.source,
        arrival: input.arrival,
      });
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
  respectHiddenForCounts: false,
  skipUnchangedUpdates: true,
  updateOnly: false,
  arrival: 'auto_discovered' as const,
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
      arrival: 'auto_discovered',
    });
  });
});

// SC-356, the sync half. The transfer-review queue opens a holding it has to
// create on a SYNC-OWNED account as that sync's own row, at zero. These pin
// what makes that worth doing: the row is found, so it is corrected instead of
// duplicated. A row at `source = 'manual'` is neither, which is exactly right
// for a balance a person curated and exactly why the queue must not use it for
// an account it does not maintain by hand.
describe('HoldingsSyncHelper — a row the review queue opened for it', () => {
  test('adopts a review-created row at zero rather than creating a second one', async () => {
    const { helper, calls } = setup();

    const reviewCreated = usdHolding({
      id: 'review-id',
      source: 'sync_exchange_balances',
      externalId: null,
      balance: '0',
      arrival: 'user_confirmed',
    } as Partial<Holding>);

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [usdSnapshot('1186.19')],
      existingHoldings: [reviewCreated],
    });

    expect(calls.creates).toEqual([]);
    expect(calls.updates).toEqual([{ holdingId: 'review-id', balance: '1186.19' }]);
  });

  test('the same row at source manual is invisible — the split shape SC-356 removes', async () => {
    const { helper, calls } = setup();

    const asManual = usdHolding({
      id: 'review-id',
      source: 'manual',
      externalId: null,
      balance: '0',
      arrival: 'user_confirmed',
    } as Partial<Holding>);

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [usdSnapshot('1186.19')],
      existingHoldings: [asManual],
    });

    // Two holdings for one (account, token) — where per-holding tx dedup lets
    // one upstream event be ingested onto both.
    expect(calls.updates).toEqual([]);
    expect(calls.creates).toHaveLength(1);
  });
});

describe('HoldingsSyncHelper — arrival provenance', () => {
  // The helper is the single create path for both the wallet-import review
  // (a human kept this row) and the hourly balance sync (nobody was asked).
  // Before SC-277 both produced `source = 'blockchain'` and were
  // indistinguishable afterwards, so it has to carry the caller's answer
  // rather than infer one.
  test('stamps the caller-supplied arrival onto a created holding', async () => {
    const { helper, calls } = setup();

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      arrival: 'user_confirmed',
      snapshots: [usdSnapshot('42')],
      existingHoldings: [],
    });

    expect(calls.creates.map((c) => c.arrival)).toEqual(['user_confirmed']);
  });

  test('stamps auto_discovered when the sync created the row on its own', async () => {
    const { helper, calls } = setup();

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      arrival: 'auto_discovered',
      snapshots: [usdSnapshot('42')],
      existingHoldings: [],
    });

    expect(calls.creates.map((c) => c.arrival)).toEqual(['auto_discovered']);
  });
});

describe('HoldingsSyncHelper — negative balances never reach the write path', () => {
  // holdings.balance carries a `>= 0` check constraint. A negative snapshot
  // (e.g. an IBKR short position or margin-debt cash) must be skipped here
  // rather than attempt a write that aborts the whole shared sync
  // transaction for every other user in the same run.
  test('skips a negative snapshot instead of creating a holding', async () => {
    const { helper, calls } = setup();

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [usdSnapshot('-42.5')],
      existingHoldings: [],
    });

    expect(calls.creates).toEqual([]);
    expect(calls.updates).toEqual([]);
  });

  test('skips a negative snapshot instead of updating an existing holding', async () => {
    const { helper, calls } = setup();

    const auto = usdHolding({
      id: 'auto-id',
      source: 'import_ibkr',
      externalId: 'USD',
      balance: '585.44',
    });

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [usdSnapshot('-1200.75')],
      existingHoldings: [auto],
    });

    // The negative snapshot is dropped, so `auto` is never written a
    // negative value. Because its token is now unseen, the stale-zeroing
    // pass zeroes it — a valid, constraint-respecting terminal state.
    expect(calls.updates).toEqual([{ holdingId: 'auto-id', balance: '0' }]);
    expect(calls.creates).toEqual([]);
  });
});

// SC-236. A credential row whose decrypted payload has no apiKey/apiSecret
// makes `resolveApiCreds` return null, and every HMAC provider turns that
// into `return []` — the same value a genuinely-empty account produces.
// Under `staleStrategy: 'zero'` the second reading wiped the account, hourly.
describe('HoldingsSyncHelper — an empty snapshot never zeroes anything', () => {
  test('refuses to zero holdings when the provider returned nothing at all', async () => {
    const { helper, calls } = setup();

    const held = usdHolding({
      id: 'held-id',
      source: 'import_binance',
      externalId: 'USD',
      balance: '12345.67',
    });

    const result = await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [],
      existingHoldings: [held],
    });

    expect(calls.updates).toEqual([]);
    expect(result.removed).toBe(0);
  });

  // A snapshot with rows in it is evidence the provider looked, so a holding
  // missing from one is a real disposal and must still zero. This is also
  // the honest limit of the guard: a PARTIAL snapshot still zeroes what it
  // omits, and that looks like the user sold something. Tracked separately.
  test('still zeroes a holding the provider did not return, when it returned something', async () => {
    const { helper, calls } = setup();

    const sold = usdHolding({
      id: 'sold-id',
      tokenId: 'other-token',
      source: 'import_binance',
      externalId: 'OTHER',
      balance: '999',
    });

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [usdSnapshot('50')],
      existingHoldings: [sold],
    });

    expect(calls.updates).toContainEqual({ holdingId: 'sold-id', balance: '0' });
  });

  test('an empty snapshot with nothing held is not an event', async () => {
    const { helper, calls } = setup();

    const result = await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [],
      existingHoldings: [],
    });

    expect(calls.updates).toEqual([]);
    expect(result.removed).toBe(0);
  });
});
