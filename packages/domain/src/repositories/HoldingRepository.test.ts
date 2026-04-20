import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';
import { SCAM_PROBABILITY_THRESHOLD } from '../config/tokens';
import { HoldingRepository } from './HoldingRepository';

// HoldingRepository is the single most important table access in the app
// (every dashboard, allocation, and pricing path reads through it) and is
// exactly where the scam-filter vs. wallet-import-review tension plays
// out. These tests lock in the `includeScamTokens` contract — both default
// and overridden — and sanity-check the scam-probability boundary.

const repo = () => Container.get(HoldingRepository);

async function scaffold(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  return { user, institution, account };
}

describe('HoldingRepository', () => {
  test('findByUser returns visible, non-scam holdings', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const cleanToken = await makeToken(tx, { isScamProbability: 0 });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: cleanToken.id,
      });
      const rows = await repo().findByUser(user.id, tx);
      expect(rows.length).toBe(1);
    });
  });

  test('findByUser filters out tokens past the scam threshold by default', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const scammy = await makeToken(tx, { isScamProbability: 1 });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: scammy.id,
      });
      const rows = await repo().findByUser(user.id, tx);
      expect(rows.length).toBe(0);
    });
  });

  test('findByUserWithFullDetails includeScamTokens=true surfaces scam holdings', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const scammy = await makeToken(tx, { isScamProbability: 1 });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: scammy.id,
      });

      // Default path hides it.
      const defaultResult = await repo().findByUserWithFullDetails(
        user.id,
        undefined,
        tx,
        false,
        false
      );
      expect(defaultResult.length).toBe(0);

      // Wallet-import review path — scam tokens stay visible with a badge.
      const withScam = await repo().findByUserWithFullDetails(user.id, undefined, tx, false, true);
      expect(withScam.length).toBe(1);
      expect(withScam[0]!.token.isScamProbability).toBe(1);
    });
  });

  test('scam filter boundary exactly at SCAM_PROBABILITY_THRESHOLD', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      // just under the threshold → still visible.
      const justUnder = await makeToken(tx, {
        isScamProbability: SCAM_PROBABILITY_THRESHOLD - 0.01,
      });
      const atThreshold = await makeToken(tx, { isScamProbability: SCAM_PROBABILITY_THRESHOLD });
      await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: justUnder.id });
      await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: atThreshold.id });
      const rows = await repo().findByUser(user.id, tx);
      expect(rows.length).toBe(1);
    });
  });

  test('findByUser excludes hidden holdings by default', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        isHidden: true,
      });
      expect((await repo().findByUser(user.id, tx)).length).toBe(0);
      expect((await repo().findByUser(user.id, tx, true)).length).toBe(1);
    });
  });

  test('getDistinctTokenIds returns unique set across holdings', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const t1 = await makeToken(tx);
      const t2 = await makeToken(tx);
      await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: t1.id });
      await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: t2.id });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: t1.id,
        balance: '200',
      });
      const ids = await repo().getDistinctTokenIds(tx);
      expect(ids).toContain(t1.id);
      expect(ids).toContain(t2.id);
      // No duplicates — t1 appears twice in holdings but once in the result.
      expect(ids.filter((id) => id === t1.id).length).toBe(1);
    });
  });
});
