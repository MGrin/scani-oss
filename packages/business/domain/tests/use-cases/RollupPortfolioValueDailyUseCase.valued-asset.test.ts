import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { ValuedAssetService } from '../../src/services/assets/ValuedAssetService';
import { CreateValuedAssetUseCase } from '../../src/use-cases/CreateValuedAssetUseCase';
import { RollupPortfolioValueDailyUseCase } from '../../src/use-cases/RollupPortfolioValueDailyUseCase';

/**
 * The daily rollup over a valued asset (SC-1643): nothing before the purchase,
 * the purchase price from it, and on a day with two valuations the later one.
 * Committed rows, because the rollup reads through the process-wide handle.
 */

const DAY = 86_400_000;
const now = Date.now();
const dayAgo = (n: number) => new Date(now - n * DAY).toISOString().slice(0, 10);
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

test('the rollup values a valued asset from its purchase date, the later same-day row winning', async () => {
  const [eur] = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
    .where(and(eq(schema.tokens.symbol, 'EUR'), eq(schema.tokenTypes.code, 'fiat')));
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `va-${randomUUID().slice(0, 8)}@scani.local`,
      name: 'VA',
      baseCurrencyId: eur!.id,
    })
    .returning();
  userIds.push(user!.id);

  const { holdingId, tokenId } = await Container.get(CreateValuedAssetUseCase).execute(
    {
      name: 'Car',
      currencyCode: 'EUR',
      purchaseDate: dayAgo(5),
      purchasePrice: '20000',
      currentValue: '15000',
      details: { kind: 'vehicle', make: 'VW' },
    },
    user!
  );
  tokenIds.push(tokenId);
  const assets = Container.get(ValuedAssetService);
  await assets.addValuation({ holdingId, occurredOn: dayAgo(3), value: '18000' }, user!.id);
  await assets.addValuation({ holdingId, occurredOn: dayAgo(3), value: '17000' }, user!.id);

  await Container.get(RollupPortfolioValueDailyUseCase).execute({
    userId: user!.id,
    lookbackDays: 8,
    // After the writes: the current value is stamped when the asset is created.
    runStart: new Date(),
  });
  const rows = await db
    .select({
      day: schema.portfolioValueDaily.snapshotDate,
      total: schema.portfolioValueDaily.totalValue,
    })
    .from(schema.portfolioValueDaily)
    .where(
      and(
        eq(schema.portfolioValueDaily.userId, user!.id),
        eq(schema.portfolioValueDaily.scopeKind, 'user')
      )
    )
    .orderBy(asc(schema.portfolioValueDaily.snapshotDate));
  const byDay = new Map(rows.map((r) => [String(r.day), Number(r.total)]));

  expect(byDay.get(dayAgo(6)) ?? 0).toBe(0);
  expect(byDay.get(dayAgo(5))).toBe(20000);
  expect(byDay.get(dayAgo(4))).toBe(20000);
  expect(byDay.get(dayAgo(3))).toBe(17000);
  expect(byDay.get(dayAgo(1))).toBe(17000);
  expect(byDay.get(dayAgo(0))).toBe(15000);
});
