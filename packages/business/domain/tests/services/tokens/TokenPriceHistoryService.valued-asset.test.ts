import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { TokenPriceHistoryService } from '../../../src/services/tokens/TokenPriceHistoryService';
import { CreateValuedAssetUseCase } from '../../../src/use-cases/CreateValuedAssetUseCase';

/**
 * Review I1 (SC-1643): a valued asset is valued only through its own history,
 * in its own currency. The generic custom-price edit writes in whatever
 * currency it is handed, so a USD row beside an asset kept in EUR became the
 * holding's value while its history still read the EUR one. Committed rows:
 * the edit opens its own transaction.
 */
const userIds: string[] = [];
const tokenIds: string[] = [];

afterAll(async () => {
  const accounts = await db
    .select({ institutionId: schema.accounts.institutionId })
    .from(schema.accounts)
    .where(inArray(schema.accounts.userId, userIds));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  if (tokenIds.length) await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokenIds));
  const institutionIds = accounts.map((a) => a.institutionId).filter((id): id is string => !!id);
  if (institutionIds.length)
    await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutionIds));
});

test('the generic custom-price edit refuses a valued asset', async () => {
  const [eur] = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
    .where(and(eq(schema.tokens.symbol, 'EUR'), eq(schema.tokenTypes.code, 'fiat')));
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `vae-${randomUUID().slice(0, 8)}@scani.local`,
      name: 'VA',
      baseCurrencyId: eur!.id,
    })
    .returning();
  userIds.push(user!.id);
  const { tokenId } = await new CreateValuedAssetUseCase().execute(
    {
      name: 'Flat',
      currencyCode: 'EUR',
      purchaseDate: '2021-04-12',
      purchasePrice: '310000',
      details: { kind: 'property' },
    },
    user!
  );
  tokenIds.push(tokenId);

  await expect(
    new TokenPriceHistoryService().updateCustomTokenPrice({
      tokenId,
      newPrice: 400000,
      baseCurrencyCode: 'USD',
      userId: user!.id,
    })
  ).rejects.toThrow(/valuation/i);
});
