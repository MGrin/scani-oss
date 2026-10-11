import { afterAll, describe, expect, test } from 'bun:test';
import { hostname } from 'node:os';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../src/connection';
import { procedureCallRecorder } from '../src/procedure-call-recorder';
import { apiProcedureMinutes } from '../src/schema/api-procedure-minutes';

/**
 * SC-1689, against a real database and through the shipped singleton, so a
 * recorder built without its minutes writer turns this red. Each probe name is
 * unique to this file; rows are deleted after.
 */

const PROBES = ['sc1689.probeA', 'sc1689.probeB', 'sc1689.otherMachine', 'sc1689.old'];

afterAll(async () => {
  await db.delete(apiProcedureMinutes).where(inArray(apiProcedureMinutes.procedure, PROBES));
});

/** Two flushes must land in one minute; start clear of the boundary. */
async function awayFromMinuteBoundary() {
  const seconds = new Date().getUTCSeconds();
  if (seconds >= 55) await Bun.sleep((61 - seconds) * 1000);
}

describe('api_procedure_minutes (SC-1689)', () => {
  test('a spike at minute M on machine X: one query names the procedures that finished there', async () => {
    await awayFromMinuteBoundary();
    const machine = process.env.FLY_MACHINE_ID ?? hostname();
    procedureCallRecorder.complete('sc1689.probeA', { durationMs: 900, loopBlockedMs: 40 });
    procedureCallRecorder.complete('sc1689.probeB', { durationMs: 5, loopBlockedMs: 0 });
    await procedureCallRecorder.flush();
    // A second flush into the same minute adds to the row rather than replacing it.
    procedureCallRecorder.complete('sc1689.probeA', { durationMs: 1200, loopBlockedMs: 10 });
    await procedureCallRecorder.flush();

    const [written] = await db
      .select({ minute: apiProcedureMinutes.minute })
      .from(apiProcedureMinutes)
      .where(eq(apiProcedureMinutes.procedure, 'sc1689.probeA'));
    const minute = written!.minute;
    // The control: the same minute on another machine must not be named.
    await db.insert(apiProcedureMinutes).values({
      minute,
      machine: 'another-machine',
      procedure: 'sc1689.otherMachine',
      calls: 1,
      maxDurationMs: 1,
      maxLoopBlockedMs: 0,
      maxRssMb: 900,
    });

    const named = (await db.execute(sql`
      select procedure, calls, max_duration_ms, max_loop_blocked_ms
        from api_procedure_minutes
       where machine = ${machine} and minute = date_trunc('minute', ${minute.toISOString()}::timestamptz)
         and procedure like 'sc1689.%'
       order by procedure
    `)) as unknown as Array<Record<string, unknown>>;
    expect(named.map((r) => ({ ...r }))).toEqual([
      { procedure: 'sc1689.probeA', calls: 2, max_duration_ms: 1200, max_loop_blocked_ms: 40 },
      { procedure: 'sc1689.probeB', calls: 1, max_duration_ms: 5, max_loop_blocked_ms: 0 },
    ]);
  });

  test('a flush prunes rows older than 14 days and keeps the rest', async () => {
    const minuteAgo = (days: number) => {
      const t = Date.now() - days * 86_400_000;
      return new Date(t - (t % 60_000));
    };
    const row = (minute: Date) => ({
      minute,
      machine: 'another-machine',
      procedure: 'sc1689.old',
      calls: 1,
      maxDurationMs: 1,
      maxLoopBlockedMs: 0,
      maxRssMb: 1,
    });
    await db.insert(apiProcedureMinutes).values([row(minuteAgo(15)), row(minuteAgo(13))]);

    procedureCallRecorder.complete('sc1689.probeB', { durationMs: 1, loopBlockedMs: 0 });
    await procedureCallRecorder.flush();

    const left = await db
      .select({ minute: apiProcedureMinutes.minute })
      .from(apiProcedureMinutes)
      .where(eq(apiProcedureMinutes.procedure, 'sc1689.old'));
    expect(left.map((r) => r.minute.toISOString())).toEqual([minuteAgo(13).toISOString()]);
  });
});
