import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { PriceHubResolver } from '../../../src/services/pricing/PriceHubResolver';
import { PRICE_HUBS, type PriceHub } from '../../../src/services/pricing/price-hubs';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { withTestDb } from '../../../test/helpers/db';
import { makeToken } from '../../../test/helpers/factories-extra';

restoreContainerAfterAll();

// Built before any stub below is set, so it reads the database.
const stored = new PriceHubResolver();

/** The catalogue row a hub names: its symbol, its type, and no market segment. */
async function catalogueId(
  tx: DatabaseTransaction,
  symbol: string,
  typeCode: string
): Promise<string | undefined> {
  const [row] = await tx
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
    .where(
      and(
        eq(schema.tokens.symbol, symbol),
        eq(schema.tokenTypes.code, typeCode),
        isNull(schema.tokens.marketSegment)
      )
    );
  return row?.id;
}

interface Row {
  id: string;
  symbol: string;
  type: 'fiat' | 'crypto';
  segment?: string;
}

const USD: Row = { id: 'token-USD', symbol: 'USD', type: 'fiat' };
const EUR: Row = { id: 'token-EUR', symbol: 'EUR', type: 'fiat' };
const USDT: Row = { id: 'token-USDT', symbol: 'USDT', type: 'crypto' };
const A_TRANSACTION = {} as DatabaseTransaction;

/**
 * A resolver over a catalogue of `rows`, to which a transaction adds
 * `uncommitted`. `lookups` counts the reads of it.
 */
function resolverOver(rows: readonly Row[], uncommitted: readonly Row[] = []) {
  const counted = { lookups: 0 };
  const visible = (tx: unknown) => (tx === undefined ? rows : [...rows, ...uncommitted]);
  Container.set(TokenRepository, {
    findByIdentityTuple: async (
      symbol: string,
      typeId: string,
      segment: string | null,
      tx?: DatabaseTransaction
    ) => {
      counted.lookups += 1;
      return (
        visible(tx).find(
          (row) => row.symbol === symbol && row.type === typeId && (row.segment ?? null) === segment
        ) ?? null
      );
    },
    findBySymbolAndType: async (symbol: string, typeId: string, tx?: DatabaseTransaction) => {
      counted.lookups += 1;
      return visible(tx).find((row) => row.symbol === symbol && row.type === typeId) ?? null;
    },
  } as unknown as TokenRepository);
  Container.set(TokenTypeRepository, {
    findByCode: async (code: string) => ({ id: code, code, name: code }),
  } as unknown as TokenTypeRepository);
  return { resolver: new PriceHubResolver(), counted };
}

describe('PriceHubResolver over the database', () => {
  test('usdTokenId is the fiat, with a newer crypto token named USD in the catalogue', async () => {
    await withTestDb(async (tx) => {
      const fiat = await catalogueId(tx, 'USD', 'fiat');
      const memecoin = await makeToken(tx, { symbol: 'USD', name: 'A coin named USD' });
      // The bare symbol does pick the newer row: without that this proves nothing.
      expect((await new TokenRepository().findBySymbol('USD', tx))?.id).toBe(memecoin.id);

      expect(fiat).toBeDefined();
      expect(await stored.usdTokenId(tx)).toBe(fiat as string);
    });
  });

  test('hubTokenIds are the catalogue rows PRICE_HUBS names, in that order', async () => {
    await withTestDb(async (tx) => {
      if ((await catalogueId(tx, 'USDT', 'crypto')) === undefined) {
        await makeToken(tx, { symbol: 'USDT', name: 'Tether' });
      }
      const expected: Array<string | undefined> = [];
      for (const hub of PRICE_HUBS) expected.push(await catalogueId(tx, hub.symbol, hub.typeCode));

      expect(expected).toHaveLength(3);
      expect(expected.every((id) => id !== undefined)).toBe(true);
      expect(await stored.hubTokenIds(tx)).toEqual(expected as string[]);
    });
  });
});

