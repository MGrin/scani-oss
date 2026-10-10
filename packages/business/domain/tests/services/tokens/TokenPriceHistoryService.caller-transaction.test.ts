import { expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { TokenPriceHistoryService } from '../../../src/services/tokens/TokenPriceHistoryService';
import { withTestDb } from '../../../test/helpers/db';
import { makeUser } from '../../../test/helpers/factories';
import { makeToken } from '../../../test/helpers/factories-extra';

/**
 * A valued asset creates its token, holding and first valuation in one
 * transaction (SC-1643), so `createCustomToken` must write inside the
 * caller's. The base currency below exists only in that uncommitted
 * transaction: a create that opened its own could not see it and would fail.
 */
test('createCustomToken writes inside a caller transaction, and its rollback takes the token', async () => {
  let tokenId = '';
  await withTestDb(async (tx) => {
    const [fiat] = await tx
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'fiat'));
    const symbol = `Z${crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    await makeToken(tx, { symbol, typeId: fiat!.id });
    const user = await makeUser(tx);

    const token = await new TokenPriceHistoryService().createCustomToken(
      {
        symbol: 'FLAT',
        name: 'Flat',
        typeCode: 'property',
        manualPrice: 310000,
        baseCurrencyCode: symbol,
      },
      user.id,
      tx
    );
    tokenId = token.id;
    const [seen] = await tx.select().from(schema.tokens).where(eq(schema.tokens.id, token.id));
    expect(seen?.createdByUserId).toBe(user.id);
  });

  expect(tokenId).not.toBe('');
  const after = await getDb().select().from(schema.tokens).where(eq(schema.tokens.id, tokenId));
  expect(after).toEqual([]);
});
