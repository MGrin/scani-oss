import { spyOn } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import type { User } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { asc, eq, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { EngineEvidenceRepository } from '../../src/repositories/EngineEvidenceRepository';
import { EngineShadowReportRepository } from '../../src/repositories/EngineShadowReportRepository';

export function differencesOf(tx: DatabaseTransaction, runId: string) {
  const d = schema.engineShadowDifferences;
  return tx.select().from(d).where(eq(d.runId, runId)).orderBy(asc(d.at), asc(d.id));
}

export async function runRow(tx: DatabaseTransaction, runId: string) {
  const [row] = await tx
    .select()
    .from(schema.engineShadowRuns)
    .where(eq(schema.engineShadowRuns.id, runId));
  if (!row) throw new Error(`run ${runId} was not recorded`);
  return row;
}

/** The ids of the runs `recordRun` stores from now until `restore`, whether or not the run throws. */
export function captureRunIds() {
  const reports = Container.get(EngineShadowReportRepository);
  const record = reports.recordRun.bind(reports);
  const ids: string[] = [];
  const spy = spyOn(reports, 'recordRun').mockImplementation(async (input, t) => {
    const id = await record(input, t);
    ids.push(id);
    return id;
  });
  return { ids, restore: () => spy.mockRestore() };
}

/** Narrows an all-users run to `users`, so its sums are exactly theirs. */
export function onlyUsers(users: ReadonlyArray<Pick<User, 'id' | 'baseCurrencyId'>>) {
  return spyOn(Container.get(EngineEvidenceRepository), 'findUsersWithHoldings').mockResolvedValue(
    users.map((u) => ({ userId: u.id, baseCurrencyId: u.baseCurrencyId }))
  );
}

/**
 * A run's setup failing with a database error, which aborts the transaction
 * it runs in: the failed run can only be stored outside it.
 */
export function failingShadowUsers() {
  return spyOn(Container.get(EngineEvidenceRepository), 'findUsersWithHoldings').mockImplementation(
    async (tx) => {
      if (!tx) throw new Error('the shadow users were read outside a snapshot');
      await tx.execute(sql`SELECT 1/0`);
      return [];
    }
  );
}

/**
 * Every byte of the evidence tables, prices included, and the engine-writer
 * guard's state. Counts cannot see a stray UPDATE; a hash of each row's whole
 * content can.
 */
export async function evidenceFingerprint(tx: DatabaseTransaction) {
  const digest = (table: string) =>
    sql`(SELECT md5(coalesce(string_agg(to_jsonb(t)::text, '' ORDER BY t.id), '')) FROM ${sql.identifier(table)} t)`;
  const [row] = (await tx.execute(sql`
    SELECT
      ${digest('holdings')} AS holdings,
      ${digest('holding_balance_observations')} AS observations,
      ${digest('holding_transactions')} AS ledger,
      ${digest('token_prices')} AS prices,
      (SELECT tgenabled FROM pg_trigger
        WHERE tgname = 'holdings_engine_writer_guard' AND tgrelid = 'holdings'::regclass) AS guard
  `)) as unknown as Array<{
    holdings: string;
    observations: string;
    ledger: string;
    prices: string;
    guard: string;
  }>;
  if (!row) throw new Error('fingerprint query returned no row');
  return row;
}