describe('PriceHubResolver', () => {
  test('a hub the catalogue lacks drops out, and the others keep their order', async () => {
    const { resolver } = resolverOver([EUR, USD]);
    expect(await resolver.hubTokenIds()).toEqual([USD.id, EUR.id]);
  });

  test('a hub with only a segmented row falls back to it', async () => {
    const segmented: Row = {
      id: 'token-USDT-on-a-chain',
      symbol: 'USDT',
      type: 'crypto',
      segment: 'evm:1:0xbeef',
    };
    const { resolver } = resolverOver([USD, EUR, segmented]);
    expect(await resolver.hubTokenIds()).toEqual([USD.id, segmented.id, EUR.id]);
  });

  test('a crypto token named USD is never the USD hub', async () => {
    const memecoin: Row = { id: 'token-USD-memecoin', symbol: 'USD', type: 'crypto' };
    const { resolver } = resolverOver([memecoin, USD, EUR, USDT]);
    expect(await resolver.hubTokenIds()).toEqual([USD.id, USDT.id, EUR.id]);
    expect(await resolver.usdTokenId()).toBe(USD.id);
  });

  test('usdTokenId throws when the catalogue has no fiat USD', async () => {
    const memecoin: Row = { id: 'token-USD-memecoin', symbol: 'USD', type: 'crypto' };
    const { resolver } = resolverOver([memecoin, EUR, USDT]);
    await expect(resolver.usdTokenId()).rejects.toThrow('no fiat USD');
  });

  test('without a transaction each hub is read once, a hub that resolves to nothing included', async () => {
    const { resolver, counted } = resolverOver([USD, EUR]);

    const first = await resolver.hubTokenIds();
    const afterFirst = counted.lookups;
    const again = await resolver.hubTokenIds();
    await resolver.usdTokenId();

    expect(afterFirst).toBeGreaterThan(0);
    expect(counted.lookups).toBe(afterFirst);
    expect(again).toEqual(first);
  });

  test('a transaction reads past the cache: a hub it has just seeded is found (SC-600)', async () => {
    const { resolver } = resolverOver([USD, EUR], [USDT]);
    // The pool's answer, USDT absent, is cached first.
    expect(await resolver.hubTokenIds()).toEqual([USD.id, EUR.id]);

    expect(await resolver.hubTokenIds(A_TRANSACTION)).toEqual([USD.id, USDT.id, EUR.id]);
  });

  test('a transaction leaves nothing in the cache: its hub is gone when it is (SC-600)', async () => {
    const { resolver, counted } = resolverOver([USD, EUR], [USDT]);

    expect(await resolver.hubTokenIds(A_TRANSACTION)).toEqual([USD.id, USDT.id, EUR.id]);
    const afterFirst = counted.lookups;
    await resolver.hubTokenIds(A_TRANSACTION);

    // Read again, not served from a cache, and the pool never sees its USDT.
    expect(counted.lookups).toBeGreaterThan(afterFirst);
    expect(await resolver.hubTokenIds()).toEqual([USD.id, EUR.id]);
  });
});

describe('PriceHubResolver.tokenIdsOf', () => {
  const GBP: Row = { id: 'token-GBP', symbol: 'GBP', type: 'fiat' };
  const hub = (row: Row): PriceHub => ({ symbol: row.symbol, typeCode: row.type });

  test('a list of hubs its caller chose, in that order, less those the catalogue lacks', async () => {
    const { resolver } = resolverOver([USD, EUR, USDT, GBP]);
    const CHF: Row = { id: 'token-CHF', symbol: 'CHF', type: 'fiat' };

    expect(await resolver.tokenIdsOf([hub(EUR), hub(GBP), hub(CHF), hub(USD)])).toEqual([
      EUR.id,
      GBP.id,
      USD.id,
    ]);
    expect(await resolver.tokenIdsOf([])).toEqual([]);
  });

  test('one cache with hubTokenIds and usdTokenId: a hub read by any of them is read once', async () => {
    const { resolver, counted } = resolverOver([USD, EUR, USDT, GBP]);

    expect(await resolver.tokenIdsOf([hub(USD), hub(GBP)])).toEqual([USD.id, GBP.id]);
    const afterOwnList = counted.lookups;
    expect(await resolver.hubTokenIds()).toEqual([USD.id, USDT.id, EUR.id]);
    const afterHubs = counted.lookups;
    await resolver.usdTokenId();
    expect(await resolver.tokenIdsOf([hub(GBP), hub(EUR), hub(USDT)])).toEqual([
      GBP.id,
      EUR.id,
      USDT.id,
    ]);

    // CONTROL: each read once. USD and GBP first, then only USDT and EUR, then nothing.
    expect(afterOwnList).toBe(2);
    expect(afterHubs).toBe(4);
    expect(counted.lookups).toBe(4);
  });

  test('a transaction reads past the cache and fills nothing (SC-600)', async () => {
    const pooled = resolverOver([USD, EUR], [USDT]);
    // The pool's answer, USDT absent, is cached first: the transaction still finds its USDT.
    expect(await pooled.resolver.tokenIdsOf([hub(USDT), hub(USD)])).toEqual([USD.id]);
    expect(await pooled.resolver.tokenIdsOf([hub(USDT), hub(USD)], A_TRANSACTION)).toEqual([
      USDT.id,
      USD.id,
    ]);

    const fresh = resolverOver([USD, EUR], [USDT]);
    expect(await fresh.resolver.tokenIdsOf([hub(USDT)], A_TRANSACTION)).toEqual([USDT.id]);
    const afterTransaction = fresh.counted.lookups;
    // Read again by the pool, which never sees the transaction's USDT.
    expect(await fresh.resolver.tokenIdsOf([hub(USDT)])).toEqual([]);
    expect(fresh.counted.lookups).toBeGreaterThan(afterTransaction);
  });
});
