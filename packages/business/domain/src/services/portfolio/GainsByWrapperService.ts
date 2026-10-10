import { type DatabaseTransaction, getDb } from '@scani/db';
import type { WrapperTreatment } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { Decimal, HISTORY_REBUILD_JOB_NAME } from '@scani/shared';
import { and, desc, eq, gt, inArray, lt, lte } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { includedInTotalSql } from '../../lib/holding-inclusion';
import { type ReturnWindowRequest, resolveReturnWindow } from '../../lib/returns/window';
import { UserJobRepository } from '../../repositories/UserJobRepository';

const TREATMENTS: readonly WrapperTreatment[] = ['general', 'deferred', 'exempt', 'advantaged'];
// Sums of rollup rows carry dust such as -1e-24; eight places keeps a crypto base exact.
const DECIMAL_PLACES = 8;

export type GainsByWrapper =
  | { status: 'rebuilding'; anyWrapped: boolean }
  | {
      status: 'ok';
      buckets: {
        treatment: WrapperTreatment;
        realized: string;
        unrealized: string;
        accountCount: number;
      }[];
      anyWrapped: boolean;
      /** Holdings with no value on their last day, whose figures are from an earlier one. */
      carriedHoldings: number;
    };

/**
 * Gains over a window grouped by the bucket of each asset account's wrapper
 * (SC-1645). Read per HOLDING from the rollup: an account row leaves out a
 * holding it could not value that day, and with it that holding's lifetime
 * realized gain, so an end-minus-start read over account rows jumps on a
 * price gap (feeds, bus #24470). Each side takes the holding's last VALUED
 * row instead.
 */
@Service()
export class GainsByWrapperService {
  private readonly userJobs = Container.get(UserJobRepository);

  async compute(
    userId: string,
    window: ReturnWindowRequest,
    now: Date,
    tx?: DatabaseTransaction
  ): Promise<GainsByWrapper> {
    // A rebuild rewrites rows newest first and not atomically, so mid-rebuild
    // the end row can be from the new walk and the start row from the old.
    const db = tx ?? getDb();
    const accounts = await db
      .select({
        id: schema.accounts.id,
        wrapper: schema.accounts.wrapper,
        treatment: schema.accountWrappers.treatment,
      })
      .from(schema.accounts)
      .innerJoin(schema.accountTypes, eq(schema.accountTypes.id, schema.accounts.typeId))
      .leftJoin(schema.accountWrappers, eq(schema.accountWrappers.code, schema.accounts.wrapper))
      .where(and(eq(schema.accounts.userId, userId), eq(schema.accountTypes.class, 'asset')));
    const anyWrapped = accounts.some((account) => account.wrapper !== null);
    if (await this.userJobs.findInFlightByName(userId, HISTORY_REBUILD_JOB_NAME, tx)) {
      return { status: 'rebuilding', anyWrapped };
    }
    const { from, to } = resolveReturnWindow(window, now);
    const fromDay = from.toISOString().slice(0, 10);
    const toDay = to.toISOString().slice(0, 10);

    const sums = new Map(
      TREATMENTS.map((t) => [
        t,
        { realized: new Decimal(0), unrealized: new Decimal(0), accounts: 0 },
      ])
    );
    const treatmentOf = new Map<string, WrapperTreatment>();
    for (const account of accounts) {
      const treatment = account.treatment ?? 'general';
      treatmentOf.set(account.id, treatment);
      const sum = sums.get(treatment);
      if (sum) sum.accounts++;
    }

    const [user] = await db
      .select({ baseCurrencyId: schema.users.baseCurrencyId })
      .from(schema.users)
      .where(eq(schema.users.id, userId));
    let carriedHoldings = 0;
    if (user?.baseCurrencyId && accounts.length > 0) {
      const pvd = schema.portfolioValueDaily;
      const lastRow = (before: ReturnType<typeof lte>, valuedOnly: boolean) =>
        db
          .selectDistinctOn([pvd.scopeId], {
            holdingId: pvd.scopeId,
            accountId: schema.holdings.accountId,
            date: pvd.snapshotDate,
            realized: pvd.realizedPnl,
            unrealized: pvd.unrealizedPnl,
          })
          .from(pvd)
          .innerJoin(schema.holdings, eq(schema.holdings.id, pvd.scopeId))
          .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
          .where(
            and(
              eq(pvd.userId, userId),
              eq(pvd.scopeKind, 'holding'),
              eq(pvd.baseCurrencyId, user.baseCurrencyId as string),
              inArray(schema.holdings.accountId, [...treatmentOf.keys()]),
              // The holdings a total counts, as the value series and Returns read them.
              includedInTotalSql(),
              before,
              valuedOnly ? gt(pvd.holdingsWithKnownValue, 0) : undefined
            )
          )
          .orderBy(pvd.scopeId, desc(pvd.snapshotDate));

      const [ends, starts, latest] = await Promise.all([
        lastRow(lte(pvd.snapshotDate, toDay), true),
        lastRow(lt(pvd.snapshotDate, fromDay), true),
        lastRow(lte(pvd.snapshotDate, toDay), false),
      ]);
      const startOf = new Map(starts.map((row) => [row.holdingId, row.realized]));
      const latestDay = new Map(latest.map((row) => [row.holdingId, row.date]));
      for (const end of ends) {
        const sum = sums.get(treatmentOf.get(end.accountId) ?? 'general');
        if (!sum) continue;
        sum.realized = sum.realized.add(end.realized ?? 0).minus(startOf.get(end.holdingId) ?? 0);
        sum.unrealized = sum.unrealized.add(end.unrealized ?? 0);
        if (latestDay.get(end.holdingId) !== end.date) carriedHoldings++;
      }
    }

    return {
      status: 'ok',
      buckets: TREATMENTS.map((treatment) => {
        const sum = sums.get(treatment) ?? {
          realized: new Decimal(0),
          unrealized: new Decimal(0),
          accounts: 0,
        };
        return {
          treatment,
          realized: sum.realized.toDecimalPlaces(DECIMAL_PLACES).toString(),
          unrealized: sum.unrealized.toDecimalPlaces(DECIMAL_PLACES).toString(),
          accountCount: sum.accounts,
        };
      }),
      anyWrapped,
      carriedHoldings,
    };
  }
}
