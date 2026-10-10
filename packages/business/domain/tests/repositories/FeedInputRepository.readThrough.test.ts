import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { FeedInputRepository } from '../../src/repositories/FeedInputRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

/**
 * SC-1665. A balance sync and a ledger run on one account share one feed
 * input, and both record a window. The ledger's read-through point is the
 * newest LEDGER window: following the hourly balance windows would skip
 * every row posted since the last ledger read. The window's declared shape
 * decides, never its extent (feeds, #23777).
 */

const repo = () => Container.get(FeedInputRepository);
const SOURCE = 'airwallex-api';

async function seedInput(tx: DatabaseTransaction) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const input = await repo().findOrCreate(
    { userId: user.id, accountId: account.id, source: SOURCE, credentialId: null, walletId: null },
    tx
  );
  return { account, input };
}

const at = (iso: string) => new Date(iso);

describe('FeedInputRepository.findLedgerReadThrough', () => {
  test('the newest ledger window, not the newer balance windows after it', async () => {
    await withTestDb(async (tx) => {
      const { account, input } = await seedInput(tx);
      const ledgerTo = at('2026-10-09T01:00:00Z');
      await repo().recordWindow(
        input.id,
        {
          shape: 'transaction-run',
          from: at('2026-09-09T01:00:00Z'),
          to: ledgerTo,
          complete: false,
        },
        ledgerTo,
        tx
      );
      for (const hour of ['02', '03', '10']) {
        const instant = at(`2026-10-09T${hour}:00:00Z`);
        await repo().recordWindow(
          input.id,
          { shape: 'balance-snapshot', from: instant, to: instant, complete: false },
          instant,
          tx
        );
      }
      expect(await repo().findLedgerReadThrough(account.id, SOURCE, tx)).toEqual(ledgerTo);
    });
  });

  test('a full-history run has an open start and still counts', async () => {
    await withTestDb(async (tx) => {
      const { account, input } = await seedInput(tx);
      const to = at('2026-10-08T01:00:00Z');
      await repo().recordWindow(
        input.id,
        { shape: 'transaction-run', from: null, to, complete: true },
        to,
        tx
      );
      expect(await repo().findLedgerReadThrough(account.id, SOURCE, tx)).toEqual(to);
    });
  });

  test('control: an account with only balance windows has no read-through', async () => {
    await withTestDb(async (tx) => {
      const { account, input } = await seedInput(tx);
      const instant = at('2026-10-09T10:00:00Z');
      await repo().recordWindow(
        input.id,
        { shape: 'balance-snapshot', from: instant, to: instant, complete: false },
        instant,
        tx
      );
      expect(await repo().findLedgerReadThrough(account.id, SOURCE, tx)).toBeNull();
    });
  });

  test('a balance window that spans a range is still not the ledger (IBKR)', async () => {
    await withTestDb(async (tx) => {
      const { account, input } = await seedInput(tx);
      const ledgerTo = at('2026-10-08T01:00:00Z');
      await repo().recordWindow(
        input.id,
        {
          shape: 'transaction-run',
          from: at('2026-09-08T01:00:00Z'),
          to: ledgerTo,
          complete: false,
        },
        ledgerTo,
        tx
      );
      const fetched = at('2026-10-09T10:00:00Z');
      await repo().recordWindow(
        input.id,
        {
          shape: 'balance-snapshot',
          from: at('2026-10-08T20:00:00Z'),
          to: fetched,
          complete: false,
        },
        fetched,
        tx
      );
      expect(await repo().findLedgerReadThrough(account.id, SOURCE, tx)).toEqual(ledgerTo);
    });
  });

  test('an empty ledger run is an instant and still counts', async () => {
    await withTestDb(async (tx) => {
      const { account, input } = await seedInput(tx);
      const fetched = at('2026-10-09T10:00:00Z');
      await repo().recordWindow(
        input.id,
        { shape: 'transaction-run', from: fetched, to: fetched, complete: false },
        fetched,
        tx
      );
      expect(await repo().findLedgerReadThrough(account.id, SOURCE, tx)).toEqual(fetched);
    });
  });

  test('a window from before the shape column (NULL) is unknown, not a ledger read', async () => {
    await withTestDb(async (tx) => {
      const { account, input } = await seedInput(tx);
      const to = at('2026-10-08T01:00:00Z');
      await repo().recordWindow(
        input.id,
        { shape: 'transaction-run', from: null, to, complete: true },
        to,
        tx
      );
      await tx.execute(
        sql`update feed_input_windows set shape = null where input_id = ${input.id}`
      );
      expect(await repo().findLedgerReadThrough(account.id, SOURCE, tx)).toBeNull();
    });
  });

  test('another source on the same account is not this ledger', async () => {
    await withTestDb(async (tx) => {
      const { account, input } = await seedInput(tx);
      const to = at('2026-10-08T01:00:00Z');
      await repo().recordWindow(
        input.id,
        { shape: 'transaction-run', from: null, to, complete: true },
        to,
        tx
      );
      expect(await repo().findLedgerReadThrough(account.id, 'kraken-api', tx)).toBeNull();
    });
  });
});

describe('FeedInputRepository.findLedgerReadThroughByHolding', () => {
  test('each holding answers for its own account, only for the sources asked', async () => {
    await withTestDb(async (tx) => {
      const { account, input } = await seedInput(tx);
      const holding = await makeHolding(tx, {
        userId: input.userId,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
      });
      const to = at('2026-10-09T01:00:00Z');
      await repo().recordWindow(
        input.id,
        { shape: 'transaction-run', from: at('2026-09-09T01:00:00Z'), to, complete: false },
        to,
        tx
      );
      const later = at('2026-10-09T10:00:00Z');
      await repo().recordWindow(
        input.id,
        { shape: 'balance-snapshot', from: later, to: later, complete: false },
        later,
        tx
      );

      const asked = await repo().findLedgerReadThroughByHolding([holding.id], [SOURCE], tx);
      expect(asked.get(holding.id)).toEqual(to);
      const other = await repo().findLedgerReadThroughByHolding([holding.id], ['etherscan'], tx);
      expect(other.has(holding.id)).toBe(false);
    });
  });

  test('an input never read answers null, not absent', async () => {
    await withTestDb(async (tx) => {
      const { account, input } = await seedInput(tx);
      const holding = await makeHolding(tx, {
        userId: input.userId,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
      });
      const answer = await repo().findLedgerReadThroughByHolding([holding.id], [SOURCE], tx);
      expect(answer.has(holding.id)).toBe(true);
      expect(answer.get(holding.id)).toBeNull();
    });
  });
});
