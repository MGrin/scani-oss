/**
 * The hourly balance syncs and the manual refresh, end to end against
 * Postgres: `SyncExchangeBalancesUseCase`, `SyncWalletBalancesUseCase` and
 * `RefreshAccountBalanceUseCase`. Only what reaches outside the database is
 * stubbed: the provider, the institution lookup, the credential decryption
 * and the price warm-up. Every holding, observation and account row asserted
 * here is what the use case wrote.
 *
 * Written against today's path before the syncs move onto `FeedIngestService`
 * (foundation A2 Task 16), and kept as their characterization.
 *
 * Fixtures are committed rather than rolled back: each use case opens its
 * own transactions, and history reads committed rows.
 */

import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import type { Institution } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { HoldingSnapshot, PositionProbe } from '@scani/providers/core/types';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { InstitutionRepository } from '../../src/repositories/InstitutionRepository';
import { FoundationClassificationService } from '../../src/services/foundation/FoundationClassificationService';
import {
  providerInputSource,
  walletInputSource,
} from '../../src/services/foundation/plan-feed-inputs';
import { BalanceRefreshabilityService } from '../../src/services/holdings/BalanceRefreshabilityService';
import { MANUAL_HOLDING_SOURCE } from '../../src/services/holdings/balance-sync-sources';
import { PriceWarmupService } from '../../src/services/pricing/PriceWarmupService';
import { IntegrationCredentialsService } from '../../src/services/users/IntegrationCredentialsService';
import { UserWalletService } from '../../src/services/users/UserWalletService';
import { WalletDiscoveryService } from '../../src/services/users/WalletDiscoveryService';
import { RefreshAccountBalanceUseCase } from '../../src/use-cases/RefreshAccountBalanceUseCase';
import { SyncExchangeBalancesUseCase } from '../../src/use-cases/SyncExchangeBalancesUseCase';
import { SyncWalletBalancesUseCase } from '../../src/use-cases/SyncWalletBalancesUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { makeCredential, makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding } from '../../test/helpers/factories-extra';
import { captureHistory } from '../../test/helpers/history-neutrality';
import { expectLabelsSettled } from '../../test/helpers/labels-settled';

restoreContainerAfterAll();

const DAY_MS = 86_400_000;
const T0 = new Date('2026-09-01T00:00:00Z');
const CAPTURED = new Date('2026-09-20T08:00:00Z');
const NOW = new Date('2026-09-25T12:00:00Z');
const EXCHANGE_TAG = 'sync_exchange_balances';
const WALLET_TAG = 'blockchain';
const UPDATE_ORIGIN = { origin: 'updateHoldingBalanceWithEvent' };

const created = { users: [] as string[], symbols: [] as string[], institutions: [] as string[] };

