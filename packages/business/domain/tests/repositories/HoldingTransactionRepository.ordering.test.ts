import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { sortLedgerEvents } from '../../src/lib/ledger-order';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const repo = () => Container.get(HoldingTransactionRepository);

/**
 * The read a cost walk depends on must not depend on how Postgres stored the
 * rows (SC-342).
 *
 * The unit tests next door prove the walk is order-independent given a
 * sequence. This proves the sequence itself is: the same rows are written in
 * two different physical orders inside one transaction, and both reads have
 * to come back identical. A small table is seq-scanned, so insertion order
 * *is* the physical order here — which is exactly the variable a VACUUM, a
 * dump/restore or a row-moving migration changes underneath production.
 */

const AT = new Date('2026-02-22T04:57:58Z');

async function fixture(tx: Parameters<typeof makeUser>[0]) {
  const user = await makeUser(tx);
  const instType = await makeInstitutionType(tx);
  const inst = await makeInstitution(tx, { typeId: instType.id });
  const acct = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
  const tok = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: acct.id,
    tokenId: tok.id,
  });
  return { userId: user.id, tokenId: tok.id, holdingId: holding.id };
}

/**
 * Eight rows on one instant: same kind rank, two sources, and one pair
 * sharing an `external_id` across sources. Nothing but the SC-342 tiebreak
 * separates them.
 */
function rows(userId: string, holdingId: string, tokenId: string) {
  return [
    { externalId: 'sig-b', source: 'solana', kind: 'swap_out', quantity: '-1' },
    { externalId: 'sig-a', source: 'solana', kind: 'swap_out', quantity: '-2' },
    { externalId: 'sig-c', source: 'solana', kind: 'transfer_out', quantity: '-3' },
    { externalId: 'sig-a', source: 'etherscan', kind: 'transfer_out', quantity: '-4' },
    { externalId: 'sig-d', source: 'solana', kind: 'transfer_in', quantity: '5' },
    { externalId: 'sig-e', source: 'solana', kind: 'deposit', quantity: '6' },
    { externalId: 'sig-f', source: 'etherscan', kind: 'transfer_in', quantity: '7' },
    { externalId: 'sig-g', source: 'solana', kind: 'buy', quantity: '8' },
  ].map((r) => ({ ...r, userId, holdingId, tokenId, occurredAt: AT }));
}

describe('HoldingTransactionRepository ledger order', () => {
  test('findForHoldingUpTo returns the same sequence whatever the physical row order', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await fixture(tx);
      const seed = rows(userId, holdingId, tokenId);

      await repo().bulkUpsert(seed, tx);
      const first = await repo().findForHoldingUpTo(holdingId, AT, tx);
      expect(first).toHaveLength(8);

      // Rewrite the heap in the opposite order. Same rows, same values, new
      // ids and a new physical layout — the only thing a re-import, a
      // migration or a VACUUM actually changes.
      await repo().deleteForHoldingBySource(holdingId, 'solana', tx);
      await repo().deleteForHoldingBySource(holdingId, 'etherscan', tx);
      await repo().bulkUpsert([...seed].reverse(), tx);
      const second = await repo().findForHoldingUpTo(holdingId, AT, tx);

      const key = (r: { source: string; externalId: string; kind: string }) =>
        `${r.source}|${r.externalId}|${r.kind}`;
      expect(second.map(key)).toEqual(first.map(key));

      // And the order is the documented one: outflows first, then by source,
      // then by external_id.
      expect(second.map(key)).toEqual([
        'etherscan|sig-a|transfer_out',
        'solana|sig-a|swap_out',
        'solana|sig-b|swap_out',
        'solana|sig-c|transfer_out',
        'etherscan|sig-f|transfer_in',
        'solana|sig-d|transfer_in',
        'solana|sig-e|deposit',
        'solana|sig-g|buy',
      ]);
    });
  });

  test('the SQL order agrees with the in-memory comparator on the same rows', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await fixture(tx);
      await repo().bulkUpsert(rows(userId, holdingId, tokenId), tx);

      // `walkLots` re-sorts what the repository hands it, and `walkComponent`
      // sorts its own flattened list. If Postgres and JavaScript disagreed —
      // a different collation is all it would take — the two walkers would
      // silently read different sequences off one ledger.
      const fromSql = await repo().findForHoldingUpTo(holdingId, AT, tx);
      const resorted = sortLedgerEvents(fromSql);
      expect(resorted.map((r) => r.id)).toEqual(fromSql.map((r) => r.id));
    });
  });

  test('findByRange paginates over a total order — no row on two pages, none on none', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await fixture(tx);
      await repo().bulkUpsert(rows(userId, holdingId, tokenId), tx);

      const paged: string[] = [];
      for (let offset = 0; offset < 8; offset += 3) {
        const page = await repo().findByRange({ holdingId, limit: 3, offset, order: 'asc' }, tx);
        paged.push(...page.map((r) => r.id));
      }
      const all = await repo().findByRange({ holdingId, order: 'asc' }, tx);
      expect(paged).toEqual(all.map((r) => r.id));
      expect(new Set(paged).size).toBe(8);
    });
  });
});
