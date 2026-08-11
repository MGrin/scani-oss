import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

const repo = () => Container.get(HoldingTransactionRepository);

async function makeHoldingFixture(tx: Parameters<typeof makeUser>[0]): Promise<{
  userId: string;
  accountId: string;
  tokenId: string;
  holdingId: string;
}> {
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
  return { userId: user.id, accountId: acct.id, tokenId: tok.id, holdingId: holding.id };
}

describe('HoldingTransactionRepository counterparty/description', () => {
  test('round-trips counterparty and description when provided', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const inserted = await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'withdraw',
            quantity: '-42.00',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 'statement-csv',
            externalId: 'stmt-1',
            counterparty: 'Acme Landlord LLC',
            description: 'RENT AUG 2024',
          },
        ],
        tx
      );
      expect(inserted).toHaveLength(1);
      expect(inserted[0]?.counterparty).toBe('Acme Landlord LLC');
      expect(inserted[0]?.description).toBe('RENT AUG 2024');
    });
  });

  test('bulkUpsert overwrites counterparty and description on re-ingest of the same (holding, source, externalId)', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const row = {
        userId,
        holdingId,
        tokenId,
        kind: 'withdraw' as const,
        quantity: '-42.00',
        occurredAt: new Date('2024-06-01T00:00:00Z'),
        source: 'statement-csv',
        externalId: 'stmt-1',
      };
      const first = await repo().bulkUpsert(
        [{ ...row, counterparty: 'Acme Landlord LLC', description: 'RENT AUG 2024' }],
        tx
      );
      // Normalizer improvement re-parses the same statement line with a
      // corrected counterparty — the conflict path must pick it up, not
      // silently keep the stale value.
      const second = await repo().bulkUpsert(
        [{ ...row, counterparty: 'Acme Property Management', description: 'RENT - AUGUST' }],
        tx
      );
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(second[0]?.id).toBe(first[0]?.id ?? '');
      expect(second[0]?.counterparty).toBe('Acme Property Management');
      expect(second[0]?.description).toBe('RENT - AUGUST');
    });
  });

  test('leaves counterparty and description null when omitted', async () => {
    await withTestDb(async (tx) => {
      const { userId, holdingId, tokenId } = await makeHoldingFixture(tx);
      const inserted = await repo().bulkUpsert(
        [
          {
            userId,
            holdingId,
            tokenId,
            kind: 'swap_in',
            quantity: '1.0',
            occurredAt: new Date('2024-06-01T00:00:00Z'),
            source: 'etherscan',
            externalId: 'chain-1',
          },
        ],
        tx
      );
      expect(inserted).toHaveLength(1);
      expect(inserted[0]?.counterparty).toBeNull();
      expect(inserted[0]?.description).toBeNull();
    });
  });
});
