/**
 * The hourly run's cadence and its tokens (foundation A3, Task 8; D-4, D-6).
 *
 * The run reads no stored row before it asks, stamps every row it writes at
 * its own instant, and prices every held token a provider can price, every
 * currency in use and the FX baseline, never USD. The held tokens it does not
 * price still have their vaults recalculated and their holders told.
 *
 * It reads and writes through the global connection, so every row here is
 * committed and removed after each test. The run prices the hubs and the FX
 * baseline, so each test makes its own token for every one of them but USD,
 * and the resolver finds those: a killed run leaves the seeded catalogue as it
 * was. The currencies in use are read from the real tables, so a currency
 * another row of the database puts in use is priced as well; its rows carry
 * this file's two sources and are deleted by them.
 */

import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { Holding, NewTokenPrice, Token, User } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type { CurrentPriceProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { ProviderContext } from '@scani/providers/core/types';
import { type RealTimeEvent, RedisRealtimeUpdatesService } from '@scani/realtime';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingQueryService } from '../../src/services/holdings/HoldingQueryService';
import { PriceReader } from '../../src/services/pricing/PriceReader';
import { PriceWarmupService } from '../../src/services/pricing/PriceWarmupService';
import { PricingProviderRouter } from '../../src/services/pricing/PricingProviderRouter';
import { PricingService } from '../../src/services/pricing/PricingService';
import {
  FX_BASELINE,
  PRICE_HUBS,
  type PriceHub,
  priceHubKey,
} from '../../src/services/pricing/price-hubs';
import { VaultService } from '../../src/services/users/VaultService';
import {
  type UpdateTokenPricesResult,
  UpdateTokenPricesUseCase,
} from '../../src/use-cases/UpdateTokenPricesUseCase';
import { committedRows, dropPricesOf } from '../../test/helpers/committed-rows';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';
import { withHubs } from '../../test/helpers/price-hubs';

restoreContainerAfterAll();

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const CRYPTO_SOURCE = 'cadence-test-coingecko';
const FX_SOURCE = 'cadence-test-frankfurter';
/** The seven fiat currencies of the FX baseline. Its eighth token is the crypto USDT. */
const BASELINE_FIAT = ['EUR', 'GBP', 'JPY', 'RUB', 'CHF', 'CAD', 'AUD'];
/** Every hub and FX baseline currency but USD, which the run prices in and never prices. */
const HUBS_PRICED: readonly PriceHub[] = [
  ...new Map(
    [...PRICE_HUBS, ...FX_BASELINE]
      .filter(({ symbol }) => symbol !== 'USD')
      .map((priced) => [priceHubKey(priced), priced])
  ).values(),
];

const rows = committedRows();
/** This test's own token for each of `HUBS_PRICED`, by symbol. */
const hubs = new Map<string, Token>();

const realFetch = globalThis.fetch;
let fetched: string[] = [];

// No test here may reach an upstream. The providers are stubs in the registry;
// the converter's rate fetch is the one path that could.
beforeEach(async () => {
  fetched = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(input instanceof Request ? input.url : String(input));
    throw new Error('a test of the hourly run reached the network');
  }) as unknown as typeof fetch;
  hubs.clear();
  for (const { symbol, typeCode } of HUBS_PRICED) hubs.set(symbol, await commitToken(typeCode));
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  setSystemTime();
  await getDb()
    .delete(schema.tokenPrices)
    .where(inArray(schema.tokenPrices.source, [CRYPTO_SOURCE, FX_SOURCE]));
  await dropPricesOf(rows.tokens);
  await rows.drop();
  expect(fetched).toEqual([]);
});

type TypeCode = 'crypto' | 'fiat' | 'stock' | 'private-company' | 'other';

async function typeId(code: TypeCode): Promise<string> {
  const [type] = await getDb()
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, code));
  if (!type) throw new Error(`the ${code} token type is seeded by migration`);
  return type.id;
}

