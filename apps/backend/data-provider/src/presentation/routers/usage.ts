/**
 * Usage dashboard read-API for cloud-frontend.
 *
 * Aggregates from `cloud_usage_events` (Postgres) — subject-scoped to the
 * authenticated cloud user so tenants cannot see each other's numbers.
 */

import { cloudUsageEvents } from '@scani/db';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { CloudDb } from '../../db/connection';
import { cookieProcedure, router } from '../trpc';

interface UsageDeps {
  db: CloudDb | null;
}

let deps: UsageDeps = { db: null };

export function installUsageDeps(next: UsageDeps): void {
  deps = next;
}

function requireClient(): CloudDb {
  if (!deps.db) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Cloud management is disabled (database unavailable)',
    });
  }
  return deps.db;
}

const rangeSchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .default({});

function resolveRange(input: { from?: string; to?: string }, defaultDays: number) {
  const to = input.to ? new Date(input.to) : new Date();
  const from = input.from
    ? new Date(input.from)
    : new Date(to.getTime() - defaultDays * 24 * 3600 * 1000);
  return { from, to };
}

const subjectWhere = (subject: string, from: Date, to: Date) =>
  and(
    eq(cloudUsageEvents.subject, subject),
    gte(cloudUsageEvents.occurredAt, from),
    lte(cloudUsageEvents.occurredAt, to)
  );

export const usageRouter = router({
  summary: cookieProcedure.input(rangeSchema).query(async ({ ctx, input }) => {
    const db = requireClient();
    const { from, to } = resolveRange(input, 7);
    const subject = ctx.cloudUser.id;

    const outcomeRows = await db
      .select({
        outcome: cloudUsageEvents.outcome,
        cnt: sql<number>`count(*)::int`,
      })
      .from(cloudUsageEvents)
      .where(subjectWhere(subject, from, to))
      .groupBy(cloudUsageEvents.outcome);

    let total = 0;
    let errors = 0;
    for (const row of outcomeRows) {
      total += row.cnt;
      if (row.outcome !== 'ok') {
        errors += row.cnt;
      }
    }

    const [costRow] = await db
      .select({
        totalCost: sql<string>`coalesce(sum(${cloudUsageEvents.upstreamCostUsd}), 0)::text`,
      })
      .from(cloudUsageEvents)
      .where(subjectWhere(subject, from, to));

    const totalCostUsd = Number(costRow?.totalCost ?? 0);

    return {
      totalRequests: total,
      totalCostUsd,
      errorRate: total === 0 ? 0 : errors / total,
    };
  }),

  daily: cookieProcedure.input(rangeSchema).query(async ({ ctx, input }) => {
    const db = requireClient();
    const { from, to } = resolveRange(input, 30);
    const subject = ctx.cloudUser.id;
    const dayBucket = sql`date_trunc('day', ${cloudUsageEvents.occurredAt} AT TIME ZONE 'UTC')`;

    const rows = await db
      .select({
        day: sql<string>`to_char(${dayBucket}, 'YYYY-MM-DD')`,
        requests: sql<number>`count(*)::int`,
        errors: sql<number>`count(*) filter (where ${cloudUsageEvents.outcome} <> 'ok')::int`,
      })
      .from(cloudUsageEvents)
      .where(subjectWhere(subject, from, to))
      .groupBy(dayBucket)
      .orderBy(dayBucket);

    return rows.map((r) => ({ day: r.day, requests: r.requests, errors: r.errors }));
  }),

  breakdown: cookieProcedure.input(rangeSchema).query(async ({ ctx, input }) => {
    const db = requireClient();
    const { from, to } = resolveRange(input, 7);
    const subject = ctx.cloudUser.id;
    const sw = subjectWhere(subject, from, to);

    const byRouteRes = await db
      .select({
        route: cloudUsageEvents.route,
        requests: sql<number>`count(*)::int`,
      })
      .from(cloudUsageEvents)
      .where(sw)
      .groupBy(cloudUsageEvents.route)
      .orderBy(desc(sql`count(*)`));

    const byProviderRes = await db
      .select({
        provider: cloudUsageEvents.provider,
        costUsd: sql<string>`coalesce(sum(${cloudUsageEvents.upstreamCostUsd}), 0)::text`,
      })
      .from(cloudUsageEvents)
      .where(sw)
      .groupBy(cloudUsageEvents.provider)
      .orderBy(desc(sql`coalesce(sum(${cloudUsageEvents.upstreamCostUsd}), 0)`));

    return {
      byRoute: byRouteRes.map((r) => ({ route: r.route, requests: r.requests })),
      byProvider: byProviderRes.map((r) => ({
        provider: r.provider,
        costUsd: Number(r.costUsd),
      })),
    };
  }),
});
