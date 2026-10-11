/**
 * The value shadow against Postgres (SC-1610). Its control is the ticket's: a
 * newer price for one token makes exactly that token's holding differ, named,
 * until the cache is revalued.
 */

import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { ValueShadowService } from '../../../src/services/foundation/ValueShadowService';
import { PriceHubResolver } from '../../../src/services/pricing/PriceHubResolver';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

const T0 = new Date('2026-10-06T10:00:00.000Z');
const AS_OF = new Date('2026-10-07T00:00:00.000Z');

async function price(tx: Tx, tokenId: string, baseTokenId: string, value: string, at: Date) {
  await tx.insert(schema.tokenPrices).values({
    tokenId,
    baseTokenId,
    price: value,
    timestamp: at,
    granularity: 'intraday',
    source: 'fixture',
  });
}

async function differences(tx: Tx, runId: string) {
  return tx
    .select()
    .from(schema.engineShadowDifferences)
    .where(eq(schema.engineShadowDifferences.runId, runId));
}

describe('ValueShadowService (SC-1610)', () => {
  test('a newer price makes exactly its holding differ until it is revalued', async () => {
    await withTestDb(async (tx) => {
      const [usd] = await Container.get(PriceHubResolver).hubTokenIds(tx);
      if (!usd) throw new Error('USD did not resolve');
      const user = await makeUser(tx, { baseCurrencyId: usd });
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const moved = await makeToken(tx);
      const still = await makeToken(tx);
      const holdings = [];
      for (const [token, balance] of [
        [moved.id, '2'],
        [still.id, '3'],
        [usd, '50'],
      ] as const) {
        holdings.push(
          await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: token, balance })
        );
      }
      await price(tx, moved.id, usd, '10', T0);
      await price(tx, still.id, usd, '7', T0);
      const writer = Container.get(HoldingCacheWriter);
      const shadow = Container.get(ValueShadowService);
      const ids = holdings.map((h) => h.id);

      await writer.revalue(user.id, ids, T0, tx);
      const clean = await shadow.run({ asOf: AS_OF, userId: user.id }, tx);
      expect(clean.summary).toMatchObject({ compared: 3, matched: 3, byCategory: {} });

      const later = new Date(T0.getTime() + 3_600_000);
      await price(tx, moved.id, usd, '11', later);
      const control = await shadow.run({ asOf: AS_OF, userId: user.id }, tx);
      expect(control.summary).toMatchObject({
        compared: 3,
        matched: 2,
        byCategory: { 'price-moved-since': 1 },
      });
      const [named] = await differences(tx, control.runId);
      expect(named).toMatchObject({
        holdingId: holdings[0]?.id,
        comparator: 'cache-vs-live',
        engineValue: '20',
        legacyValue: '22',
      });

      await writer.revalueAffected([{ tokenId: moved.id, baseTokenId: usd }], AS_OF, { tx });
      const after = await shadow.run({ asOf: AS_OF, userId: user.id }, tx);
      expect(after.summary).toMatchObject({ compared: 3, matched: 3 });
    });
  });
});