/** The seeded fiat token of a symbol: the fiat type and no market segment. */
async function fiat(symbol: string): Promise<Token> {
  const [token] = await getDb()
    .select()
    .from(schema.tokens)
    .where(
      and(
        eq(schema.tokens.symbol, symbol),
        eq(schema.tokens.typeId, await typeId('fiat')),
        isNull(schema.tokens.marketSegment)
      )
    );
  if (!token) throw new Error(`the fiat ${symbol} is seeded by migration`);
  return token;
}

async function commitToken(
  code: TypeCode = 'crypto',
  marketSegment: string | null = null
): Promise<Token> {
  const type = await typeId(code);
  const token = await getDb().transaction((tx) =>
    makeToken(tx, { typeId: type, ...(marketSegment ? { marketSegment } : {}) })
  );
  rows.tokens.push(token.id);
  return token;
}

/** This test's token for a hub or FX baseline currency. */
function hub(symbol: string): Token {
  const token = hubs.get(symbol);
  if (!token) throw new Error(`${symbol} is not a hub or FX baseline currency`);
  return token;
}

async function commitUser(baseCurrencyId: string | null): Promise<User> {
  const user = await getDb().transaction((tx) => makeUser(tx, { baseCurrencyId }));
  rows.users.push(user.id);
  return user;
}

/** The user's holding of `balance` of `tokenId`, at a fresh institution. */
function commitHolding(userId: string, tokenId: string, balance = '100'): Promise<Holding> {
  return getDb().transaction(async (tx) => {
    // Upserted onto a seeded code, so no institution type outlives the test.
    const type = await makeInstitutionType(tx, { code: 'crypto_exchange' });
    const institution = await makeInstitution(tx, { typeId: type.id });
    rows.institutions.push(institution.id);
    const account = await makeAccount(tx, { userId, institutionId: institution.id });
    return makeHolding(tx, { userId, accountId: account.id, tokenId, balance });
  });
}

/** The user's vault in `currencyId`, holding all of each of `holdings`. Returns its id. */
async function commitVault(
  userId: string,
  currencyId: string,
  holdings: Holding[]
): Promise<string> {
  const [vault] = await getDb()
    .insert(schema.vaults)
    .values({ userId, name: 'A vault', targetAmount: '1000', currencyId, color: '#3b82f6' })
    .returning();
  if (!vault) throw new Error('vault insert failed');
  await getDb()
    .insert(schema.vaultHoldings)
    .values(
      holdings.map((holding) => ({ vaultId: vault.id, holdingId: holding.id, percentage: 100 }))
    );
  return vault.id;
}

async function currentAmountOf(vaultId: string): Promise<string | undefined> {
  const [vault] = await getDb()
    .select({ currentAmount: schema.vaults.currentAmount })
    .from(schema.vaults)
    .where(eq(schema.vaults.id, vaultId));
  return vault?.currentAmount;
}

const counts = ({ tokensFound, tokensUpdated, tokensFailed }: UpdateTokenPricesResult) => ({
  tokensFound,
  tokensUpdated,
  tokensFailed,
});

async function commitPrices(prices: NewTokenPrice[]): Promise<void> {
  await getDb().insert(schema.tokenPrices).values(prices);
}

function storedFor(tokenId: string, baseTokenId: string) {
  return getDb()
    .select()
    .from(schema.tokenPrices)
    .where(
      and(eq(schema.tokenPrices.tokenId, tokenId), eq(schema.tokenPrices.baseTokenId, baseTokenId))
    )
    .orderBy(asc(schema.tokenPrices.timestamp));
}

/** Every stored row of these tokens, in any base and from any source. */
function pricesOf(tokenIds: readonly string[]) {
  return getDb()
    .select()
    .from(schema.tokenPrices)
    .where(inArray(schema.tokenPrices.tokenId, [...tokenIds]));
}

/** Every row a provider of this file wrote, for any token. */
function writtenByProviders() {
  return getDb()
    .select()
    .from(schema.tokenPrices)
    .where(inArray(schema.tokenPrices.source, [CRYPTO_SOURCE, FX_SOURCE]));
}

type ProviderKey = 'coingecko' | 'frankfurter';

interface Ask {
  provider: ProviderKey;
  tokenId: string;
  baseId: string;
}

type Answer = (token: Token, ctx: ProviderContext) => { price: string; timestamp: Date } | null;

