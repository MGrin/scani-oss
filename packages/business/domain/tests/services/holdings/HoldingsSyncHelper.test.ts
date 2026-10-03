process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { Holding } from '@scani/db/schema';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
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

function shortSnapshot(balance: string): HoldingSnapshot {
  return {
    externalId: 'TSLA',
    balance,
    capturedAt: new Date(),
    tokenType: 'stock',
    tokenIdentity: { symbol: 'TSLA', name: 'Tesla' },
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

describe('HoldingsSyncHelper — only broker cash may go negative (SC-1462)', () => {
  // Margin debt is a negative cash balance that subtracts from net worth, as
  // the broker shows it (mgrin, 2026-09-30). A negative position in anything
  // else (a short) has no representation here and is still skipped rather than
  // written.
  test('writes a negative cash snapshot as a negative holding', async () => {
    const { helper, calls } = setup();

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [usdSnapshot('-42.5')],
      existingHoldings: [],
    });

    expect(calls.creates.map((c) => c.balance)).toEqual(['-42.5']);
    expect(calls.updates).toEqual([]);
  });

  test('moves an existing cash holding below zero', async () => {
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

    expect(calls.updates).toEqual([{ holdingId: 'auto-id', balance: '-1200.75' }]);
    expect(calls.creates).toEqual([]);
  });

  // The control: a short position is not cash, and stays out.
  test('skips a negative non-cash snapshot', async () => {
    const { helper, calls } = setup();

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [shortSnapshot('-5')],
      existingHoldings: [],
    });

    expect(calls.creates).toEqual([]);
    expect(calls.updates).toEqual([]);
  });

  test('skips a negative crypto snapshot', async () => {
    const { helper, calls } = setup();

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [
        {
          externalId: 'ETH',
          balance: '-0.5',
          capturedAt: new Date(),
          tokenType: 'crypto',
          tokenIdentity: { symbol: 'ETH', name: 'Ether' },
        } as HoldingSnapshot,
      ],
      existingHoldings: [],
    });

    expect(calls.creates).toEqual([]);
    expect(calls.updates).toEqual([]);
  });

  test('a negative non-cash snapshot never updates an existing holding', async () => {
    const { helper, calls } = setup();

    const auto = usdHolding({
      id: 'auto-id',
      source: 'import_ibkr',
      externalId: 'USD',
      balance: '585.44',
    });

    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      snapshots: [shortSnapshot('-1200.75')],
      existingHoldings: [auto],
    });

    // Dropped, so `auto` is never written a negative value. Its token is now
    // unseen, so the stale-zeroing pass zeroes it.
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

// SC-1427: a reporting interface's balance is true as of its own date, not
// when we fetched it. IBKR's Flex positions are a close 1-2 business days
// earlier; stamped at fetch time, a trade in between sat before an
// observation that did not include it and read as unexplained drift.
describe('HoldingsSyncHelper — the observation is stamped at the source as-of', () => {
  test('passes each snapshot capturedAt to the update and the create', async () => {
    const seen: Array<{ kind: string; observedAt?: Date }> = [];
    Container.set(TokenService, {
      // The resolver receives a token mapping; USD is the one naming 'USD'.
      findOrCreateTokenFromIntegration: async (mapping: unknown) => ({
        token: { id: JSON.stringify(mapping).includes('"USD"') ? USD_TOKEN_ID : 'eur-token' },
      }),
    } as unknown as TokenService);
    Container.set(HoldingService, {
      updateHoldingBalanceWithEvent: async (input: { observedAt?: Date }) => {
        seen.push({ kind: 'update', observedAt: input.observedAt });
      },
      createHoldingWithEvent: async (input: { observedAt?: Date }) => {
        seen.push({ kind: 'create', observedAt: input.observedAt });
      },
    } as unknown as HoldingService);
    const helper = new HoldingsSyncHelper();

    const asOf = new Date('2026-08-14T20:00:00.000Z');
    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      skipUnchangedUpdates: false,
      snapshots: [
        { ...usdSnapshot('10'), capturedAt: asOf },
        {
          ...usdSnapshot('5'),
          externalId: 'EUR',
          tokenIdentity: { symbol: 'EUR', name: 'Euro' },
          capturedAt: asOf,
        } as HoldingSnapshot,
      ],
      existingHoldings: [
        usdHolding({ id: 'usd-id', source: BASE_INPUT.sourceTag, externalId: 'USD' }),
      ],
    });

    expect(seen).toEqual([
      { kind: 'update', observedAt: asOf },
      { kind: 'create', observedAt: asOf },
    ]);
  });
});

