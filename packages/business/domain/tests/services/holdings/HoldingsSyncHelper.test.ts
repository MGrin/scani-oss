/**
 * The balance syncs' per-account write (`HoldingsSyncHelper`) against Postgres.
 * Nothing is stubbed: every holding, observation and tally asserted here is
 * what the helper wrote. Each case is the exchange sync's unless it says
 * otherwise: zero-stale, matched by token, unchanged balances skipped.
 *
 * Moved onto the database before the helper moves onto `FeedIngestService`
 * (foundation A2 Task 16), so the same assertions hold on both sides; only
 * `sync` below knows the helper's signature.
 *
 * Fixtures are committed rather than rolled back, because the helper's write
 * is a transaction of its own.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingsSyncHelper } from '../../../src/services/holdings/HoldingsSyncHelper';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding } from '../../../test/helpers/factories-extra';

const T0 = new Date('2026-07-01T00:00:00Z');
const TAG = 'sync_exchange_balances';
const UPDATE_ORIGIN = { origin: 'updateHoldingBalanceWithEvent' };

const created = { users: [] as string[], symbols: [] as string[], institutions: [] as string[] };

afterEach(async () => {
  const db = getDb();
  const users = created.users.splice(0);
  const symbols = created.symbols.splice(0);
  const institutions = created.institutions.splice(0);
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (symbols.length) await db.delete(schema.tokens).where(inArray(schema.tokens.symbol, symbols));
  if (institutions.length) {
    await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
  }
});

/** Unique per run, so committed tokens never meet another test's. */
function fresh(prefix: string): string {
  const symbol = `${prefix}${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  created.symbols.push(symbol);
  return symbol;
}

async function typeIds(): Promise<Record<'crypto' | 'fiat' | 'stock', string>> {
  const rows = await getDb().select().from(schema.tokenTypes);
  const idOf = (code: string) => {
    const row = rows.find((r) => r.code === code);
    if (!row) throw new Error(`no token type ${code}; the seed migration has one`);
    return row.id;
  };
  return { crypto: idOf('crypto'), fiat: idOf('fiat'), stock: idOf('stock') };
}

interface Seeded {
  userId: string;
  accountId: string;
}

async function seed(): Promise<Seeded> {
  const seeded = await getDb().transaction(async (tx) => {
    const user = await makeUser(tx);
    const institution = await makeInstitution(tx);
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    created.institutions.push(institution.id);
    return { userId: user.id, accountId: account.id };
  });
  created.users.push(seeded.userId);
  return seeded;
}

async function token(symbol: string, type: 'crypto' | 'fiat' | 'stock') {
  const [row] = await getDb()
    .insert(schema.tokens)
    .values({ symbol, name: symbol, typeId: (await typeIds())[type] })
    .returning();
  if (!row) throw new Error('tokens insert failed');
  return row;
}

async function holding(
  seeded: Seeded,
  fields: {
    tokenId: string;
    balance: string;
    source: string;
    externalId?: string | null;
    arrival?: 'user_confirmed' | 'auto_discovered';
    absentFromStatements?: Date[] | null;
  }
) {
  return await getDb().transaction(async (tx) => {
    const row = await makeHolding(tx, {
      userId: seeded.userId,
      accountId: seeded.accountId,
      tokenId: fields.tokenId,
      balance: fields.balance,
      source: fields.source,
      externalId: fields.externalId ?? null,
      absentFromStatements: fields.absentFromStatements ?? null,
      ...(fields.arrival ? { arrival: fields.arrival } : {}),
      createdAt: T0,
      lastUpdated: T0,
    });
    await tx.insert(schema.holdingBalanceObservations).values({
      userId: seeded.userId,
      holdingId: row.id,
      balance: fields.balance,
      observedAt: T0,
      source: 'sync-capture',
      sourceMetadata: UPDATE_ORIGIN,
    });
    return row;
  });
}

function snapshot(
  symbol: string,
  balance: string,
  tokenType: 'crypto' | 'fiat' | 'stock',
  capturedAt: Date = new Date()
): HoldingSnapshot {
  return {
    externalId: symbol,
    balance,
    capturedAt,
    tokenType,
    tokenIdentity: { symbol, name: `${symbol} name` },
  };
}

interface Scenario {
  snapshots: HoldingSnapshot[];
  staleStrategy?: 'zero' | 'preserve';
  arrival?: 'user_confirmed' | 'auto_discovered';
  unchangedCheckpoint?: 'append' | 'skip' | 'skip-observation';
  /** SC-1451: a fiat holding zeroes once it is missing from this many statements. */
  confirmFiat?: number;
}

/** The account's provider input, which the exchange sync's balances belong to. */
const INPUT_SOURCE = 'provider:characterize';

/** The exchange sync's call, as `SyncExchangeBalancesUseCase` makes it. */
async function sync(seeded: Seeded, scenario: Scenario) {
  return await withTransaction((tx) =>
    Container.get(HoldingsSyncHelper).processSnapshotsForAccount({
      userId: seeded.userId,
      accountId: seeded.accountId,
      inputSource: INPUT_SOURCE,
      snapshots: scenario.snapshots,
      exits: [],
      fetchedAt: new Date(),
      typeCodes: new Set(['crypto', 'fiat', 'stock']),
      holdingMatch: 'token-id',
      staleStrategy: scenario.staleStrategy ?? 'zero',
      ...(scenario.confirmFiat ? { absentFiatConfirmations: scenario.confirmFiat } : {}),
      sourceTag: TAG,
      respectHiddenForCounts: false,
      unchangedCheckpoint: scenario.unchangedCheckpoint ?? 'skip',
      updateOnly: false,
      arrival: scenario.arrival ?? 'auto_discovered',
      tx,
    })
  );
}

const holdingsOf = (accountId: string) =>
  getDb()
    .select()
    .from(schema.holdings)
    .where(eq(schema.holdings.accountId, accountId))
    .orderBy(asc(schema.holdings.createdAt), asc(schema.holdings.id));

async function holdingRow(holdingId: string) {
  const [row] = await getDb()
    .select()
    .from(schema.holdings)
    .where(eq(schema.holdings.id, holdingId));
  if (!row) throw new Error(`holding ${holdingId} is gone`);
  return row;
}

const observationsOf = (holdingId: string) =>
  getDb()
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId))
    .orderBy(asc(schema.holdingBalanceObservations.observedAt));

/** What today's path writes on an observation, and what history reads. */
const legacyColumns = (o: typeof schema.holdingBalanceObservations.$inferSelect) => ({
  balance: o.balance,
  observedAt: o.observedAt,
  source: o.source,
  sourceMetadata: o.sourceMetadata,
});

/** Where an observation came from: A1's labels. */
const provenance = (o: typeof schema.holdingBalanceObservations.$inferSelect) => ({
  role: o.role,
  authority: o.authority,
  inputId: o.inputId,
  cause: o.cause,
});

/** The provider's checkpoint on the account's input, as A1 labels a sync's observation (R60). */
async function expectedProvenance(seeded: Seeded) {
  const [input] = await getDb()
    .select()
    .from(schema.feedInputs)
    .where(
      and(
        eq(schema.feedInputs.accountId, seeded.accountId),
        eq(schema.feedInputs.source, INPUT_SOURCE)
      )
    );
  if (!input) throw new Error('the sync wrote no input for the account');
  return {
    role: 'checkpoint' as const,
    authority: 'provider' as const,
    inputId: input.id,
    cause: null,
  };
}

const day = (iso: string) => new Date(`${iso}T05:00:00Z`);

describe('HoldingsSyncHelper — manual holdings are off-limits to exchange sync', () => {
  test('updates its own synced holding, never the manual one, when both share a token', async () => {
    const seeded = await seed();
    const usd = await token(fresh('ZUSD'), 'fiat');
    // The manual row is the newer one, so a token-keyed map that kept the last
    // row would hand the sync the manual balance.
    const auto = await holding(seeded, {
      tokenId: usd.id,
      source: 'import_airwallex',
      externalId: 'USD',
      balance: '585.44',
    });
    const manual = await holding(seeded, { tokenId: usd.id, source: 'manual', balance: '500' });

    await sync(seeded, { snapshots: [snapshot(usd.symbol, '1186.19', 'fiat')] });

    expect((await holdingRow(auto.id)).balance).toBe('1186.19');
    expect(await holdingRow(manual.id)).toMatchObject({ balance: '500', lastUpdated: T0 });
    expect(await observationsOf(manual.id)).toHaveLength(1);
    expect(await holdingsOf(seeded.accountId)).toHaveLength(2);
  });

  test('creates its own holding instead of overwriting a manual-only holding', async () => {
    const seeded = await seed();
    const usd = await token(fresh('ZUSD'), 'fiat');
    const manual = await holding(seeded, { tokenId: usd.id, source: 'manual', balance: '3000.69' });

    await sync(seeded, { snapshots: [snapshot(usd.symbol, '1186.19', 'fiat')] });

    expect(await holdingRow(manual.id)).toMatchObject({ balance: '3000.69', lastUpdated: T0 });
    const rows = await holdingsOf(seeded.accountId);
    expect(rows.map((h) => [h.tokenId, h.balance, h.source, h.arrival, h.externalId])).toEqual([
      [usd.id, '3000.69', 'manual', 'unattributed', null],
      [usd.id, '1186.19', TAG, 'auto_discovered', null],
    ]);
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
    const seeded = await seed();
    const usd = await token(fresh('ZUSD'), 'fiat');
    const reviewCreated = await holding(seeded, {
      tokenId: usd.id,
      source: TAG,
      balance: '0',
      arrival: 'user_confirmed',
    });

    await sync(seeded, { snapshots: [snapshot(usd.symbol, '1186.19', 'fiat')] });

    const rows = await holdingsOf(seeded.accountId);
    expect(rows.map((h) => [h.id, h.balance])).toEqual([[reviewCreated.id, '1186.19']]);
  });

  test('the same row at source manual is invisible — the split shape SC-356 removes', async () => {
    const seeded = await seed();
    const usd = await token(fresh('ZUSD'), 'fiat');
    const asManual = await holding(seeded, {
      tokenId: usd.id,
      source: 'manual',
      balance: '0',
      arrival: 'user_confirmed',
    });

    await sync(seeded, { snapshots: [snapshot(usd.symbol, '1186.19', 'fiat')] });

    // Two holdings for one (account, token) — where per-holding tx dedup lets
    // one upstream event be ingested onto both.
    expect((await holdingRow(asManual.id)).balance).toBe('0');
    expect(await holdingsOf(seeded.accountId)).toHaveLength(2);
  });
});

describe('HoldingsSyncHelper — arrival provenance', () => {
  // The helper is the single create path for both the wallet-import review
  // (a human kept this row) and the hourly balance sync (nobody was asked).
  // Before SC-277 both produced `source = 'blockchain'` and were
  // indistinguishable afterwards, so it has to carry the caller's answer
  // rather than infer one.
  test('stamps the caller-supplied arrival onto a created holding', async () => {
    const seeded = await seed();
    await sync(seeded, {
      arrival: 'user_confirmed',
      snapshots: [snapshot(fresh('ZARR'), '42', 'crypto')],
    });
    expect((await holdingsOf(seeded.accountId)).map((h) => h.arrival)).toEqual(['user_confirmed']);
  });

  test('stamps auto_discovered when the sync created the row on its own', async () => {
    const seeded = await seed();
    await sync(seeded, {
      arrival: 'auto_discovered',
      snapshots: [snapshot(fresh('ZARR'), '42', 'crypto')],
    });
    expect((await holdingsOf(seeded.accountId)).map((h) => h.arrival)).toEqual(['auto_discovered']);
  });
});

describe('HoldingsSyncHelper — only broker cash may go negative (SC-1462)', () => {
  // Margin debt is a negative cash balance that subtracts from net worth, as
  // the broker shows it (mgrin, 2026-09-30). A negative position in anything
  // else (a short) has no representation here and is still skipped rather than
  // written.
  test('writes a negative cash snapshot as a negative holding', async () => {
    const seeded = await seed();
    await sync(seeded, { snapshots: [snapshot(fresh('ZCASH'), '-42.5', 'fiat')] });
    expect((await holdingsOf(seeded.accountId)).map((h) => h.balance)).toEqual(['-42.5']);
  });

  test('moves an existing cash holding below zero', async () => {
    const seeded = await seed();
    const usd = await token(fresh('ZUSD'), 'fiat');
    const auto = await holding(seeded, {
      tokenId: usd.id,
      source: 'import_ibkr',
      externalId: 'USD',
      balance: '585.44',
    });

    await sync(seeded, { snapshots: [snapshot(usd.symbol, '-1200.75', 'fiat')] });

    const rows = await holdingsOf(seeded.accountId);
    expect(rows.map((h) => [h.id, h.balance])).toEqual([[auto.id, '-1200.75']]);
  });

  // The control: a short position is not cash, and stays out.
  test('skips a negative non-cash snapshot', async () => {
    const seeded = await seed();
    const symbol = fresh('ZTSLA');
    await sync(seeded, { snapshots: [snapshot(symbol, '-5', 'stock')] });
    expect(await holdingsOf(seeded.accountId)).toEqual([]);
    // Skipped before its token is looked up, so none is created for it.
    expect(
      await getDb().select().from(schema.tokens).where(eq(schema.tokens.symbol, symbol))
    ).toEqual([]);
  });

  test('skips a negative crypto snapshot', async () => {
    const seeded = await seed();
    await sync(seeded, { snapshots: [snapshot(fresh('ZETH'), '-0.5', 'crypto')] });
    expect(await holdingsOf(seeded.accountId)).toEqual([]);
  });

  test('a negative non-cash snapshot never updates an existing holding', async () => {
    const seeded = await seed();
    const usd = await token(fresh('ZUSD'), 'fiat');
    const auto = await holding(seeded, {
      tokenId: usd.id,
      source: 'import_ibkr',
      externalId: 'USD',
      balance: '585.44',
    });

    await sync(seeded, { snapshots: [snapshot(fresh('ZTSLA'), '-1200.75', 'stock')] });

    // Dropped, so `auto` is never written a negative value. Its token is now
    // unseen, so the stale-zeroing pass zeroes it.
    const rows = await holdingsOf(seeded.accountId);
    expect(rows.map((h) => [h.id, h.balance])).toEqual([[auto.id, '0']]);
  });
});

// SC-236. A credential row whose decrypted payload has no apiKey/apiSecret
// makes `resolveApiCreds` return null, and every HMAC provider turns that
// into `return []` — the same value a genuinely-empty account produces.
// Under `staleStrategy: 'zero'` the second reading wiped the account, hourly.
describe('HoldingsSyncHelper — a hidden holding the sync gives a balance (SC-1557)', () => {
  async function hidden(seeded: Seeded, hiddenBy: 'auto' | 'user') {
    const coin = await token(fresh('ZSWP'), 'crypto');
    const row = await holding(seeded, {
      tokenId: coin.id,
      source: 'import_kraken',
      externalId: coin.symbol,
      balance: '0',
    });
    await getDb()
      .update(schema.holdings)
      .set({ isHidden: true, hiddenBy })
      .where(eq(schema.holdings.id, row.id));
    return { id: row.id, symbol: coin.symbol };
  }

  const shape = async (holdingId: string) => {
    const row = await holdingRow(holdingId);
    return { balance: row.balance, isHidden: row.isHidden, hiddenBy: row.hiddenBy };
  };

  test('one the sweep hid is shown again, and still reads as swept', async () => {
    const seeded = await seed();
    const swept = await hidden(seeded, 'auto');

    await sync(seeded, { snapshots: [snapshot(swept.symbol, '4.2', 'crypto')] });

    expect(await shape(swept.id)).toEqual({ balance: '4.2', isHidden: false, hiddenBy: 'auto' });
  });

  // The control: the same sync, the same balance, and its owner's choice holds.
  test('one its owner hid stays hidden', async () => {
    const seeded = await seed();
    const mine = await hidden(seeded, 'user');

    await sync(seeded, { snapshots: [snapshot(mine.symbol, '4.2', 'crypto')] });

    expect(await shape(mine.id)).toEqual({ balance: '4.2', isHidden: true, hiddenBy: 'user' });
  });
});

describe('HoldingsSyncHelper — an empty snapshot never zeroes anything', () => {
  test('refuses to zero holdings when the provider returned nothing at all', async () => {
    const seeded = await seed();
    const usd = await token(fresh('ZUSD'), 'fiat');
    const held = await holding(seeded, {
      tokenId: usd.id,
      source: 'import_binance',
      externalId: 'USD',
      balance: '12345.67',
    });

    const result = await sync(seeded, { snapshots: [] });

    expect(await holdingRow(held.id)).toMatchObject({ balance: '12345.67', lastUpdated: T0 });
    expect(await observationsOf(held.id)).toHaveLength(1);
    expect(result.removed).toBe(0);
  });

  // A snapshot with rows in it is evidence the provider looked, so a holding
  // missing from one is a real disposal and must still zero. This is also
  // the honest limit of the guard: a PARTIAL snapshot still zeroes what it
  // omits, and that looks like the user sold something. Tracked separately.
  test('still zeroes a holding the provider did not return, when it returned something', async () => {
    const seeded = await seed();
    const other = await token(fresh('ZOTHER'), 'crypto');
    const sold = await holding(seeded, {
      tokenId: other.id,
      source: 'import_binance',
      externalId: 'OTHER',
      balance: '999',
    });

    const result = await sync(seeded, { snapshots: [snapshot(fresh('ZUSD'), '50', 'fiat')] });

    expect((await holdingRow(sold.id)).balance).toBe('0');
    expect(result.removed).toBe(1);
  });

  test('an empty snapshot with nothing held is not an event', async () => {
    const seeded = await seed();
    const result = await sync(seeded, { snapshots: [] });
    expect(await holdingsOf(seeded.accountId)).toEqual([]);
    expect(result).toMatchObject({ updated: 0, created: 0, removed: 0 });
  });
});

// SC-1600: the hourly syncs announce a user only when a balance moved. The
// wallet sync stamps `last_updated` on an unchanged balance (skip-observation),
// so a cache write counts as `updated` and is not evidence of a change; a
// written observation is.
describe('HoldingsSyncHelper — whether a balance changed (SC-1600)', () => {
  async function held(seeded: Seeded, balance: string) {
    const btc = await token(fresh('ZBTC'), 'crypto');
    await holding(seeded, {
      tokenId: btc.id,
      source: 'import_binance',
      externalId: 'BTC',
      balance,
    });
    return btc;
  }

  test('a wallet sync that finds the same balance writes no observation, though it counts an update', async () => {
    const seeded = await seed();
    const btc = await held(seeded, '1.5');
    const result = await sync(seeded, {
      snapshots: [snapshot(btc.symbol, '1.5', 'crypto')],
      unchangedCheckpoint: 'skip-observation',
    });
    expect(result.updated).toBe(1);
    expect(result.observationsWritten).toBe(0);
  });

  test('control: a wallet sync that finds a new balance writes one', async () => {
    const seeded = await seed();
    const btc = await held(seeded, '1.5');
    const result = await sync(seeded, {
      snapshots: [snapshot(btc.symbol, '2', 'crypto')],
      unchangedCheckpoint: 'skip-observation',
    });
    expect(result.observationsWritten).toBe(1);
  });

  test('an exchange sync that finds the same balance writes none, and a zeroed holding counts', async () => {
    const seeded = await seed();
    const btc = await held(seeded, '1.5');
    const same = await sync(seeded, { snapshots: [snapshot(btc.symbol, '1.5', 'crypto')] });
    expect(same.observationsWritten).toBe(0);
    const gone = await sync(seeded, { snapshots: [snapshot(fresh('ZUSD'), '50', 'fiat')] });
    expect(gone.removed).toBe(1);
    expect(gone.observationsWritten).toBeGreaterThanOrEqual(1);
  });
});

// SC-1427: a reporting interface's balance is true as of its own date, not
// when we fetched it. IBKR's Flex positions are a close 1-2 business days
// earlier; stamped at fetch time, a trade in between sat before an
// observation that did not include it and read as unexplained drift.
describe('HoldingsSyncHelper — the observation is stamped at the source as-of', () => {
  test('passes each snapshot capturedAt to the update and the create', async () => {
    const seeded = await seed();
    const usd = await token(fresh('ZUSD'), 'fiat');
    const existing = await holding(seeded, {
      tokenId: usd.id,
      source: TAG,
      externalId: 'USD',
      balance: '0',
    });
    const eur = fresh('ZEUR');
    const asOf = new Date('2026-08-14T20:00:00.000Z');

    await sync(seeded, {
      unchangedCheckpoint: 'append',
      snapshots: [snapshot(usd.symbol, '10', 'fiat', asOf), snapshot(eur, '5', 'fiat', asOf)],
    });

    const updated = await observationsOf(existing.id);
    expect(updated.map(legacyColumns)).toEqual([
      expect.objectContaining({ balance: '0', observedAt: T0 }),
      { balance: '10', observedAt: asOf, source: 'sync-capture', sourceMetadata: UPDATE_ORIGIN },
    ]);
    const createdRow = (await holdingsOf(seeded.accountId)).find((h) => h.id !== existing.id);
    const createdObs = await observationsOf(createdRow!.id);
    expect(createdObs.map(legacyColumns)).toEqual([
      {
        balance: '5',
        observedAt: asOf,
        source: 'sync-capture',
        sourceMetadata: { origin: 'createHoldingWithEvent', source: TAG },
      },
    ]);

    const labelled = await expectedProvenance(seeded);
    expect([provenance(updated[1]!), provenance(createdObs[0]!)]).toEqual([labelled, labelled]);
  });
});

// SC-1451. IBKR's CashReport can leave out a currency that is still held, and
// the sync read that absence as a zero: mgrin's USD and CAD both read 0 on
// 2026-07-20 and were back the next day. An absence of a confirmed holding now
// zeroes only after it has been missing from that many distinct statements.
describe('HoldingsSyncHelper — a currency missing from one statement is not a zero', () => {
  async function withCash(absent: string[] | null) {
    const seeded = await seed();
    const cad = await token(fresh('ZCAD'), 'fiat');
    const cash = await holding(seeded, {
      tokenId: cad.id,
      source: 'import_ibkr',
      externalId: 'CAD',
      balance: '47.87',
      absentFromStatements: absent?.map(day) ?? null,
    });
    const stock = snapshot(fresh('ZVOO'), '2', 'stock', day('2026-07-20'));
    return { seeded, cad, cash, stock };
  }

  const absences = async (holdingId: string) =>
    (await holdingRow(holdingId)).absentFromStatements?.map((d) => d.toISOString().slice(0, 10)) ??
    null;

  test('the first statement that leaves it out records the date and keeps the balance', async () => {
    const { seeded, cash, stock } = await withCash(null);
    await sync(seeded, { confirmFiat: 3, snapshots: [stock] });
    expect((await holdingRow(cash.id)).balance).toBe('47.87');
    expect(await absences(cash.id)).toEqual(['2026-07-20']);
  });

  test('re-reading the same statement does not count twice', async () => {
    const { seeded, cash, stock } = await withCash(['2026-07-19', '2026-07-20']);
    await sync(seeded, { confirmFiat: 3, snapshots: [stock] });
    expect((await holdingRow(cash.id)).balance).toBe('47.87');
    expect(await absences(cash.id)).toEqual(['2026-07-19', '2026-07-20']);
  });

  test('the third consecutive statement without it lands the zero and clears the count', async () => {
    const { seeded, cash, stock } = await withCash(['2026-07-18', '2026-07-19']);
    await sync(seeded, { confirmFiat: 3, snapshots: [stock] });
    expect((await holdingRow(cash.id)).balance).toBe('0');
    expect(await absences(cash.id)).toBeNull();
    const zero = (await observationsOf(cash.id)).at(-1)!;
    // At the statement the third absence is read from (A5 D-22, R60).
    expect(zero.observedAt).toEqual(day('2026-07-20'));
    expect({ ...legacyColumns(zero), observedAt: null }).toEqual({
      balance: '0',
      observedAt: null,
      source: 'sync-capture',
      sourceMetadata: UPDATE_ORIGIN,
    });
    expect(provenance(zero)).toEqual(await expectedProvenance(seeded));
  });

  test('reporting it again resets the count', async () => {
    const { seeded, cad, cash, stock } = await withCash(['2026-07-20']);
    await sync(seeded, {
      confirmFiat: 3,
      snapshots: [snapshot(cad.symbol, '47.87', 'fiat', stock.capturedAt)],
    });
    expect(await absences(cash.id)).toBeNull();
    // Unchanged, so nothing else was written.
    expect(await holdingRow(cash.id)).toMatchObject({ balance: '47.87', lastUpdated: T0 });
    expect(await observationsOf(cash.id)).toHaveLength(1);
  });

  test('a holding outside the confirmed set still zeroes at once', async () => {
    const { seeded, stock } = await withCash(null);
    const other = await token(fresh('ZOTHER'), 'crypto');
    const gone = await holding(seeded, { tokenId: other.id, source: 'import_ibkr', balance: '5' });
    await sync(seeded, { confirmFiat: 3, snapshots: [stock] });
    expect((await holdingRow(gone.id)).balance).toBe('0');
    expect(await absences(gone.id)).toBeNull();
  });
});