/** As CoinGecko stamps a quote: at the instant it was asked for. */
const atTheInstantAsked =
  (price: string): Answer =>
  (_token, ctx) => ({ price, timestamp: ctx.timestamp ?? new Date() });

/**
 * The hourly run over the real pricing stack and two providers: CoinGecko for
 * crypto, answering 100, and Frankfurter for fiat, answering 2, unless
 * `answers` says otherwise. Each ask is recorded, and so is each vault the run
 * recalculates and each realtime event it sends.
 *
 * The run's held tokens are the ones given: the run is global, so the real
 * table would make every assertion a fact about whatever else the database
 * holds.
 */
function hourlyRun(held: Token[], answers: Partial<Record<ProviderKey, Answer>> = {}) {
  const asks: Ask[] = [];
  const provider = (key: ProviderKey, source: string, answer: Answer): CurrentPriceProvider => ({
    providerKey: key,
    capabilities: ['current-price'],
    canPrice: () => true,
    fetchCurrentPrice: async (token, ctx) => {
      asks.push({ provider: key, tokenId: token.id, baseId: ctx.baseCurrency.id });
      const quote = answer(token, ctx);
      return (
        quote && {
          barDay: null,
          tokenId: token.id,
          baseTokenId: ctx.baseCurrency.id,
          ...quote,
          source,
        }
      );
    },
  });
  const registry = new ProviderRegistry();
  registry.register(
    provider('coingecko', CRYPTO_SOURCE, answers.coingecko ?? atTheInstantAsked('100'))
  );
  registry.register(
    provider('frankfurter', FX_SOURCE, answers.frankfurter ?? atTheInstantAsked('2'))
  );
  Container.set(ProviderRegistry, registry);
  withHubs(hubs);
  const router = new PricingProviderRouter();
  Container.set(PricingProviderRouter, router);
  Container.set(PricingService, new PricingService());
  Container.set(HoldingQueryService, {
    getDistinctTokenIds: async () => held.map((token) => token.id),
  } as unknown as HoldingQueryService);
  const vaults = new VaultService();
  Container.set(VaultService, vaults);
  const recalculated = spyOn(vaults, 'recalculateVaultAmount');
  const events: Array<Omit<RealTimeEvent, 'timestamp'>> = [];
  Container.set(RedisRealtimeUpdatesService, {
    broadcast: (event: Omit<RealTimeEvent, 'timestamp'>) => {
      events.push(event);
    },
  } as unknown as RedisRealtimeUpdatesService);
  const routed = spyOn(router, 'routeAndFetch');
  return {
    useCase: new UpdateTokenPricesUseCase(),
    asks,
    asksFor: (tokenId: string) => asks.filter((ask) => ask.tokenId === tokenId),
    /** The token ids of each ask the run made of the router, in order. */
    routedIds: () => routed.mock.calls.map(([tokens]) => tokens.map((token) => token.id)),
    /** The id of each vault the run recalculated. */
    recalculatedVaults: () => recalculated.mock.calls.map(([vaultId]) => vaultId),
    events,
  };
}

