import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { FeedInputRepository } from '../../../src/repositories/FeedInputRepository';
import { AccountLedgerSync } from '../../../src/services/transactions/AccountLedgerSync';
import {
  type FetchedLedger,
  TransactionImportCoordinator,
  type TransactionImportInput,
} from '../../../src/services/transactions/TransactionImportCoordinator';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

/**
 * SC-1665. The ledger is read in the same run as the balance, from where the
 * last ledger read stopped, for every provider whose ledger read is cheap
 * and incremental. The rest stay on the nightly run.
 */

restoreContainerAfterAll();

const HOUR = 60 * 60 * 1000;
const READ_THROUGH = new Date('2026-10-09T10:00:00Z');

function seed(opts: { readThrough?: Date | null; fails?: Error } = {}) {
  const fetches: TransactionImportInput[] = [];
  const retracted: string[] = [];
  Container.set(FeedInputRepository, {
    findLedgerReadThrough: async () =>
      opts.readThrough === undefined ? READ_THROUGH : opts.readThrough,
  } as unknown as FeedInputRepository);
  Container.set(TransactionImportCoordinator, {
    fetch: async (input: TransactionImportInput) => {
      fetches.push(input);
      if (opts.fails) throw opts.fails;
      return { ...input, routerResult: {} } as unknown as FetchedLedger;
    },
    retractCompleteHistoryClaim: async (accountId: string, source: string) => {
      retracted.push(`${accountId}:${source}`);
    },
  } as unknown as TransactionImportCoordinator);
  return { sync: new AccountLedgerSync(), fetches, retracted };
}

const read = (sync: AccountLedgerSync, source: string | null) =>
  sync.read({ userId: 'user-1', accountId: 'acct-1', source });

describe('AccountLedgerSync.read', () => {
  test('a merged provider is read from its read-through point minus an hour', async () => {
    const { sync, fetches } = seed();
    const outcome = await read(sync, 'airwallex-api');
    expect(outcome.kind).toBe('read');
    expect(fetches).toEqual([
      {
        userId: 'user-1',
        accountId: 'acct-1',
        source: 'airwallex-api',
        since: new Date(READ_THROUGH.getTime() - HOUR),
      },
    ]);
  });

  test('IBKR stamps cash rows at day end, so it overlaps two days', async () => {
    const { sync, fetches } = seed();
    await read(sync, 'ibkr-api');
    expect(fetches[0]?.since).toEqual(new Date(READ_THROUGH.getTime() - 48 * HOUR));
  });

  test('a provider still on the nightly run is not read here', async () => {
    const { sync, fetches } = seed();
    expect(await read(sync, 'tron')).toEqual({ kind: 'skipped', reason: 'nightly' });
    expect(fetches).toEqual([]);
  });

  test('etherscan is read with its balance now that its walk starts at `since`', async () => {
    const { sync, fetches } = seed();
    expect((await read(sync, 'etherscan')).kind).toBe('read');
    expect(fetches).toHaveLength(1);
  });

  test('a ledger never read is left to the nightly full walk', async () => {
    const { sync, fetches } = seed({ readThrough: null });
    expect(await read(sync, 'kraken-api')).toEqual({ kind: 'skipped', reason: 'never-read' });
    expect(fetches).toEqual([]);
  });

  test('an account with no ledger source is balance-only', async () => {
    const { sync } = seed();
    expect(await read(sync, null)).toEqual({ kind: 'skipped', reason: 'no-ledger' });
  });

  test('a failed read is reported, and withdraws the complete-history claim as an import does', async () => {
    const { sync, retracted } = seed({ fails: new Error('airwallex HTTP 503') });
    const outcome = await read(sync, 'airwallex-api');
    expect(outcome.kind).toBe('failed');
    expect(retracted).toEqual(['acct-1:airwallex-api']);
  });
});
