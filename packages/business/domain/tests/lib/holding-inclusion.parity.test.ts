import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { SCAM_PROBABILITY_THRESHOLD } from '../../src/lib/constants';
import { isIncludedInTotal } from '../../src/lib/holding-inclusion';
import { HoldingRepository } from '../../src/repositories/HoldingRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeInstitutionType, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

/**
 * One inclusion rule, two shapes (SC-1486). The value series and the flow side
 * filter in SQL (`includedInTotalSql`, through `findIdsIncludedInTotal`);
 * valuation-at-time and the headline use `isIncludedInTotal`. A holding one
 * shape counts and the other drops is a residual that never closes: hidden
 * holdings kept their flows and lost their value and PnL for exactly that
 * reason. So every combination is put to both, and they must agree.
 */
describe('the inclusion rule reads the same in SQL and in TypeScript (SC-1486)', () => {
  test('every hidden / hiddenBy / active / scam combination', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const instType = await makeInstitutionType(tx);
      const inst = await makeInstitution(tx, { typeId: instType.id });
      const account = await makeAccount(tx, { userId: user.id, institutionId: inst.id });
      const clean = await makeToken(tx, { isScamProbability: 0 });
      const scam = await makeToken(tx, { isScamProbability: SCAM_PROBABILITY_THRESHOLD });

      const cases: Array<{
        isHidden: boolean;
        hiddenBy: 'user' | 'auto' | null;
        isActive: boolean;
        scam: boolean;
      }> = [];
      for (const isHidden of [false, true])
        for (const hiddenBy of [null, 'user', 'auto'] as const)
          for (const isActive of [true, false])
            for (const isScam of [false, true])
              cases.push({ isHidden, hiddenBy, isActive, scam: isScam });

      const rows: Array<{
        c: (typeof cases)[number];
        h: typeof schema.holdings.$inferSelect;
        token: typeof schema.tokens.$inferSelect;
      }> = [];
      for (const c of cases) {
        const token = c.scam ? scam : clean;
        const h = await makeHolding(tx, {
          userId: user.id,
          accountId: account.id,
          tokenId: token.id,
          isHidden: c.isHidden,
          hiddenBy: c.hiddenBy,
          isActive: c.isActive,
        });
        rows.push({ c, h, token });
      }

      const ids = rows.map((r) => r.h.id);
      const sqlIncluded = await Container.get(HoldingRepository).findIdsIncludedInTotal(ids, tx);
      const disagreements = rows
        .filter(
          (r) =>
            sqlIncluded.has(r.h.id) !==
            isIncludedInTotal(
              { isHidden: r.c.isHidden, hiddenBy: r.c.hiddenBy, isActive: r.c.isActive },
              { isScamProbability: r.token.isScamProbability }
            )
        )
        .map((r) => r.c);
      expect(disagreements).toEqual([]);

      // A control that could fail: the sweep's holding is in, the owner's is out.
      const of = (c: (typeof cases)[number]) =>
        rows.find(
          (r) =>
            r.c.isHidden === c.isHidden &&
            r.c.hiddenBy === c.hiddenBy &&
            r.c.isActive === c.isActive &&
            r.c.scam === c.scam
        )?.h.id ?? '';
      expect(
        sqlIncluded.has(of({ isHidden: true, hiddenBy: 'auto', isActive: true, scam: false }))
      ).toBe(true);
      expect(
        sqlIncluded.has(of({ isHidden: true, hiddenBy: 'user', isActive: true, scam: false }))
      ).toBe(false);
      expect(
        (await tx.select().from(schema.holdings).where(inArray(schema.holdings.id, ids))).length
      ).toBe(cases.length);
    });
  });
});