describe('the hourly run always fetches', () => {
  test('two runs 59 minutes apart both ask the providers', async () => {
    // Off the 23:00Z hour, where FX is asked once a day (SC-1603).
    setSystemTime(new Date(Math.floor(Date.now() / DAY) * DAY + 12 * HOUR));
    const usd = await fiat('USD');
    const eur = hub('EUR');
    const token = await commitToken();
    const { useCase, asksFor, routedIds } = hourlyRun([token]);

    await useCase.execute();
    const [first] = await storedFor(token.id, usd.id);
    if (!first) throw new Error('the first run wrote no row');
    setSystemTime(new Date(first.timestamp.getTime() + 59 * MINUTE));
    await useCase.execute();

    expect(asksFor(token.id)).toEqual([
      { provider: 'coingecko', tokenId: token.id, baseId: usd.id },
      { provider: 'coingecko', tokenId: token.id, baseId: usd.id },
    ]);
    // EUR is asked by the first run, never having been priced, and deferred
    // by the second: FX is read once a day, in the 23:00Z hour (SC-1603).
    expect(asksFor(eur.id)).toHaveLength(1);
    // One ask of the router per run, carrying every token due that run.
    const routed = routedIds();
    expect(routed).toHaveLength(2);
    for (const ids of routed) {
      expect(ids).toContain(token.id);
      expect(ids).not.toContain(usd.id);
    }
    expect(routed[0]).toContain(eur.id);
    expect(routed[1]).not.toContain(eur.id);
    const stored = await storedFor(token.id, usd.id);
    expect(stored).toHaveLength(2);
    const apart = (stored[1]?.timestamp.getTime() ?? 0) - first.timestamp.getTime();
    expect(apart).toBeGreaterThanOrEqual(59 * MINUTE);
    expect(apart).toBeLessThan(HOUR);
  });

  test('CONTROL: the import warm-up within the hour asks nobody', async () => {
    const usd = await fiat('USD');
    const user = await commitUser(usd.id);
    const token = await commitToken();
    const { useCase, asksFor } = hourlyRun([token]);
    await useCase.execute();
    const [first] = await storedFor(token.id, usd.id);
    if (!first) throw new Error('the run wrote no row');
    expect(asksFor(token.id)).toHaveLength(1);

    setSystemTime(new Date(first.timestamp.getTime() + 59 * MINUTE));
    const prices = await new PriceWarmupService().warm({ userId: user.id, tokenIds: [token.id] });

    expect(prices.get(token.id)).toBe('100');
    expect(asksFor(token.id)).toHaveLength(1);
    expect(await storedFor(token.id, usd.id)).toHaveLength(1);
  });

  // Frankfurter dates its latest rate by the ECB day at 00:00Z. Stored at that
  // stamp, the row never fell inside the warm-up's hour, so every warm-up asked.
  test('the import warm-up within the hour reuses the run’s row from a provider that dates its quote by an old day', async () => {
    const usd = await fiat('USD');
    const user = await commitUser(usd.id);
    // Held, so the run asks Frankfurter for it.
    const currency = await commitToken('fiat');
    const ecbDay = new Date(Math.floor(Date.now() / DAY) * DAY - DAY);
    const { useCase, asksFor } = hourlyRun([currency], {
      frankfurter: () => ({ price: '2', timestamp: ecbDay }),
    });
    const runStarted = Date.now();
    await useCase.execute();
    expect(asksFor(currency.id)).toHaveLength(1);

    // From the run's start, not from the stored row: a row stamped at the ECB
    // day would put the clock beside it.
    setSystemTime(new Date(runStarted + 59 * MINUTE));
    const prices = await new PriceWarmupService().warm({
      userId: user.id,
      tokenIds: [currency.id],
    });

    expect(prices.get(currency.id)).toBe('2');
    expect(asksFor(currency.id)).toHaveLength(1);
    expect(await storedFor(currency.id, usd.id)).toHaveLength(1);
  });

  test('one run stamps every provider’s row at the run’s instant', async () => {
    const coin = await commitToken();
    // Held, so the run asks Frankfurter for it whatever its other currencies are.
    const currency = await commitToken('fiat');
    const threeHoursAgo = new Date(Date.now() - 3 * HOUR);
    // As Frankfurter dates its latest rate: an ECB day, at 00:00Z.
    const ecbDay = new Date(Math.floor(Date.now() / DAY) * DAY - DAY);
    const { useCase } = hourlyRun([coin, currency], {
      coingecko: () => ({ price: '100', timestamp: threeHoursAgo }),
      frankfurter: () => ({ price: '2', timestamp: ecbDay }),
    });

    const before = Date.now();
    await useCase.execute();
    const after = Date.now();

    const written = await writtenByProviders();
    expect(new Set(written.map((r) => r.source))).toEqual(new Set([CRYPTO_SOURCE, FX_SOURCE]));
    expect(written.map((r) => r.tokenId)).toContain(coin.id);
    expect(written.map((r) => r.tokenId)).toContain(currency.id);
    const stamps = [...new Set(written.map((r) => r.timestamp.getTime()))];
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toBeGreaterThanOrEqual(before);
    expect(stamps[0]).toBeLessThanOrEqual(after);
    expect(new Set(written.map((r) => r.granularity))).toEqual(new Set(['intraday']));
  });

  test('an hour in which every provider fails writes nothing, and the last reading still prices the token', async () => {
    const usd = await fiat('USD');
    const token = await commitToken();
    // What the run an hour earlier left.
    const lastRun = new Date(Date.now() - 59 * MINUTE);
    await commitPrices([
      {
        tokenId: token.id,
        baseTokenId: usd.id,
        price: '100',
        timestamp: lastRun,
        source: CRYPTO_SOURCE,
      },
    ]);
    const { useCase, asksFor } = hourlyRun([token], {
      coingecko: () => null,
      frankfurter: () => null,
    });

    const result = await useCase.execute();

    expect(asksFor(token.id)).toEqual([
      { provider: 'coingecko', tokenId: token.id, baseId: usd.id },
    ]);
    // Of every token the test made, the hubs and the baseline included, the one
    // row in any base and from any source is the one the last run left.
    const stored = await pricesOf(rows.tokens);
    expect(
      stored.map((r) => [r.tokenId, r.baseTokenId, r.price, r.source, r.timestamp.getTime()])
    ).toEqual([[token.id, usd.id, '100', CRYPTO_SOURCE, lastRun.getTime()]]);
    expect(result.errors.map((e) => e.tokenId)).not.toContain(token.id);
    const read = await new PriceReader().at([token.id], usd.id, new Date());
    expect(read.get(token.id)?.price.toString()).toBe('100');
  });
});

