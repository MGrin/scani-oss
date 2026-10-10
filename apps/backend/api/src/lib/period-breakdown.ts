import { type DatabaseTransaction, getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import {
  type PeriodBreakdown,
  periodBreakdown,
} from '@scani/domain/lib/portfolio/period-breakdown';
import { PortfolioValueDailyRepository } from '@scani/domain/repositories';
import { and, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';

/**
 * `portfolio.getPeriodBreakdown` (SC-1692): the period's per-holding rows, the
 * same set the user-wide series sums, with each holding's symbol, account and
 * account type. `tx` is for the benchmark, which measures this exact path.
 */
export async function loadPeriodBreakdown(
  userId: string,
  baseCurrencyId: string,
  from: Date,
  to: Date,
  tx?: DatabaseTransaction
): Promise<PeriodBreakdown> {
  const rows = await Container.get(PortfolioValueDailyRepository).findIncludedHoldingScopeRange(
    userId,
    baseCurrencyId,
    from,
    to,
    tx
  );
  const holdingIds = [...new Set(rows.map((row) => row.holdingId))];
  const meta =
    holdingIds.length === 0
      ? []
      : await (tx ?? getDb())
          .select({
            id: schema.holdings.id,
            symbol: schema.tokens.symbol,
            accountName: schema.accounts.name,
            typeCode: schema.accountTypes.code,
            typeName: schema.accountTypes.name,
          })
          .from(schema.holdings)
          .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
          .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
          .innerJoin(schema.accountTypes, eq(schema.accountTypes.id, schema.accounts.typeId))
          .where(and(eq(schema.holdings.userId, userId), inArray(schema.holdings.id, holdingIds)));
  return periodBreakdown(
    rows,
    new Map(
      meta.map((m) => [
        m.id,
        {
          symbol: m.symbol,
          accountName: m.accountName,
          accountType: { code: m.typeCode, name: m.typeName },
        },
      ])
    )
  );
}