// SC-1451. IBKR's CashReport can leave out a currency that is still held, and
// the sync read that absence as a zero: mgrin's USD and CAD both read 0 on
// 2026-07-20 and were back the next day. An absence of a confirmed holding now
// zeroes only after it has been missing from that many distinct statements.
describe('HoldingsSyncHelper — a currency missing from one statement is not a zero', () => {
  const CAD = 'cad-token';
  const day = (iso: string) => new Date(`${iso}T05:00:00Z`);
  const stock: HoldingSnapshot = {
    externalId: 'VOO',
    balance: '2',
    capturedAt: day('2026-07-20'),
    tokenType: 'stock',
    tokenIdentity: { symbol: 'VOO', name: 'VOO' },
  } as HoldingSnapshot;

  function withRepo() {
    const absences: Array<{ holdingId: string; dates: string[] | null }> = [];
    Container.set(HoldingRepository, {
      setAbsentFromStatements: async (holdingId: string, dates: Date[] | null) => {
        absences.push({
          holdingId,
          dates: dates?.map((d) => d.toISOString().slice(0, 10)) ?? null,
        });
      },
    } as unknown as HoldingRepository);
    const { helper, calls } = setup();
    return { helper, calls, absences };
  }

  const cash = (absent: string[] | null) =>
    usdHolding({
      id: 'cad-id',
      tokenId: CAD,
      source: 'import_ibkr',
      externalId: 'CAD',
      balance: '47.87',
      absentFromStatements: absent?.map(day) ?? null,
    } as Partial<Holding>);

  const confirm = { absenceConfirmation: { tokenIds: new Set([CAD]), statements: 3 } };

  test('the first statement that leaves it out records the date and keeps the balance', async () => {
    const { helper, calls, absences } = withRepo();
    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      ...confirm,
      snapshots: [stock],
      existingHoldings: [cash(null)],
    });
    expect(calls.updates).not.toContainEqual({ holdingId: 'cad-id', balance: '0' });
    expect(absences).toEqual([{ holdingId: 'cad-id', dates: ['2026-07-20'] }]);
  });

  test('re-reading the same statement does not count twice', async () => {
    const { helper, calls, absences } = withRepo();
    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      ...confirm,
      snapshots: [stock],
      existingHoldings: [cash(['2026-07-19', '2026-07-20'])],
    });
    expect(calls.updates).toEqual([]);
    expect(absences).toEqual([{ holdingId: 'cad-id', dates: ['2026-07-19', '2026-07-20'] }]);
  });

  test('the third consecutive statement without it lands the zero and clears the count', async () => {
    const { helper, calls, absences } = withRepo();
    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      ...confirm,
      snapshots: [stock],
      existingHoldings: [cash(['2026-07-18', '2026-07-19'])],
    });
    expect(calls.updates).toContainEqual({ holdingId: 'cad-id', balance: '0' });
    expect(absences).toEqual([{ holdingId: 'cad-id', dates: null }]);
  });

  test('reporting it again resets the count', async () => {
    const { absences } = withRepo();
    Container.set(TokenService, {
      findOrCreateTokenFromIntegration: async () => ({ token: { id: CAD } }),
    } as unknown as TokenService);
    const helperWithCad = new HoldingsSyncHelper();
    await helperWithCad.processSnapshotsForAccount({
      ...BASE_INPUT,
      ...confirm,
      snapshots: [
        { ...stock, externalId: 'CAD', balance: '47.87', tokenType: 'fiat' } as HoldingSnapshot,
      ],
      existingHoldings: [cash(['2026-07-20'])],
    });
    expect(absences).toEqual([{ holdingId: 'cad-id', dates: null }]);
  });

  test('a holding outside the confirmed set still zeroes at once', async () => {
    const { helper, calls, absences } = withRepo();
    const gone = usdHolding({
      id: 'sold-id',
      tokenId: 'other-token',
      source: 'import_ibkr',
      balance: '5',
    });
    await helper.processSnapshotsForAccount({
      ...BASE_INPUT,
      ...confirm,
      snapshots: [stock],
      existingHoldings: [gone],
    });
    expect(calls.updates).toContainEqual({ holdingId: 'sold-id', balance: '0' });
    expect(absences).toEqual([]);
  });
});