describe('the hourly run’s tokens', () => {
  test('a base currency nobody holds is priced by the run', async () => {
    const usd = await fiat('USD');
    const base = await commitToken('fiat');
    await commitUser(base.id);
    // A user banking in USD puts USD among the currencies in use: it is still never priced.
    await commitUser(usd.id);
    const { useCase, asks, asksFor } = hourlyRun([]);

    await useCase.execute();

    expect(asksFor(base.id)).toEqual([
      { provider: 'frankfurter', tokenId: base.id, baseId: usd.id },
    ]);
    expect((await storedFor(base.id, usd.id)).map((r) => [r.price, r.source])).toEqual([
      ['2', FX_SOURCE],
    ]);
    expect(asks.filter((ask) => ask.tokenId === usd.id)).toEqual([]);
    expect(asks.filter((ask) => ask.baseId !== usd.id)).toEqual([]);
  });

  test('a manual price in CHF with no CHF holder: the run writes CHF against USD', async () => {
    const usd = await fiat('USD');
    const chf = hub('CHF');
    // CHF is also in the baseline, so a currency outside it is what shows the rule.
    const quote = await commitToken('fiat');
    const company = await commitToken('private-company');
    const user = await commitUser(usd.id);
    await commitHolding(user.id, company.id);
    // CONTROL: the currency of a manual price on a token nobody holds is not in use.
    const unheld = await commitToken('private-company');
    const unheldQuote = await commitToken('fiat');
    const monthAgo = new Date(Date.now() - 30 * DAY);
    await commitPrices([
      {
        tokenId: company.id,
        baseTokenId: chf.id,
        price: '50',
        timestamp: monthAgo,
        source: 'manual',
      },
      {
        tokenId: company.id,
        baseTokenId: quote.id,
        price: '40',
        timestamp: new Date(monthAgo.getTime() - DAY),
        source: 'manual',
      },
      {
        tokenId: unheld.id,
        baseTokenId: unheldQuote.id,
        price: '9',
        timestamp: monthAgo,
        source: 'manual',
      },
    ]);
    const { useCase, asksFor } = hourlyRun([company]);

    await useCase.execute();

    expect(asksFor(chf.id)).toEqual([{ provider: 'frankfurter', tokenId: chf.id, baseId: usd.id }]);
    expect(asksFor(quote.id)).toEqual([
      { provider: 'frankfurter', tokenId: quote.id, baseId: usd.id },
    ]);
    expect(asksFor(unheldQuote.id)).toEqual([]);
    const written = await writtenByProviders();
    const pairs = written.map((r) => `${r.tokenId}/${r.baseTokenId}`);
    expect(pairs).toContain(`${chf.id}/${usd.id}`);
    expect(pairs).toContain(`${quote.id}/${usd.id}`);
  });

  test('a baseline currency nobody uses is priced by the run', async () => {
    const usd = await fiat('USD');
    const baseline = BASELINE_FIAT.map(hub);
    const usdt = hub('USDT');
    const { useCase, asks, asksFor } = hourlyRun([]);

    await useCase.execute();

    for (const currency of baseline) {
      expect(asksFor(currency.id)).toEqual([
        { provider: 'frankfurter', tokenId: currency.id, baseId: usd.id },
      ]);
    }
    // A hub and the baseline's one crypto member: asked once, of CoinGecko.
    expect(asksFor(usdt.id)).toEqual([{ provider: 'coingecko', tokenId: usdt.id, baseId: usd.id }]);
    const written = await writtenByProviders();
    expect(new Set(written.map((r) => r.tokenId))).toEqual(new Set(asks.map((ask) => ask.tokenId)));
    expect(new Set(written.map((r) => r.baseTokenId))).toEqual(new Set([usd.id]));
    expect(asksFor(usd.id)).toEqual([]);
  });

  test('a custom-class token is not sent to any provider and is not a failure', async () => {
    const usd = await fiat('USD');
    const company = await commitToken('private-company');
    const other = await commitToken('other');
    // CONTROL: a held token a provider prices is asked for, so the providers were reachable.
    const coin = await commitToken();
    await commitPrices([
      {
        tokenId: company.id,
        baseTokenId: usd.id,
        price: '50',
        timestamp: new Date(Date.now() - 30 * DAY),
        source: 'manual',
      },
    ]);
    const { useCase, asksFor, routedIds } = hourlyRun([company, other, coin]);

    const result = await useCase.execute();

    expect(asksFor(company.id)).toEqual([]);
    expect(asksFor(other.id)).toEqual([]);
    expect(asksFor(coin.id)).toHaveLength(1);
    const routed = routedIds().flat();
    expect(routed).not.toContain(company.id);
    expect(routed).not.toContain(other.id);
    expect(result.tokensFailed).toBe(0);
    expect(result.errors).toEqual([]);
    // The person's price stands alone: the run wrote nothing beside it.
    expect((await storedFor(company.id, usd.id)).map((r) => [r.price, r.source])).toEqual([
      ['50', 'manual'],
    ]);
  });
});

