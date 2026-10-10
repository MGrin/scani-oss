import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { TokenTypeRepository } from '../../../src/repositories/EnumRepositories';
import { TokenPriceEditHistoryRepository } from '../../../src/repositories/TokenPriceEditHistoryRepository';
import { TokenPriceRepository } from '../../../src/repositories/TokenPriceRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import {
  type PriceWrite,
  type PriceWriteOutcome,
  PriceWriter,
} from '../../../src/services/pricing/PriceWriter';
import { TokenPriceHistoryService } from '../../../src/services/tokens/TokenPriceHistoryService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

/**
 * A person's price goes to `PriceWriter.writeManual` inside the service's own
 * transaction, beside the edit-history row (foundation A3, Task 6). The rows
 * themselves are read through a real database by the router tests in the api;
 * this holds what the service hands the writer, and what it does when the
 * writer writes nothing.
 */

/** The transaction the service opens, as the writer must receive it. */
const TX = Symbol('the service transaction');

interface Handed {
  row: PriceWrite;
  tx: unknown;
}

const MOVED = { tokenId: 'priced-token', baseTokenId: 'chf-token', at: new Date(0) };

function makeService(written: 0 | 1): {
  service: TokenPriceHistoryService;
  handed: Handed[];
  history: unknown[];
  revalued: Array<{ pairs: unknown; tx: unknown }>;
} {
  const handed: Handed[] = [];
  const history: unknown[] = [];
  const revalued: Array<{ pairs: unknown; tx: unknown }> = [];
  Container.set(HoldingCacheWriter, {
    revalueAffected: async (pairs: unknown, _at: Date, opts?: { tx?: unknown }) => {
      revalued.push({ pairs, tx: opts?.tx });
      return [];
    },
  } as unknown as HoldingCacheWriter);
  Container.set(TokenTypeRepository, {
    findByCode: async (code: string) => ({ id: `type-${code}`, code }),
    findById: async (id: string) => ({ id, code: id.replace(/^type-/, '') }),
  } as unknown as TokenTypeRepository);
  Container.set(TokenRepository, {
    findBySymbolAndType: async (_symbol: string, typeId: string) =>
      typeId === 'type-fiat' ? { id: 'chf-token', symbol: 'CHF' } : null,
    findOwnedBySymbolAndType: async () => null,
    findVisibleById: async (id: string) => ({
      id,
      symbol: 'ZZQ',
      typeId: 'type-private-company',
    }),
    create: async (args: Record<string, unknown>) => ({ id: 'created-token', ...args }),
  } as unknown as TokenRepository);
  Container.set(TokenPriceRepository, {
    findLatestManualPricesForTokensAnyBase: async () => new Map(),
  } as unknown as TokenPriceRepository);
  Container.set(PriceWriter, {
    writeManual: async (row: PriceWrite, tx: unknown): Promise<PriceWriteOutcome> => {
      handed.push({ row, tx });
      return { written, dropped: 1 - written, changed: written ? [MOVED] : [], seriesChanged: [] };
    },
  } as unknown as PriceWriter);
  Container.set(TokenPriceEditHistoryRepository, {
    create: async (row: unknown) => {
      history.push(row);
      return { id: 'history-row', ...(row as object) };
    },
  } as unknown as TokenPriceEditHistoryRepository);

  class TestableService extends TokenPriceHistoryService {
    protected override async withTransaction<T>(callback: (tx: never) => Promise<T>): Promise<T> {
      return callback(TX as never);
    }
  }
  const service = new TestableService();
  Container.set(TokenPriceHistoryService, service);
  return { service, handed, history, revalued };
}

const CREATE = {
  symbol: 'zzq',
  name: 'Invented Holdings',
  typeCode: 'private-company',
  manualPrice: 12.5,
  baseCurrencyCode: 'chf',
} as const;

describe('createCustomToken — the manual price', () => {
  test('the writer is handed the typed price in the typed fiat, stamped now, inside the service’s transaction', async () => {
    const { service, handed, history } = makeService(1);
    const before = Date.now();

    await service.createCustomToken({ ...CREATE }, 'user-1');

    expect(handed).toHaveLength(1);
    expect(handed[0]?.tx).toBe(TX);
    expect(handed[0]?.row).toMatchObject({
      tokenId: 'created-token',
      baseTokenId: 'chf-token',
      price: '12.5',
      granularity: 'intraday',
      source: 'manual',
    });
    expect(handed[0]?.row.at.getTime()).toBeGreaterThanOrEqual(before);
    expect(history).toHaveLength(1);
  });

  test('a price the writer drops fails the creation, and no edit-history row is written', async () => {
    const { service, history } = makeService(0);

    await expect(
      service.createCustomToken({ ...CREATE, manualPrice: Number.POSITIVE_INFINITY }, 'user-1')
    ).rejects.toThrow('manualPrice must be a positive number');
    expect(history).toEqual([]);
  });
});

const REPRICE = {
  tokenId: 'custom-token',
  newPrice: 13.5,
  baseCurrencyCode: 'chf',
  userId: 'user-1',
} as const;

describe('updateCustomTokenPrice — the manual price', () => {
  test('the changed pair revalues the cache inside the same transaction, as a custom price never refreshes (SC-1610)', async () => {
    const { service, revalued } = makeService(1);

    await service.updateCustomTokenPrice({ ...REPRICE });

    expect(revalued).toEqual([{ pairs: [MOVED], tx: TX }]);
  });

  test('the writer is handed the typed price in the typed fiat, stamped now, inside the service’s transaction', async () => {
    const { service, handed, history } = makeService(1);
    const before = Date.now();

    const result = await service.updateCustomTokenPrice({ ...REPRICE });

    expect(handed).toHaveLength(1);
    expect(handed[0]?.tx).toBe(TX);
    expect(handed[0]?.row).toMatchObject({
      tokenId: 'custom-token',
      baseTokenId: 'chf-token',
      price: '13.5',
      granularity: 'intraday',
      source: 'manual',
    });
    expect(handed[0]?.row.at.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.newPrice).toBe('13.5');
    expect(history).toHaveLength(1);
  });

  test('a price the writer drops fails the re-price, and no edit-history row is written', async () => {
    const { service, history } = makeService(0);

    await expect(
      service.updateCustomTokenPrice({ ...REPRICE, newPrice: Number.POSITIVE_INFINITY })
    ).rejects.toThrow('newPrice must be a positive number');
    expect(history).toEqual([]);
  });
});