afterEach(async () => {
  setSystemTime();
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

async function typeIds(): Promise<Record<'crypto' | 'fiat', string>> {
  const rows = await getDb().select().from(schema.tokenTypes);
  const idOf = (code: string) => {
    const row = rows.find((r) => r.code === code);
    if (!row) throw new Error(`no token type ${code}; the seed migration has one`);
    return row.id;
  };
  return { crypto: idOf('crypto'), fiat: idOf('fiat') };
}

async function token(symbol: string, type: 'crypto' | 'fiat' = 'crypto') {
  const [row] = await getDb()
    .insert(schema.tokens)
    .values({ symbol, name: symbol, typeId: (await typeIds())[type] })
    .returning();
  if (!row) throw new Error('tokens insert failed');
  return row;
}

async function institution(): Promise<Institution> {
  const row = await getDb().transaction((tx) => makeInstitution(tx));
  created.institutions.push(row.id);
  return row;
}

interface Owner {
  userId: string;
  accountId: string;
}

/** A user with one account at the exchange, and a credential there unless told otherwise. */
async function exchangeOwner(exchange: Institution, { credential = true } = {}): Promise<Owner> {
  const owner = await getDb().transaction(async (tx) => {
    const user = await makeUser(tx);
    if (credential) await makeCredential(tx, { userId: user.id, institutionId: exchange.id });
    const account = await makeAccount(tx, {
      userId: user.id,
      institutionId: exchange.id,
      metadata: { accountType: 'SPOT', note: 'kept' },
    });
    return { userId: user.id, accountId: account.id };
  });
  created.users.push(owner.userId);
  return owner;
}

interface WalletOwner extends Owner {
  wallet: typeof schema.userWallets.$inferSelect;
}

/** A wallet on the chain and the account that backs it, for a new user or for `of`'s. */
async function walletOwner(chain: Institution, of?: Owner): Promise<WalletOwner> {
  const owner = await getDb().transaction(async (tx) => {
    const user = of ? { id: of.userId } : await makeUser(tx);
    const [wallet] = await tx
      .insert(schema.userWallets)
      .values({
        userId: user.id,
        walletAddress: `0x${randomUUID().replace(/-/g, '')}`,
        institutionIds: [chain.id],
      })
      .returning();
    if (!wallet) throw new Error('user_wallets insert failed');
    const account = await makeAccount(tx, {
      userId: user.id,
      institutionId: chain.id,
      metadata: {
        userWalletId: wallet.id,
        chainId: '1',
        walletAddress: wallet.walletAddress,
        chainName: chain.name,
      },
    });
    return { userId: user.id, accountId: account.id, wallet };
  });
  if (!of) created.users.push(owner.userId);
  return owner;
}

/** A holding with today's sync observation behind it, at T0. */
async function holding(
  owner: Owner,
  fields: {
    tokenId: string;
    balance: string;
    source: string;
    externalId?: string | null;
    isHidden?: boolean;
    kind?: typeof schema.holdings.$inferSelect.kind;
  }
) {
  return await getDb().transaction(async (tx) => {
    const row = await makeHolding(tx, {
      userId: owner.userId,
      accountId: owner.accountId,
      tokenId: fields.tokenId,
      balance: fields.balance,
      source: fields.source,
      externalId: fields.externalId ?? null,
      isHidden: fields.isHidden ?? false,
      kind: fields.kind ?? null,
      createdAt: T0,
      lastUpdated: T0,
    });
    await tx.insert(schema.holdingBalanceObservations).values({
      userId: owner.userId,
      holdingId: row.id,
      balance: fields.balance,
      observedAt: T0,
      source: 'sync-capture',
      sourceMetadata: UPDATE_ORIGIN,
    });
    return row;
  });
}

/** A provider row whose external id is its key: the holding's `external_id` on a wallet. */
function snapshot(
  key: string,
  symbol: string,
  balance: string,
  extra: Partial<HoldingSnapshot> = {}
): HoldingSnapshot {
  return {
    externalId: key,
    balance,
    capturedAt: CAPTURED,
    tokenIdentity: { symbol, name: symbol },
    ...extra,
  };
}

const answerAll =
  (state: PositionProbe['state']) =>
  async (_ctx: unknown, ids: readonly string[]): Promise<PositionProbe[]> =>
    ids.map((externalId) => ({ externalId, state }));

function stubRegistry(provider: Record<string, unknown>): void {
  Container.set(ProviderRegistry, {
    getBalanceFetcher: () => provider,
    getIdentityEnrichers: () => [],
    // Read when the wallet sync's AccountService builds its pricing router.
    getAllCurrentPricers: () => [],
  } as unknown as ProviderRegistry);
}

function stubInstitutionCode(code: string): void {
  Container.set(WalletDiscoveryService, {
    resolveInstitutionCode: async () => code,
  } as unknown as WalletDiscoveryService);
}

function stubCredentials(decrypted: Record<string, unknown> | null): void {
  Container.set(IntegrationCredentialsService, {
    getDecryptedCredentials: async () => decrypted,
    clearSyncRefusal: async () => {},
    recordSyncRefusal: async () => {},
  } as unknown as IntegrationCredentialsService);
}

/** One hourly exchange run over `exchange` alone, each user answered by `answers`. */
async function syncExchange(
  exchange: Institution,
  answers: ReadonlyMap<string, HoldingSnapshot[]>,
  provider: { absentFiatConfirmations?: number } = {}
) {
  Container.set(InstitutionRepository, {
    findSyncableInstitutions: async () => [exchange],
  } as unknown as InstitutionRepository);
  stubInstitutionCode('zz-exchange');
  stubCredentials({ apiKey: 'key', apiSecret: 'secret' });
  stubRegistry({
    ...provider,
    fetchBalances: async (ctx: { userId?: string }) => answers.get(ctx.userId ?? '') ?? [],
  });
  return await new SyncExchangeBalancesUseCase().execute();
}

/** One hourly wallet run over these owners' wallets alone. */
async function syncWallets(
  owners: readonly WalletOwner[],
  answers: ReadonlyMap<string, HoldingSnapshot[]>,
  probe?: (ctx: unknown, ids: readonly string[]) => Promise<PositionProbe[]>
) {
  const warmed: Array<{ userId: string; tokenIds: string[] }> = [];
  Container.set(UserWalletService, {
    getUserWallets: async (userId: string) =>
      owners.filter((o) => o.userId === userId).map((o) => o.wallet),
  } as unknown as UserWalletService);
  Container.set(PriceWarmupService, {
    warm: async (input: { userId: string; tokenIds: string[] }) => {
      warmed.push(input);
      return new Map();
    },
  } as unknown as PriceWarmupService);
  stubInstitutionCode('zz-chain');
  stubRegistry({
    fetchBalances: async (ctx: { userId?: string }) => answers.get(ctx.userId ?? '') ?? [],
    ...(probe ? { probePositions: probe } : {}),
  });
  const result = await new SyncWalletBalancesUseCase().execute();
  return { result, warmed };
}

/**
 * A person pressing Refresh on one account. Credentials are decrypted, as the
 * real service does it, only where the user holds an active one at the
 * institution, so a fixture without one is refreshed without one.
 */
async function refresh(
  owner: Owner,
  answer: HoldingSnapshot[],
  options: { probe?: (ctx: unknown, ids: readonly string[]) => Promise<PositionProbe[]> } = {}
) {
  let fetched = 0;
  stubInstitutionCode('zz-refresh');
  Container.set(IntegrationCredentialsService, {
    getDecryptedCredentials: async (userId: string, institutionId: string) => {
      const credentials = schema.userIntegrationCredentials;
      const [active] = await getDb()
        .select({ id: credentials.id })
        .from(credentials)
        .where(
          and(
            eq(credentials.userId, userId),
            eq(credentials.institutionId, institutionId),
            eq(credentials.isActive, true)
          )
        )
        .limit(1);
      return active ? { apiKey: 'key' } : null;
    },
  } as unknown as IntegrationCredentialsService);
  stubRegistry({
    fetchBalances: async () => {
      fetched += 1;
      return answer;
    },
    ...(options.probe ? { probePositions: options.probe } : {}),
  });
  const result = await new RefreshAccountBalanceUseCase().execute({
    userId: owner.userId,
    accountId: owner.accountId,
  });
  return { result, fetched };
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

async function accountRow(accountId: string) {
  const [row] = await getDb()
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  if (!row) throw new Error(`account ${accountId} is gone`);
  return row;
}

async function tokenBySymbol(symbol: string) {
  const [row] = await getDb().select().from(schema.tokens).where(eq(schema.tokens.symbol, symbol));
  return row ?? null;
}

/** What today's path writes on an observation, and what history reads. */
const legacyColumns = (o: typeof schema.holdingBalanceObservations.$inferSelect) => ({
  balance: o.balance,
  observedAt: o.observedAt,
  source: o.source,
  sourceMetadata: o.sourceMetadata,
});

const within = (at: Date, from: Date, to: Date) => at >= from && at <= to;

describe('SyncExchangeBalancesUseCase — the hourly exchange sync', () => {
  test('updates, creates and zeroes, tallies a missing currency, and stamps the account', async () => {
    const exchange = await institution();
    const owner = await exchangeOwner(exchange);
    const [kept, gone, cash] = [
      await token(fresh('XKEEP')),
      await token(fresh('XGONE')),
      await token(fresh('XCASH'), 'fiat'),
    ];
    const rows = {
      kept: await holding(owner, { tokenId: kept.id, balance: '1', source: EXCHANGE_TAG }),
      gone: await holding(owner, { tokenId: gone.id, balance: '5', source: EXCHANGE_TAG }),
      cash: await holding(owner, { tokenId: cash.id, balance: '10', source: EXCHANGE_TAG }),
    };
    const newSymbol = fresh('XNEW');
    const before = new Date();

    const result = await syncExchange(
      exchange,
      new Map([
        [
          owner.userId,
          [snapshot('K', kept.symbol, '2'), snapshot('N', newSymbol, '3', { tokenType: 'crypto' })],
        ],
      ]),
      { absentFiatConfirmations: 3 }
    );
    const after = new Date();

    expect(result).toMatchObject({
      accountsFound: 1,
      accountsSynced: 1,
      accountsFailed: 0,
      holdingsUpdated: 1,
      holdingsCreated: 1,
      holdingsRemoved: 1,
      errors: [],
    });

    expect((await holdingRow(rows.kept.id)).balance).toBe('2');
    expect((await observationsOf(rows.kept.id)).map(legacyColumns)).toEqual([
      expect.objectContaining({ balance: '1', observedAt: T0 }),
      { balance: '2', observedAt: CAPTURED, source: 'sync-capture', sourceMetadata: UPDATE_ORIGIN },
    ]);

    const newToken = await tokenBySymbol(newSymbol);
    const fresh_ = (await holdingsOf(owner.accountId)).find((h) => h.tokenId === newToken?.id);
    expect(fresh_).toMatchObject({
      balance: '3',
      source: EXCHANGE_TAG,
      arrival: 'auto_discovered',
      externalId: null,
      isHidden: false,
    });
    expect((await observationsOf(fresh_!.id)).map(legacyColumns)).toEqual([
      {
        balance: '3',
        observedAt: CAPTURED,
        source: 'sync-capture',
        sourceMetadata: { origin: 'createHoldingWithEvent', source: EXCHANGE_TAG },
      },
    ]);

    // Absent from a non-empty answer: zeroed at now.
    const goneObs = await observationsOf(rows.gone.id);
    expect((await holdingRow(rows.gone.id)).balance).toBe('0');
    expect(within(goneObs[1]!.observedAt, before, after)).toBe(true);
    expect({ ...legacyColumns(goneObs[1]!), observedAt: null }).toEqual({
      balance: '0',
      observedAt: null,
      source: 'sync-capture',
      sourceMetadata: UPDATE_ORIGIN,
    });

    // A currency missing from one statement is tallied, not zeroed (SC-1451).
    expect(await holdingRow(rows.cash.id)).toMatchObject({
      balance: '10',
      absentFromStatements: [CAPTURED],
    });

    const metadata = (await accountRow(owner.accountId)).metadata as Record<string, unknown>;
    expect(metadata).toEqual({ accountType: 'SPOT', note: 'kept', lastSync: expect.any(String) });
    expect(within(new Date(metadata.lastSync as string), before, after)).toBe(true);
  });

  test('an answer a day old stamps the account with the as-of the provider gave', async () => {
    const exchange = await institution();
    const owner = await exchangeOwner(exchange);
    const kept = await token(fresh('XASOF'));
    await holding(owner, { tokenId: kept.id, balance: '1', source: EXCHANGE_TAG });
    const asOf = new Date(Date.now() - DAY_MS);

    await syncExchange(
      exchange,
      new Map([
        [
          owner.userId,
          [snapshot('K', kept.symbol, '2', { capturedAt: asOf, asOfNote: 'statement close' })],
        ],
      ])
    );

    const metadata = (await accountRow(owner.accountId)).metadata as Record<string, unknown>;
    expect(metadata.balancesAsOf).toEqual({ at: asOf.toISOString(), note: 'statement close' });
  });
});

describe('which holding a sync writes into', () => {
  test('a zero for a token the account does not hold opens nothing, and its token is still found or created', async () => {
    const exchange = await institution();
    const owner = await exchangeOwner(exchange);
    const kept = await token(fresh('ZKEEP'));
    await holding(owner, { tokenId: kept.id, balance: '1', source: EXCHANGE_TAG });
    const empty = fresh('ZEMPTY');

    const result = await syncExchange(
      exchange,
      new Map([[owner.userId, [snapshot('K', kept.symbol, '1'), snapshot('E', empty, '0')]]])
    );

    expect(result).toMatchObject({ holdingsCreated: 0, holdingsRemoved: 0 });
    expect(await tokenBySymbol(empty)).not.toBeNull();
    expect((await holdingsOf(owner.accountId)).map((h) => h.tokenId)).toEqual([kept.id]);
  });

  // An import keys a wallet holding `externalTokenId || symbol`; the sync's key
  // leads with the contract address, so it finds that holding by its token.
  test('the wallet sync finds a holding keyed by another key through its token', async () => {
    const chain = await institution();
    const owner = await walletOwner(chain);
    const usdc = await token(fresh('WUSDC'));
    const imported = await holding(owner, {
      tokenId: usdc.id,
      balance: '5',
      source: WALLET_TAG,
      externalId: usdc.symbol,
    });

    const { result } = await syncWallets(
      [owner],
      new Map([[owner.userId, [snapshot('CONTRACTKEY', usdc.symbol, '6')]]])
    );

    expect(result).toMatchObject({ holdingsUpdated: 1, holdingsCreated: 0 });
    expect((await holdingsOf(owner.accountId)).map((h) => [h.id, h.balance, h.externalId])).toEqual(
      [[imported.id, '6', usdc.symbol]]
    );
  });

  // The cron's read of the account leaves out a token its owner holds as scam,
  // so it never matches one; the refresh's read keeps it, so it does.
  test('the exchange cron never matches a holding of a scam token, and the refresh does', async () => {
    const exchange = await institution();
    const owner = await exchangeOwner(exchange);
    const dust = await token(fresh('XDUST'));
    await getDb()
      .update(schema.tokens)
      .set({ isScamProbability: 0.9 })
      .where(eq(schema.tokens.id, dust.id));
    const flagged = await holding(owner, { tokenId: dust.id, balance: '1', source: EXCHANGE_TAG });

    await refresh(owner, [snapshot('D', dust.symbol, '2')]);
    expect((await holdingsOf(owner.accountId)).map((h) => [h.id, h.balance])).toEqual([
      [flagged.id, '2'],
    ]);

    const result = await syncExchange(
      exchange,
      new Map([[owner.userId, [snapshot('D', dust.symbol, '3')]]])
    );
    expect(result.holdingsCreated).toBe(1);
    const rows = await holdingsOf(owner.accountId);
    expect(rows.map((h) => [h.tokenId, h.balance])).toEqual([
      [dust.id, '2'],
      [dust.id, '3'],
    ]);
  });
});

describe('the unchanged balance (exchange) and the hourly refresh of it (wallet)', () => {
  test('an unchanged exchange poll writes no checkpoint, and a wallet poll writes one every hour', async () => {
    const exchange = await institution();
    const exOwner = await exchangeOwner(exchange);
    const exToken = await token(fresh('USTAY'));
    const exRow = await holding(exOwner, {
      tokenId: exToken.id,
      balance: '7',
      source: EXCHANGE_TAG,
    });

    const chain = await institution();
    const wOwner = await walletOwner(chain);
    const wToken = await token(fresh('WSTAY'));
    const wRow = await holding(wOwner, {
      tokenId: wToken.id,
      balance: '7',
      source: WALLET_TAG,
      externalId: 'WKEY',
    });

    for (const hour of [1, 2]) {
      const capturedAt = new Date(CAPTURED.getTime() + hour * 3_600_000);
      const exResult = await syncExchange(
        exchange,
        new Map([[exOwner.userId, [snapshot('E', exToken.symbol, '7', { capturedAt })]]])
      );
      expect(exResult.holdingsUpdated).toBe(0);
      await syncWallets(
        [wOwner],
        new Map([[wOwner.userId, [snapshot('WKEY', wToken.symbol, '7', { capturedAt })]]])
      );
    }

    expect(await holdingRow(exRow.id)).toMatchObject({ balance: '7', lastUpdated: T0 });
    expect(await observationsOf(exRow.id)).toHaveLength(1);

    const wRowAfter = await holdingRow(wRow.id);
    expect(wRowAfter.balance).toBe('7');
    expect(wRowAfter.lastUpdated > T0).toBe(true);
    expect((await observationsOf(wRow.id)).map((o) => [o.balance, o.observedAt])).toEqual([
      ['7', T0],
      ['7', new Date(CAPTURED.getTime() + 3_600_000)],
      ['7', new Date(CAPTURED.getTime() + 2 * 3_600_000)],
    ]);
  });
});

describe('SyncWalletBalancesUseCase — the hourly wallet sync', () => {
  test('updates, discovers, zeroes a measured exit, and scores only the token it created', async () => {
    const chain = await institution();
    const owner = await walletOwner(chain);
    const [kept, exited] = [await token(fresh('WKEEP')), await token(fresh('WEXIT'))];
    const rows = {
      kept: await holding(owner, {
        tokenId: kept.id,
        balance: '5',
        source: WALLET_TAG,
        externalId: 'KEEPKEY',
      }),
      exited: await holding(owner, {
        tokenId: exited.id,
        balance: '7',
        source: WALLET_TAG,
        externalId: 'EXITKEY',
      }),
    };
    const newSymbol = fresh('WNEW');
    const metadataBefore = (await accountRow(owner.accountId)).metadata as Record<string, unknown>;
    const before = new Date();

    const { result, warmed } = await syncWallets(
      [owner],
      new Map([
        [owner.userId, [snapshot('KEEPKEY', kept.symbol, '6'), snapshot('NEWKEY', newSymbol, '3')]],
      ]),
      answerAll('exited')
    );
    const after = new Date();

    expect(result).toMatchObject({
      accountsSynced: 1,
      accountsFailed: 0,
      holdingsUpdated: 1,
      holdingsCreated: 1,
      holdingsRemoved: 1,
      exitedSymbols: [exited.symbol],
      errors: [],
    });
    expect((await holdingRow(rows.kept.id)).balance).toBe('6');

    // The exit is measured at the moment the chain was asked, and the zero
    // carries the sync's own provenance.
    expect((await holdingRow(rows.exited.id)).balance).toBe('0');
    const exitObs = (await observationsOf(rows.exited.id))[1]!;
    expect(within(exitObs.observedAt, before, after)).toBe(true);
    expect({ ...legacyColumns(exitObs), observedAt: null }).toEqual({
      balance: '0',
      observedAt: null,
      source: 'sync-capture',
      sourceMetadata: UPDATE_ORIGIN,
    });

    const newToken = await tokenBySymbol(newSymbol);
    const discovered = (await holdingsOf(owner.accountId)).find((h) => h.tokenId === newToken?.id);
    expect(discovered).toMatchObject({
      balance: '3',
      source: WALLET_TAG,
      arrival: 'auto_discovered',
      externalId: 'NEWKEY',
    });
    // The new token is scored and warmed; the existing ones are not.
    expect(newToken?.scamScoreVersion).not.toBeNull();
    expect((await tokenBySymbol(kept.symbol))?.scamScoreVersion).toBeNull();
    expect(warmed).toEqual([{ userId: owner.userId, tokenIds: [newToken!.id] }]);

    const metadata = (await accountRow(owner.accountId)).metadata as Record<string, unknown>;
    expect(metadata).toEqual({ ...metadataBefore, lastSync: expect.any(String) });
  });

  test('a measured exit on a hidden holding zeroes it without counting it', async () => {
    const chain = await institution();
    const owner = await walletOwner(chain);
    const [kept, exited] = [await token(fresh('WHKEEP')), await token(fresh('WHEXIT'))];
    await holding(owner, { tokenId: kept.id, balance: '5', source: WALLET_TAG, externalId: 'HK' });
    const hidden = await holding(owner, {
      tokenId: exited.id,
      balance: '7',
      source: WALLET_TAG,
      externalId: 'HX',
      isHidden: true,
    });

    const { result } = await syncWallets(
      [owner],
      new Map([[owner.userId, [snapshot('HK', kept.symbol, '5')]]]),
      answerAll('exited')
    );

    expect(await holdingRow(hidden.id)).toMatchObject({ balance: '0', isHidden: true });
    expect(result).toMatchObject({ holdingsUpdated: 1, holdingsRemoved: 0 });
  });
});

describe('RefreshAccountBalanceUseCase — a person pressing Refresh', () => {
  test('a wallet refresh updates, zeroes a measured exit and opens nothing', async () => {
    const chain = await institution();
    const owner = await walletOwner(chain);
    const [kept, exited] = [await token(fresh('RKEEP')), await token(fresh('REXIT'))];
    const rows = {
      kept: await holding(owner, {
        tokenId: kept.id,
        balance: '5',
        source: WALLET_TAG,
        externalId: 'RKEY',
      }),
      exited: await holding(owner, {
        tokenId: exited.id,
        balance: '7',
        source: WALLET_TAG,
        externalId: 'RXKEY',
      }),
    };
    const unheld = fresh('RNEW');
    const before = new Date();

    const { result } = await refresh(
      owner,
      [snapshot('RKEY', kept.symbol, '6'), snapshot('RNEWKEY', unheld, '3')],
      { probe: answerAll('exited') }
    );
    const after = new Date();

    expect(result).toMatchObject({
      accountId: owner.accountId,
      source: 'wallet',
      holdingsUpdated: 1,
      holdingsCreated: 0,
      holdingsRemoved: 1,
      syncedSymbols: [kept.symbol, unheld],
      missingSymbols: [],
      exitedSymbols: [exited.symbol],
    });
    expect((await holdingRow(rows.kept.id)).balance).toBe('6');
    expect((await holdingRow(rows.exited.id)).balance).toBe('0');
    // The token is looked up and kept; no holding is opened for it.
    expect(await tokenBySymbol(unheld)).not.toBeNull();
    expect(await holdingsOf(owner.accountId)).toHaveLength(2);

    const metadata = (await accountRow(owner.accountId)).metadata as Record<string, unknown>;
    expect(within(new Date(metadata.lastSync as string), before, after)).toBe(true);
  });

  test('an exchange refresh opens a holding for a fresh deposit', async () => {
    const exchange = await institution();
    const owner = await exchangeOwner(exchange);
    const kept = await token(fresh('RXKEEP'));
    const row = await holding(owner, { tokenId: kept.id, balance: '1', source: EXCHANGE_TAG });
    const deposit = fresh('RXNEW');

    const { result } = await refresh(owner, [
      snapshot('K', kept.symbol, '1'),
      snapshot('D', deposit, '4'),
    ]);

    expect(result).toMatchObject({
      source: 'exchange',
      holdingsUpdated: 1,
      holdingsCreated: 1,
      holdingsRemoved: 0,
    });
    // A refresh rewrites an unchanged balance, as the wallet cron does.
    expect((await observationsOf(row.id)).map((o) => o.observedAt)).toEqual([T0, CAPTURED]);
    const depositToken = await tokenBySymbol(deposit);
    expect(
      (await holdingsOf(owner.accountId)).map((h) => [h.tokenId, h.balance, h.externalId])
    ).toEqual([
      [kept.id, '1', null],
      [depositToken!.id, '4', null],
    ]);
  });

  test("F1: a refresh leaves a person's row an import wrote into as it stands and opens a sync-owned row beside it, so that row is not refreshable (R97)", async () => {
    const exchange = await institution();
    const owner = await exchangeOwner(exchange);
    const held = await token(fresh('RFONE'));
    const personsRow = await holding(owner, {
      tokenId: held.id,
      balance: '2',
      source: MANUAL_HOLDING_SOURCE,
      kind: 'feed',
    });

    const { result } = await refresh(owner, [snapshot('K', held.symbol, '9')]);

    // The provider returned the token, so the refresh reports it synced.
    expect(result).toMatchObject({
      source: 'exchange',
      holdingsUpdated: 0,
      holdingsCreated: 1,
      syncedSymbols: [held.symbol],
      missingSymbols: [],
    });
    expect(
      (await holdingsOf(owner.accountId)).map((h) => ({
        personsRow: h.id === personsRow.id,
        source: h.source,
        kind: h.kind,
        balance: h.balance,
      }))
    ).toEqual([
      { personsRow: true, source: MANUAL_HOLDING_SOURCE, kind: 'feed', balance: '2' },
      { personsRow: false, source: EXCHANGE_TAG, kind: 'feed', balance: '9' },
    ]);
    expect(await observationsOf(personsRow.id)).toHaveLength(1);

    // Which is why the answer the button and the refusal read is no.
    expect(
      await Container.get(BalanceRefreshabilityService).forHolding(owner.userId, personsRow)
    ).toBe('sync-cannot-write');
  });

  test('an empty answer writes nothing and reports every holding missing', async () => {
    const exchange = await institution();
    const owner = await exchangeOwner(exchange);
    const kept = await token(fresh('REMPTY'));
    const row = await holding(owner, { tokenId: kept.id, balance: '1', source: EXCHANGE_TAG });
    const metadataBefore = (await accountRow(owner.accountId)).metadata;

    const { result } = await refresh(owner, []);

    expect(result).toMatchObject({ holdingsUpdated: 0, missingSymbols: [kept.symbol] });
    expect(await observationsOf(row.id)).toHaveLength(1);
    expect((await accountRow(owner.accountId)).metadata).toEqual(metadataBefore);
  });
});

describe('legacy history', () => {
  // The clock is held still, so every "now" is NOW and the readings are exact.
  test('golden history: an exchange update, create and zero, and a wallet exit', async () => {
    const exchange = await institution();
    const exOwner = await exchangeOwner(exchange);
    const [updated, zeroed] = [await token(fresh('GUP')), await token(fresh('GZERO'))];
    const exRows = {
      updated: await holding(exOwner, { tokenId: updated.id, balance: '10', source: EXCHANGE_TAG }),
      zeroed: await holding(exOwner, { tokenId: zeroed.id, balance: '5', source: EXCHANGE_TAG }),
    };
    const createdSymbol = fresh('GNEW');

    const chain = await institution();
    const wOwner = await walletOwner(chain);
    const [wKept, wExited] = [await token(fresh('GWKEEP')), await token(fresh('GWEXIT'))];
    await holding(wOwner, {
      tokenId: wKept.id,
      balance: '1',
      source: WALLET_TAG,
      externalId: 'GWK',
    });
    const wExit = await holding(wOwner, {
      tokenId: wExited.id,
      balance: '4',
      source: WALLET_TAG,
      externalId: 'GWX',
    });

    setSystemTime(NOW);
    await syncExchange(
      exchange,
      new Map([
        [exOwner.userId, [snapshot('U', updated.symbol, '12'), snapshot('C', createdSymbol, '3')]],
      ])
    );
    await syncWallets(
      [wOwner],
      new Map([[wOwner.userId, [snapshot('GWK', wKept.symbol, '1')]]]),
      answerAll('exited')
    );
    const createdToken = await tokenBySymbol(createdSymbol);
    const createdRow = (await holdingsOf(exOwner.accountId)).find(
      (h) => h.tokenId === createdToken?.id
    );
    expect(createdRow).toBeDefined();

    const mid = (a: Date, b: Date) => new Date((a.getTime() + b.getTime()) / 2);
    const instants = [
      new Date(T0.getTime() - DAY_MS),
      T0,
      mid(T0, CAPTURED),
      CAPTURED,
      mid(CAPTURED, NOW),
      NOW,
    ];
    const readings = await captureHistory(
      [exRows.updated.id, exRows.zeroed.id, createdRow!.id, wExit.id],
      instants
    );
    expect(readings.map((r) => r.balance)).toEqual(GOLDEN);
  });
});

/**
 * Today's readings, holding-major: the exchange's updated, zeroed and created
 * holdings, then the wallet's exit, at the six instants. A zero's unexplained
 * drop is spread from its last observation to the zero, which is why the
 * zero's instant is part of the figure.
 */
const GOLDEN: Array<string | null> = [
  ...['10', '10', '11', '12', '12', '12'],
  ...[
    '5',
    '5',
    '3.027210884353741496598639456',
    '1.054421768707482993197278912',
    '0.5272108843537414965986394558',
    '0',
  ],
  ...['3', '3', '3', '3', '3', '3'],
  ...[
    '4',
    '4',
    '2.421768707482993197278911565',
    '0.8435374149659863945578231293',
    '0.4217687074829931972789115646',
    '0',
  ],
];

const inputsOf = (accountId: string) =>
  getDb()
    .select()
    .from(schema.feedInputs)
    .where(eq(schema.feedInputs.accountId, accountId))
    .orderBy(asc(schema.feedInputs.source));

const windowsOf = (inputId: string) =>
  getDb()
    .select()
    .from(schema.feedInputWindows)
    .where(eq(schema.feedInputWindows.inputId, inputId));

/** What a write labels an observation with (A1's columns). */
const labels = (o: typeof schema.holdingBalanceObservations.$inferSelect) => ({
  role: o.role,
  authority: o.authority,
  inputId: o.inputId,
  cause: o.cause,
});

/**
 * `run`, while the database refuses one holding's UPDATE whichever path writes
 * it: a trigger, so the old write and the new one meet the same error. Both
 * objects are dropped however far their creation got.
 */
async function whileRefusingUpdatesOf<T>(holdingId: string, run: () => Promise<T>): Promise<T> {
  const name = `zz_refuse_${holdingId.replace(/-/g, '')}`;
  try {
    await getDb().execute(
      sql.raw(
        `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'zz refused'; END $$`
      )
    );
    await getDb().execute(
      sql.raw(
        `CREATE TRIGGER ${name} BEFORE UPDATE ON holdings FOR EACH ROW WHEN (OLD.id = '${holdingId}') EXECUTE FUNCTION ${name}()`
      )
    );
    return await run();
  } finally {
    await getDb().execute(sql.raw(`DROP TRIGGER IF EXISTS ${name} ON holdings`));
    await getDb().execute(sql.raw(`DROP FUNCTION IF EXISTS ${name}()`));
  }
}

const statementInput = (owner: Owner) =>
  getDb()
    .insert(schema.feedInputs)
    .values({ userId: owner.userId, accountId: owner.accountId, source: 'statement' });

describe('the balance syncs through FeedIngestService (A2 Task 16)', () => {
  // R37's shape, per account: one SQL error used to abort the cron's one
  // transaction under every account after it (25P02), and lose them all.
  test('one failing account leaves the other accounts written', async () => {
    const exchange = await institution();
    const owner = await exchangeOwner(exchange);
    const second = await getDb().transaction((tx) =>
      makeAccount(tx, {
        userId: owner.userId,
        institutionId: exchange.id,
        metadata: { accountType: 'MARGIN' },
      })
    );
    const coin = await token(fresh('FCOIN'));
    const doomed = await holding(owner, { tokenId: coin.id, balance: '1', source: EXCHANGE_TAG });
    const landed = await holding(
      { userId: owner.userId, accountId: second.id },
      { tokenId: coin.id, balance: '1', source: EXCHANGE_TAG }
    );
    const metadataBefore = (await accountRow(owner.accountId)).metadata;

    const result = await whileRefusingUpdatesOf(doomed.id, () =>
      syncExchange(exchange, new Map([[owner.userId, [snapshot('C', coin.symbol, '2')]]]))
    );

    expect(result).toMatchObject({ accountsSynced: 1, accountsFailed: 1, holdingsUpdated: 1 });
    expect(result.errors.map((e) => e.accountId)).toEqual([owner.accountId]);
    expect(result.errors[0]?.error).not.toMatch(/25P02|current transaction is aborted/);
    expect((await holdingRow(landed.id)).balance).toBe('2');
    expect((await accountRow(second.id)).metadata).toMatchObject({ lastSync: expect.any(String) });
    // The failed account wrote nothing: no balance, no observation, no input,
    // and no fresh `lastSync` over balances that rolled back.
    expect(await holdingRow(doomed.id)).toMatchObject({ balance: '1', lastUpdated: T0 });
    expect(await observationsOf(doomed.id)).toHaveLength(1);
    expect(await inputsOf(owner.accountId)).toEqual([]);
    expect((await accountRow(owner.accountId)).metadata).toEqual(metadataBefore);
  });

  test("each sync's balances belong to the account's provider or wallet input, with one window a fetch", async () => {
    const exchange = await institution();
    const exOwner = await exchangeOwner(exchange);
    const exToken = await token(fresh('IEX'));
    const exRow = await holding(exOwner, {
      tokenId: exToken.id,
      balance: '1',
      source: EXCHANGE_TAG,
    });
    await syncExchange(exchange, new Map([[exOwner.userId, [snapshot('E', exToken.symbol, '2')]]]));
    const [providerInput, ...otherProviderInputs] = await inputsOf(exOwner.accountId);
    expect([providerInput?.source, otherProviderInputs]).toEqual([
      providerInputSource(exchange.name),
      [],
    ]);
    expect(labels((await observationsOf(exRow.id))[1]!)).toEqual({
      role: 'checkpoint',
      authority: 'provider',
      inputId: providerInput!.id,
      cause: null,
    });
    expect(await windowsOf(providerInput!.id)).toHaveLength(1);

    const chain = await institution();
    const wOwner = await walletOwner(chain);
    const [kept, exited] = [await token(fresh('IWK')), await token(fresh('IWX'))];
    const keptRow = await holding(wOwner, {
      tokenId: kept.id,
      balance: '5',
      source: WALLET_TAG,
      externalId: 'IWKKEY',
    });
    const exitRow = await holding(wOwner, {
      tokenId: exited.id,
      balance: '7',
      source: WALLET_TAG,
      externalId: 'IWXKEY',
    });
    await syncWallets(
      [wOwner],
      new Map([[wOwner.userId, [snapshot('IWKKEY', kept.symbol, '6')]]]),
      answerAll('exited')
    );
    const [walletInput, ...otherWalletInputs] = await inputsOf(wOwner.accountId);
    expect([walletInput?.source, otherWalletInputs]).toEqual([walletInputSource('1'), []]);
    const checkpoint = (await observationsOf(keptRow.id))[1]!;
    const exitZero = (await observationsOf(exitRow.id))[1]!;
    for (const observation of [checkpoint, exitZero]) {
      expect(labels(observation)).toEqual({
        role: 'checkpoint',
        authority: 'provider',
        inputId: walletInput!.id,
        cause: null,
      });
    }
    expect(await windowsOf(walletInput!.id)).toHaveLength(1);
  });

  test('every write is labelled as the backfill would label it', async () => {
    const exchange = await institution();
    const exOwner = await exchangeOwner(exchange);
    const [up, gone] = [await token(fresh('LUP')), await token(fresh('LGONE'))];
    await holding(exOwner, { tokenId: up.id, balance: '1', source: EXCHANGE_TAG });
    await holding(exOwner, { tokenId: gone.id, balance: '5', source: EXCHANGE_TAG });

    const chain = await institution();
    const wOwner = await walletOwner(chain);
    const [kept, exited] = [await token(fresh('LWK')), await token(fresh('LWX'))];
    await holding(wOwner, { tokenId: kept.id, balance: '5', source: WALLET_TAG, externalId: 'LK' });
    await holding(wOwner, {
      tokenId: exited.id,
      balance: '7',
      source: WALLET_TAG,
      externalId: 'LX',
    });

    for (const { userId } of [exOwner, wOwner]) {
      await Container.get(FoundationClassificationService).classify({ apply: true, userId });
      await expectLabelsSettled(userId);
    }

    await syncExchange(
      exchange,
      new Map([
        [exOwner.userId, [snapshot('U', up.symbol, '2'), snapshot('N', fresh('LNEW'), '3')]],
      ])
    );
    await syncWallets(
      [wOwner],
      new Map([
        [wOwner.userId, [snapshot('LK', kept.symbol, '6'), snapshot('LN', fresh('LWN'), '1')]],
      ]),
      answerAll('exited')
    );
    await refresh(exOwner, [snapshot('U', up.symbol, '4')]);

    await expectLabelsSettled(exOwner.userId);
    await expectLabelsSettled(wOwner.userId);
  });

  // One user's two wallets are written in the order they are listed, so the
  // second lands after the first has failed: in one transaction for both, it
  // would have met 25P02 and been lost with it.
  test('one failing wallet account leaves the accounts after it written', async () => {
    const chain = await institution();
    const first = await walletOwner(chain);
    const second = await walletOwner(chain, first);
    const coin = await token(fresh('WFAIL'));
    const doomed = await holding(first, {
      tokenId: coin.id,
      balance: '1',
      source: WALLET_TAG,
      externalId: 'WFKEY',
    });
    const landed = await holding(second, {
      tokenId: coin.id,
      balance: '1',
      source: WALLET_TAG,
      externalId: 'WFKEY',
    });
    const metadataBefore = (await accountRow(first.accountId)).metadata;

    const { result } = await whileRefusingUpdatesOf(doomed.id, () =>
      syncWallets([first, second], new Map([[first.userId, [snapshot('WFKEY', coin.symbol, '2')]]]))
    );

    // As today, a wallet account whose write fails is logged and not counted.
    expect(result).toMatchObject({
      accountsSynced: 1,
      accountsFailed: 0,
      holdingsUpdated: 1,
      errors: [],
    });
    expect((await holdingRow(landed.id)).balance).toBe('2');
    expect((await observationsOf(landed.id)).map((o) => o.balance)).toEqual(['1', '2']);
    expect((await accountRow(second.accountId)).metadata).toMatchObject({
      lastSync: expect.any(String),
    });
    expect(await holdingRow(doomed.id)).toMatchObject({ balance: '1', lastUpdated: T0 });
    expect(await observationsOf(doomed.id)).toHaveLength(1);
    expect(await inputsOf(first.accountId)).toEqual([]);
    expect((await accountRow(first.accountId)).metadata).toEqual(metadataBefore);
  });

  // R69 (I-1, a named D-1 exception): Kraken lists spot and earn balances
  // apart (`XXBT`, `XBT.F`) and both resolve to one token. One holding opens,
  // at the row sent last on a tie and at the later instant otherwise, and it
  // stays there run after run. Today a first sync opened two, and later runs
  // left one stale and flipped the other between the two rows.
  test('one answer naming one token twice opens one holding, at the last sent or the later instant, and keeps it', async () => {
    const exchange = await institution();
    const owner = await exchangeOwner(exchange);
    const [tied, later] = [fresh('DTIE'), fresh('DLATE')];
    const answerAt = (at: Date) => [
      snapshot('XXBT', tied, '0.5', { capturedAt: at }),
      snapshot('XBT.F', tied, '1.5', { capturedAt: at }),
      snapshot('XETH', later, '5', { capturedAt: new Date(at.getTime() + 60_000) }),
      snapshot('ETH.F', later, '3', { capturedAt: at }),
    ];

    const runs: Array<{ created: number; tied: string[]; later: string[] }> = [];
    for (const hour of [0, 1, 2]) {
      const result = await syncExchange(
        exchange,
        new Map([[owner.userId, answerAt(new Date(CAPTURED.getTime() + hour * 3_600_000))]])
      );
      const rows = await holdingsOf(owner.accountId);
      const balancesOf = async (symbol: string) => {
        const tokenId = (await tokenBySymbol(symbol))?.id;
        return rows.filter((h) => h.tokenId === tokenId).map((h) => h.balance);
      };
      runs.push({
        created: result.holdingsCreated,
        tied: await balancesOf(tied),
        later: await balancesOf(later),
      });
    }

    expect(runs).toEqual([
      { created: 2, tied: ['1.5'], later: ['5'] },
      { created: 0, tied: ['1.5'], later: ['5'] },
      { created: 0, tied: ['1.5'], later: ['5'] },
    ]);
  });

  // R70: an account fed only by statements is routed as today, by its
  // metadata, and refused only where today threw: no active credential.
  test('refresh of a statement-only account with no credential is refused as unsupported', async () => {
    const exchange = await institution();
    const owner = await exchangeOwner(exchange, { credential: false });
    const coin = await token(fresh('SCOIN'));
    const row = await holding(owner, { tokenId: coin.id, balance: '1', source: 'statement-csv' });
    await statementInput(owner);
    const metadataBefore = (await accountRow(owner.accountId)).metadata;

    const refused = await refresh(owner, [snapshot('S', coin.symbol, '9')]);

    expect(refused.fetched).toBe(0);
    expect(refused.result).toMatchObject({ source: 'unsupported', holdingsUpdated: 0 });
    expect(await holdingsOf(owner.accountId)).toHaveLength(1);
    expect(await observationsOf(row.id)).toHaveLength(1);
    expect((await inputsOf(owner.accountId)).map((i) => i.source)).toEqual(['statement']);
    expect((await accountRow(owner.accountId)).metadata).toEqual(metadataBefore);
  });

  // The same account with a credential, refreshed as today, under the
  // provider input the cron would write for it (R67).
  test('refresh of a statement-only account with a credential is refreshed', async () => {
    const exchange = await institution();
    const owner = await exchangeOwner(exchange);
    const coin = await token(fresh('SCRED'));
    const row = await holding(owner, { tokenId: coin.id, balance: '1', source: 'statement-csv' });
    await statementInput(owner);

    const refreshed = await refresh(owner, [snapshot('S', coin.symbol, '9')]);

    expect(refreshed.fetched).toBe(1);
    expect(refreshed.result).toMatchObject({ source: 'exchange', holdingsUpdated: 1 });
    expect((await holdingRow(row.id)).balance).toBe('9');
    const inputs = await inputsOf(owner.accountId);
    expect(inputs.map((i) => i.source)).toEqual([providerInputSource(exchange.name), 'statement']);
    expect(labels((await observationsOf(row.id))[1]!).inputId).toBe(inputs[0]!.id);
  });

  // R70: a wallet input decides the path and the input written under, even
  // where the account's metadata, which names no chain here, would derive
  // another source.
  test('a refresh routed by a wallet-class input writes under that input', async () => {
    const chain = await institution();
    const owner = await walletOwner(chain);
    await getDb()
      .update(schema.accounts)
      .set({
        metadata: { userWalletId: owner.wallet.id, walletAddress: owner.wallet.walletAddress },
      })
      .where(eq(schema.accounts.id, owner.accountId));
    const [walletInput] = await getDb()
      .insert(schema.feedInputs)
      .values({ userId: owner.userId, accountId: owner.accountId, source: walletInputSource('1') })
      .returning();
    const coin = await token(fresh('RWIN'));
    const row = await holding(owner, {
      tokenId: coin.id,
      balance: '5',
      source: WALLET_TAG,
      externalId: 'RWKEY',
    });

    const { result, fetched } = await refresh(owner, [snapshot('RWKEY', coin.symbol, '6')]);

    expect(fetched).toBe(1);
    expect(result).toMatchObject({ source: 'wallet', holdingsUpdated: 1, holdingsCreated: 0 });
    expect((await holdingRow(row.id)).balance).toBe('6');
    expect((await inputsOf(owner.accountId)).map((i) => i.id)).toEqual([walletInput!.id]);
    expect(labels((await observationsOf(row.id))[1]!).inputId).toBe(walletInput!.id);
  });
});