// A vault's stored total moves only when something recalculates it, and
// neither a balance sync nor a manual price edit does: the hourly run is what
// carries a synced USD balance or a retyped manual price into it.
describe('the held tokens the run does not price', () => {
  test('a vault attached only to a fiat-USD cash holding is recalculated by a run', async () => {
    const usd = await fiat('USD');
    const user = await commitUser(usd.id);
    const cash = await commitHolding(user.id, usd.id, '250');
    const vault = await commitVault(user.id, usd.id, [cash]);
    const { useCase, recalculatedVaults } = hourlyRun([usd]);

    await useCase.execute();

    expect(recalculatedVaults()).toContain(vault);
    expect(await currentAmountOf(vault)).toBe('250');
  });

  test('a vault attached only to a custom-class token is recalculated by a run', async () => {
    const usd = await fiat('USD');
    const user = await commitUser(usd.id);
    const company = await commitToken('private-company');
    const shares = await commitHolding(user.id, company.id, '3');
    await commitPrices([
      {
        tokenId: company.id,
        baseTokenId: usd.id,
        price: '50',
        timestamp: new Date(Date.now() - 30 * DAY),
        source: 'manual',
      },
    ]);
    const vault = await commitVault(user.id, usd.id, [shares]);
    const { useCase, recalculatedVaults } = hourlyRun([company]);

    await useCase.execute();

    expect(recalculatedVaults()).toContain(vault);
    expect(await currentAmountOf(vault)).toBe('150');
  });

  test('a user who holds only those gets the price_refresh event', async () => {
    const usd = await fiat('USD');
    const user = await commitUser(usd.id);
    const company = await commitToken('private-company');
    await commitHolding(user.id, usd.id, '250');
    await commitHolding(user.id, company.id, '3');
    const { useCase, events } = hourlyRun([usd, company]);

    const result = await useCase.execute();

    // One event, counting the tokens the run priced.
    expect(events.filter((event) => event.userId === user.id)).toEqual([
      {
        entityType: 'holding',
        operationType: 'sync',
        userId: user.id,
        data: { reason: 'price_refresh', tokensUpdated: result.tokensUpdated },
      },
    ]);
  });

  test('CONTROL: neither is sent to a provider, and holding them changes no count', async () => {
    // In the 23:00Z hour nothing is deferred (SC-1603), so the two runs differ
    // only by what they hold.
    setSystemTime(new Date(Math.floor(Date.now() / DAY) * DAY + 23 * HOUR));
    const usd = await fiat('USD');
    const user = await commitUser(usd.id);
    const company = await commitToken('private-company');
    const coin = await commitToken();
    await commitHolding(user.id, usd.id, '250');
    await commitHolding(user.id, company.id, '3');
    await commitHolding(user.id, coin.id, '1');
    const without = await hourlyRun([coin]).useCase.execute();
    const { useCase, asksFor, routedIds } = hourlyRun([coin, usd, company]);

    const result = await useCase.execute();

    const routed = routedIds().flat();
    expect(routed).toContain(coin.id);
    expect(routed).not.toContain(usd.id);
    expect(routed).not.toContain(company.id);
    expect(asksFor(usd.id)).toEqual([]);
    expect(asksFor(company.id)).toEqual([]);
    expect(counts(result)).toEqual(counts(without));
  });
});

