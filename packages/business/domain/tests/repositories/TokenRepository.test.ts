import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { TokenRepository } from '../../src/repositories/TokenRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeToken } from '../../test/helpers/factories-extra';

// TokenRepository backs every price/enrichment flow. The canonicalization
// (symbols stored uppercase, lookups case-insensitive) is the one
// non-obvious invariant — pin it here so a future refactor that drops
// `toUpperCase()` doesn't silently break pricing for all lowercase imports.

const repo = () => Container.get(TokenRepository);

describe('TokenRepository', () => {
  test('findBySymbol normalizes the query to uppercase', async () => {
    await withTestDb(async (tx) => {
      const token = await makeToken(tx, { symbol: 'BTC' });
      // Lower / mixed case both resolve to the same row — the repo
      // uppercases the needle.
      expect((await repo().findBySymbol('btc', tx))?.id).toBe(token.id);
      expect((await repo().findBySymbol('Btc', tx))?.id).toBe(token.id);
      expect((await repo().findBySymbol('BTC', tx))?.id).toBe(token.id);
    });
  });

  test('findBySymbol returns null for unknown symbol', async () => {
    await withTestDb(async (tx) => {
      expect(await repo().findBySymbol('DOES-NOT-EXIST', tx)).toBeNull();
    });
  });

  test('findBySymbolAndType narrows by type (same symbol can exist in multiple types)', async () => {
    await withTestDb(async (tx) => {
      const btc = await makeToken(tx, { symbol: 'BTC' });
      const found = await repo().findBySymbolAndType('btc', btc.typeId, tx);
      expect(found?.id).toBe(btc.id);
    });
  });

  test('findBySymbolPrefixAndType matches dotted suffix variants', async () => {
    // IBKR dedup path: import "XEQT", search the DB for "XEQT.%" to reuse
    // an existing "XEQT.TO" row rather than create a duplicate.
    await withTestDb(async (tx) => {
      const token = await makeToken(tx, { symbol: 'XEQT.TO' });
      const found = await repo().findBySymbolPrefixAndType('xeqt', token.typeId, tx);
      expect(found?.id).toBe(token.id);
    });
  });

  test('findBySymbolTypePairs handles empty input without hitting DB', async () => {
    await withTestDb(async (tx) => {
      expect(await repo().findBySymbolTypePairs([], tx)).toEqual([]);
    });
  });

  test('findManyWithTypes joins token_types and preserves isScamProbability', async () => {
    await withTestDb(async (tx) => {
      const scammy = await makeToken(tx, { symbol: 'SCAM', isScamProbability: 1 });
      const clean = await makeToken(tx, { symbol: 'CLEAN', isScamProbability: 0 });
      const found = await repo().findManyWithTypes([scammy.id, clean.id], tx);
      expect(found.length).toBe(2);
      expect(found.every((t) => t.typeCode != null)).toBe(true);
      const byId = Object.fromEntries(found.map((t) => [t.id, t]));
      expect(byId[scammy.id]!.isScamProbability).toBe(1);
      expect(byId[clean.id]!.isScamProbability).toBe(0);
    });
  });

  test('findManyWithTypes short-circuits on empty input', async () => {
    await withTestDb(async (tx) => {
      expect(await repo().findManyWithTypes([], tx)).toEqual([]);
    });
  });

  test('createMany returns inserted rows', async () => {
    await withTestDb(async (tx) => {
      // Grab a token-type id from an existing factory-made row.
      const seed = await makeToken(tx);
      const rows = await repo().createMany(
        [
          { symbol: 'BATCH-A', name: 'Batch A', typeId: seed.typeId },
          { symbol: 'BATCH-B', name: 'Batch B', typeId: seed.typeId },
        ],
        tx
      );
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.symbol).sort()).toEqual(['BATCH-A', 'BATCH-B']);
    });
  });
});
