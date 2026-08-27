import { describe, expect, test } from 'bun:test';
import {
  buildProcedureCallUpsert,
  createProcedureCallRecorder,
  type ProcedureCallTally,
} from '../src/procedure-call-recorder';

function collector() {
  const flushes: ProcedureCallTally[][] = [];
  const write = async (tallies: ProcedureCallTally[]) => {
    flushes.push(tallies);
  };
  return { flushes, write };
}

describe('procedure call recorder', () => {
  test('a flush writes one tally per distinct procedure, with the call counts', async () => {
    const { flushes, write } = collector();
    const rec = createProcedureCallRecorder(write, { flushIntervalMs: 60_000 });

    rec.record('holdings.getWithDetails');
    rec.record('holdings.getWithDetails');
    rec.record('users.getCurrent');
    await rec.flush();

    expect(flushes).toHaveLength(1);
    const byName = Object.fromEntries(flushes[0]!.map((t) => [t.procedure, t.calls]));
    expect(byName).toEqual({ 'holdings.getWithDetails': 2, 'users.getCurrent': 1 });
  });

  test('the buffer is cleared by a flush, so counts are not written twice', async () => {
    const { flushes, write } = collector();
    const rec = createProcedureCallRecorder(write, { flushIntervalMs: 60_000 });

    rec.record('a.one');
    await rec.flush();
    rec.record('a.one');
    await rec.flush();

    // Two flushes of 1 each — not a second flush of 2. Adding rather than
    // replacing happens in SQL, so a recorder that failed to clear would
    // double-count every procedure on every flush after the first.
    expect(flushes.map((f) => f[0]!.calls)).toEqual([1, 1]);
  });

  /**
   * The property this pins is a COST one, not a tidiness one. Neon scales to
   * zero and this repo aligns its scheduled probes so that it can. A recorder
   * that wrote on a fixed schedule would hold the database awake for the life
   * of the process and turn an idle deployment into a billed one.
   *
   * Asserting "no write happens" alone would pass on a recorder that never
   * writes at all, so the must-be-FOUND arm sits in the same test: the same
   * recorder, having been given something to say, must write.
   */
  test('an idle recorder writes nothing — and the same recorder writes when it has something', async () => {
    const { flushes, write } = collector();
    const rec = createProcedureCallRecorder(write, { flushIntervalMs: 5 });

    await rec.flush();
    await Bun.sleep(30);
    expect(flushes).toHaveLength(0); // must-be-ABSENT: nothing recorded, nothing written

    rec.record('a.one');
    await Bun.sleep(30);
    expect(flushes).toHaveLength(1); // must-be-FOUND: the timer does fire once armed
    expect(flushes[0]![0]!.procedure).toBe('a.one');
  });

  test('a failing write is swallowed, and the recorder keeps working afterwards', async () => {
    const flushes: ProcedureCallTally[][] = [];
    let failNext = true;
    const write = async (tallies: ProcedureCallTally[]) => {
      if (failNext) {
        failNext = false;
        throw new Error('connection terminated');
      }
      flushes.push(tallies);
    };
    const rec = createProcedureCallRecorder(write, { flushIntervalMs: 60_000 });

    rec.record('a.one');
    // A rejection here would propagate into a tRPC request or the shutdown
    // handler — a bookkeeping failure taking down the thing it was counting.
    await rec.flush();
    expect(flushes).toHaveLength(0);

    rec.record('a.two');
    await rec.flush();
    expect(flushes).toHaveLength(1);
    expect(flushes[0]![0]!.procedure).toBe('a.two');
  });

  test('pending() names the buffered procedures and empties on flush', async () => {
    const { write } = collector();
    const rec = createProcedureCallRecorder(write, { flushIntervalMs: 60_000 });

    expect(rec.pending()).toEqual([]);
    rec.record('a.one');
    rec.record('a.one');
    expect(rec.pending()).toEqual(['a.one']);
    await rec.flush();
    expect(rec.pending()).toEqual([]);
  });

  /**
   * `first_seen_at` dates the whole record: an absent row means "not called
   * since recording began", and `min(first_seen_at)` is the only thing that
   * says when that was. Advancing it on conflict would silently shorten every
   * observation window already quoted — no error, no failing row, no diff
   * anyone would question.
   *
   * The hazard is that omitting one column from an upsert's `set` reads as an
   * oversight, so the damaging edit looks like a one-line completion. A
   * comment cannot refuse that edit; this reads the SQL drizzle actually
   * generates.
   *
   * Both arms are needed. `not.toContain` alone passes vacuously against an
   * empty string or a builder that stopped emitting an update clause at all —
   * which is why the found-arm asserts the columns that MUST be updated.
   */
  test('the upsert never advances first_seen_at', () => {
    const { sql: rendered } = buildProcedureCallUpsert([
      { procedure: 'a.one', calls: 1, lastSeenAt: new Date('2026-08-28T00:00:00Z') },
    ]).toSQL();

    const update = rendered.slice(rendered.indexOf('do update set'));
    expect(update).not.toBe(''); // the population exists before anything is asserted absent

    // must-be-FOUND: the two columns a flush is supposed to move
    expect(update).toContain('"calls"');
    expect(update).toContain('"last_seen_at"');
    // must-be-ABSENT: the column that dates the record
    expect(update).not.toContain('"first_seen_at"');

    // and it IS written on insert — otherwise "absent from the update" would
    // be satisfied by a column nothing ever sets.
    expect(rendered.slice(0, rendered.indexOf('do update set'))).toContain('"first_seen_at"');
  });

  test('every tally in one flush carries the same timestamp', async () => {
    const { flushes, write } = collector();
    const at = new Date('2026-08-28T00:00:00.000Z');
    const rec = createProcedureCallRecorder(write, { flushIntervalMs: 60_000, now: () => at });

    rec.record('a.one');
    rec.record('b.two');
    await rec.flush();

    expect(flushes[0]!.map((t) => t.lastSeenAt.toISOString())).toEqual([
      at.toISOString(),
      at.toISOString(),
    ]);
  });
});