describe('SC-1603: stocks by exchange hours, FX once a day', () => {
  /** A reading an hour before `runAt`, as the previous hourly run leaves. */
  async function pricedAnHourBefore(tokenId: string, runAt: Date) {
    const usd = await fiat('USD');
    await commitPrices([
      {
        tokenId,
        baseTokenId: usd.id,
        price: '1',
        timestamp: new Date(runAt.getTime() - HOUR),
        source: CRYPTO_SOURCE,
      },
    ]);
  }

  test('FX read within the day is deferred outside the 23:00Z hour and asked in it', async () => {
    const noon = new Date('2026-10-06T12:00:00Z');
    const currency = await commitToken('fiat');
    await pricedAnHourBefore(currency.id, noon);
    const { useCase, asksFor } = hourlyRun([currency]);

    setSystemTime(noon);
    const deferredRun = await useCase.execute();
    expect(asksFor(currency.id)).toHaveLength(0);
    expect(deferredRun.tokensDeferred).toBeGreaterThanOrEqual(1);
    expect(deferredRun.errors.map((e) => e.tokenId)).not.toContain(currency.id);

    setSystemTime(new Date('2026-10-06T23:00:00Z'));
    await useCase.execute();
    expect(asksFor(currency.id)).toHaveLength(1);
  });

  test('a US stock is deferred on a Saturday and asked in a weekday session', async () => {
    const stock = await commitToken('stock', 'US');
    const saturday = new Date('2026-10-03T15:00:00Z');
    const tuesday = new Date('2026-10-06T15:00:00Z'); // 11:00 in New York
    await pricedAnHourBefore(stock.id, saturday);
    await pricedAnHourBefore(stock.id, tuesday);
    // No stock provider is registered here, so what the run hands the router
    // is the claim, not what a provider was asked.
    const { useCase, routedIds } = hourlyRun([stock]);

    setSystemTime(saturday);
    const weekend = await useCase.execute();
    expect(routedIds().flat()).not.toContain(stock.id);
    expect(weekend.tokensDeferred).toBeGreaterThanOrEqual(1);

    setSystemTime(tuesday);
    await useCase.execute();
    expect(routedIds().flat()).toContain(stock.id);
  });

  test('a stock never priced is asked whatever the hour', async () => {
    const stock = await commitToken('stock', 'US');
    const { useCase, routedIds } = hourlyRun([stock]);

    setSystemTime(new Date('2026-10-03T15:00:00Z'));
    await useCase.execute();

    expect(routedIds().flat()).toContain(stock.id);
  });
});
