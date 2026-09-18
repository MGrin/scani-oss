import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as schema from '@scani/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingRepository } from '../../src/repositories/HoldingRepository';
import { UserTokenScamVerdictRepository } from '../../src/repositories/UserTokenScamVerdictRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

// SC-1160's conversion, run against rows shaped like the ones production holds:
// a GLOBAL `scam_score_source = 'user'` verdict that recorded no user. mgrin's
// ruling (Operator #11164, option a): every current holder gets a `migrated`
// verdict matching the value they see today, and the shared score goes back to
// the rescorer. What makes that safe to run unasked is that nobody's holdings
// list changes — so that is the first thing asserted.

const MIGRATION = readFileSync(
  join(
    import.meta.dir,
    '../../../../infra/db/src/migrations/20260918211942_sc1160_convert_global_user_scam_verdicts_to_per_user.sql'
  ),
  'utf8'
);

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];
const holdings = () => Container.get(HoldingRepository);
const runMigration = (tx: Tx) => tx.execute(sql.raw(MIGRATION));

async function stockType(tx: Tx) {
  const [existing] = await tx
    .select()
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'stock'));
  if (existing) return existing;
  const [row] = await tx
    .insert(schema.tokenTypes)
    .values({ code: 'stock', name: 'Stock' })
    .returning();
  return row!;
}

async function holderOf(tx: Tx, tokenId: string) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId });
  return user;
}

async function verdictsFor(tx: Tx, tokenId: string) {
  return tx
    .select({
      userId: schema.userTokenScamVerdicts.userId,
      verdict: schema.userTokenScamVerdicts.verdict,
      source: schema.userTokenScamVerdicts.source,
    })
    .from(schema.userTokenScamVerdicts)
    .where(eq(schema.userTokenScamVerdicts.tokenId, tokenId));
}

async function tokenRow(tx: Tx, tokenId: string) {
  const [row] = await tx
    .select({
      score: schema.tokens.isScamProbability,
      source: schema.tokens.scamScoreSource,
      version: schema.tokens.scamScoreVersion,
    })
    .from(schema.tokens)
    .where(eq(schema.tokens.id, tokenId));
  return row!;
}

describe('SC-1160 conversion of global user verdicts', () => {
  test('a cleared token: each holder keeps seeing it, and the score returns to the rescorer', async () => {
    await withTestDb(async (tx) => {
      const token = await makeToken(tx, {
        isScamProbability: 0,
        scamScoreSource: 'user',
        scamScoreVersion: 3,
      });
      const [a, b] = [await holderOf(tx, token.id), await holderOf(tx, token.id)];
      const before = [
        (await holdings().findByUser(a.id, tx)).length,
        (await holdings().findByUser(b.id, tx)).length,
      ];

      await runMigration(tx);

      expect([
        (await holdings().findByUser(a.id, tx)).length,
        (await holdings().findByUser(b.id, tx)).length,
      ]).toEqual(before);
      const rows = await verdictsFor(tx, token.id);
      expect(rows).toHaveLength(2);
      for (const row of rows)
        expect(row).toMatchObject({ verdict: 'not_scam', source: 'migrated' });
      expect(await tokenRow(tx, token.id)).toEqual({
        score: 0,
        source: 'heuristic',
        version: null,
      });
    });
  });

  test('a row at 1.0 came from the deleted markAsScam and becomes scam, not not_scam', async () => {
    await withTestDb(async (tx) => {
      const token = await makeToken(tx, { isScamProbability: 1, scamScoreSource: 'user' });
      const holder = await holderOf(tx, token.id);

      await runMigration(tx);

      expect(await verdictsFor(tx, token.id)).toEqual([
        { userId: holder.id, verdict: 'scam', source: 'migrated' },
      ]);
      expect(await holdings().findByUser(holder.id, tx)).toHaveLength(0);
    });
  });

  test('a non-crypto row goes to unscored at 0, since the rescorer never scores it', async () => {
    await withTestDb(async (tx) => {
      const type = await stockType(tx);
      const token = await makeToken(tx, {
        typeId: type.id,
        isScamProbability: 1,
        scamScoreSource: 'user',
      });
      const holder = await holderOf(tx, token.id);

      await runMigration(tx);

      expect(await tokenRow(tx, token.id)).toEqual({ score: 0, source: 'unscored', version: null });
      // Its holder still sees it as a scam — their verdict carried the value.
      expect(await holdings().findByUser(holder.id, tx)).toHaveLength(0);
    });
  });

  test('a verdict a holder already gave wins, and a second run changes nothing', async () => {
    await withTestDb(async (tx) => {
      const token = await makeToken(tx, { isScamProbability: 0, scamScoreSource: 'user' });
      const holder = await holderOf(tx, token.id);
      await Container.get(UserTokenScamVerdictRepository).setVerdict(
        holder.id,
        token.id,
        'scam',
        tx
      );

      await runMigration(tx);
      await runMigration(tx);

      expect(await verdictsFor(tx, token.id)).toEqual([
        { userId: holder.id, verdict: 'scam', source: 'user' },
      ]);
    });
  });

  // The control: a token nobody gave a global verdict on is left alone, or the
  // migration is rewriting the rescorer's own rows.
  test('a heuristic row is untouched and gets no verdicts', async () => {
    await withTestDb(async (tx) => {
      const token = await makeToken(tx, {
        isScamProbability: 0.9,
        scamScoreSource: 'heuristic',
        scamScoreVersion: 3,
      });
      await holderOf(tx, token.id);

      await runMigration(tx);

      expect(await verdictsFor(tx, token.id)).toEqual([]);
      expect(await tokenRow(tx, token.id)).toEqual({
        score: 0.9,
        source: 'heuristic',
        version: 3,
      });
      const [stillUser] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.tokens)
        .where(and(eq(schema.tokens.id, token.id), eq(schema.tokens.scamScoreSource, 'user')));
      expect(stillUser?.n).toBe(0);
    });
  });
});
