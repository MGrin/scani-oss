import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingRepository } from '../../src/repositories/HoldingRepository';
import { UserTokenScamVerdictRepository } from '../../src/repositories/UserTokenScamVerdictRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

// SC-1160: a user's scam verdict applies to that user and to nobody else
// (mgrin, 2026-09-14). Every case here has TWO holders of one token, and the
// second is the control: a lookup that resolved the verdict without the
// holding's owner — which is what `effectiveScamProbability` would do if its
// outer references rendered unqualified inside the subquery — passes every
// assertion about the first user and fails the one about the second.

const holdings = () => Container.get(HoldingRepository);
const verdicts = () => Container.get(UserTokenScamVerdictRepository);
type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

async function twoHolders(tx: Tx, isScamProbability: number) {
  const institution = await makeInstitution(tx);
  const token = await makeToken(tx, { isScamProbability });
  const [a, b] = await Promise.all([makeUser(tx), makeUser(tx)]);
  for (const user of [a, b]) {
    const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
    await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: token.id });
  }
  return { token, a, b };
}

async function sharedScore(tx: Tx, tokenId: string) {
  const [row] = await tx
    .select({
      score: schema.tokens.isScamProbability,
      source: schema.tokens.scamScoreSource,
    })
    .from(schema.tokens)
    .where(eq(schema.tokens.id, tokenId));
  return row;
}

describe('a scam verdict is per user (SC-1160)', () => {
  test('marking a clean token as scam hides it for that user only', async () => {
    await withTestDb(async (tx) => {
      const { token, a, b } = await twoHolders(tx, 0);
      const before = await sharedScore(tx, token.id);

      await verdicts().setVerdict(a.id, token.id, 'scam', tx);

      expect(await holdings().findByUser(a.id, tx)).toHaveLength(0);
      expect(await holdings().findByUser(b.id, tx)).toHaveLength(1);
      expect(await sharedScore(tx, token.id)).toEqual(before);
    });
  });

  test('clearing a globally flagged token restores it for that user only', async () => {
    await withTestDb(async (tx) => {
      const { token, a, b } = await twoHolders(tx, 1);
      const before = await sharedScore(tx, token.id);

      await verdicts().setVerdict(a.id, token.id, 'not_scam', tx);

      expect(await holdings().findByUser(a.id, tx)).toHaveLength(1);
      expect(await holdings().findByUser(b.id, tx)).toHaveLength(0);
      expect(await sharedScore(tx, token.id)).toEqual(before);
    });
  });

  test('the projected score is the owner’s, so the badge and the totals agree', async () => {
    await withTestDb(async (tx) => {
      const { token, a, b } = await twoHolders(tx, 1);
      await verdicts().setVerdict(a.id, token.id, 'not_scam', tx);

      const [forA] = await holdings().findByUserWithFullDetails(a.id, undefined, tx, false, true);
      const [forB] = await holdings().findByUserWithFullDetails(b.id, undefined, tx, false, true);
      expect(forA?.token.isScamProbability).toBe(0);
      expect(forB?.token.isScamProbability).toBe(1);
    });
  });

  test('a later verdict replaces the earlier one', async () => {
    await withTestDb(async (tx) => {
      const { token, a } = await twoHolders(tx, 0);
      await verdicts().setVerdict(a.id, token.id, 'scam', tx);
      await verdicts().setVerdict(a.id, token.id, 'not_scam', tx);

      expect(await verdicts().findVerdict(a.id, token.id, tx)).toBe('not_scam');
      expect(await holdings().findByUser(a.id, tx)).toHaveLength(1);
    });
  });
});
