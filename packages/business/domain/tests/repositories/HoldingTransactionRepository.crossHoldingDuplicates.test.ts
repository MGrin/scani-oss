import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';

// `findCrossHoldingDuplicates` is the only check in the system that looks at
// more than one holding at a time. Everything else reconciles a holding
// against its own synthesized opening anchor, which is exactly why SC-239
***REMOVED***
// twice) balanced on both sides for months while being wrong.

const repo = () => Container.get(HoldingTransactionRepository);

async function splitPosition(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx, { isScamProbability: 0 });
  const imported = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    source: 'import_airwallex',
    externalId: 'USD',
  });
  const manual = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    source: 'manual',
    externalId: null,
  });
  return { user, account, token, imported, manual };
}

describe('findCrossHoldingDuplicates', () => {
  test('finds an event ingested onto both holdings of one position', async () => {
    await withTestDb(async (tx) => {
      const { user, account, token, imported, manual } = await splitPosition(tx);
      for (const holdingId of [imported.id, manual.id]) {
        await makeHoldingTransaction(tx, {
          userId: user.id,
          holdingId,
          source: 'airwallex-api',
          externalId: 'ftx_PUBze1dkNkCX_he2NUyClQ',
        });
      }

      const found = await repo().findCrossHoldingDuplicates(tx);
      const mine = found.filter((d) => d.accountId === account.id);
      expect(mine.length).toBe(1);
      expect(mine[0]?.tokenId).toBe(token.id);
      expect(mine[0]?.source).toBe('airwallex-api');
      expect(mine[0]?.externalId).toBe('ftx_PUBze1dkNkCX_he2NUyClQ');
      expect([...(mine[0]?.holdingIds ?? [])].sort()).toEqual([imported.id, manual.id].sort());
    });
  });

  test('a split position whose holdings carry different events is not a duplicate', async () => {
    await withTestDb(async (tx) => {
      const { user, account, imported, manual } = await splitPosition(tx);
      await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: imported.id,
        source: 'airwallex-api',
        externalId: 'ftx_one',
      });
      await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: manual.id,
        source: 'airwallex-api',
        externalId: 'ftx_two',
      });

      const found = await repo().findCrossHoldingDuplicates(tx);
      expect(found.filter((d) => d.accountId === account.id)).toEqual([]);
    });
  });

  // `OpeningBalanceReconciliationService` writes a constant external_id of
  // 'opening_balance' and synthesizes one anchor PER HOLDING by design. If the
  // probe counted it, every legitimately split position in production would
  // alert every night and the signal would be worth nothing.
  test('ignores the synthesized reconciliation opening on both holdings', async () => {
    await withTestDb(async (tx) => {
      const { user, account, imported, manual } = await splitPosition(tx);
      for (const holdingId of [imported.id, manual.id]) {
        await makeHoldingTransaction(tx, {
          userId: user.id,
          holdingId,
          kind: 'opening_balance',
          source: 'reconciliation-opening',
          externalId: 'opening_balance',
        });
      }

      const found = await repo().findCrossHoldingDuplicates(tx);
      expect(found.filter((d) => d.accountId === account.id)).toEqual([]);
    });
  });

  // The same tx hash legitimately appears on two holdings when a user moves
  // funds between two of their own wallets — different accounts, so the same
  // event on each side is one event seen twice, not one event counted twice.
  test('does not flag one event across two different accounts', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const token = await makeToken(tx, { isScamProbability: 0 });
      const holdingIds: string[] = [];
      for (const name of ['wallet-a', 'wallet-b']) {
        const account = await makeAccount(tx, {
          userId: user.id,
          institutionId: institution.id,
          name,
        });
        const holding = await makeHolding(tx, {
          userId: user.id,
          accountId: account.id,
          tokenId: token.id,
          source: 'blockchain',
        });
        holdingIds.push(holding.id);
      }
      for (const holdingId of holdingIds) {
        await makeHoldingTransaction(tx, {
          userId: user.id,
          holdingId,
          source: 'etherscan',
          externalId: '0xdeadbeef',
        });
      }

      const found = await repo().findCrossHoldingDuplicates(tx);
      expect(found.filter((d) => holdingIds.includes(d.holdingIds[0] ?? ''))).toEqual([]);
    });
  });
});
