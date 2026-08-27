/**
 * SC-754 — the never-fired list, and the three ways it can be a lie.
 *
 * Each arm below names the mistake it reddens on, because an assertion whose
 * reddening input is the CORRECT change is worse than no assertion at all
 * (SC-729): it punishes the person fixing the defect, with the authority of the
 * suite.
 *
 *     an empty table producing a full list    -> `an empty table produces NO list`
 *     the window ending at `now`              -> `the window ends at the last recorded call`
 *     a threshold deciding what to report     -> `no length of silence changes what is reported`
 *
 * EVERY PROCEDURE NAME HERE IS FICTIONAL, and that is a requirement rather than
 * a style. This file is tracked, so it sits inside the population
 * `api-procedure-callers` scans, and that census treats a comment exactly like
 * code. A real path written here would make this file a CALLER of it — moving
 * it out of the set both tools exist to find, in the direction that
 * under-reports dead surface silently.
 */

import { describe, expect, test } from 'bun:test';
import {
  humanDuration,
  type ProcedureCallRow,
  readCensusOutput,
  report,
} from '../lib/api-procedure-silence';

const CENSUS = ['alpha.list', 'beta.create', 'gamma.everything', 'delta.archive'];
/** Two of the four, so each half of the never-fired split has a member. */
const NO_CALLER = ['gamma.everything', 'delta.archive'];

const at = (iso: string) => new Date(iso);

function row(procedure: string, firstSeen: string, lastSeen: string, calls = 1): ProcedureCallRow {
  return {
    procedure,
    calls,
    firstSeenAt: at(firstSeen),
    lastSeenAt: at(lastSeen),
  };
}

/**
 * `first_seen_at` and `last_seen_at` are deliberately NOT ordered the same way
 * across these rows, and the earliest/latest are not the first/last element.
 * An implementation reading `rows[0]`, or reading the wrong column for either
 * end of the window, gets a different answer on every one of them.
 */
const ROWS: ProcedureCallRow[] = [
  row('beta.create', '2026-06-10T00:00:00Z', '2026-08-01T00:00:00Z', 7),
  row('alpha.list', '2026-05-01T00:00:00Z', '2026-07-15T00:00:00Z', 40),
  row('epsilon.removed', '2026-06-01T00:00:00Z', '2026-08-20T00:00:00Z', 3),
];
const NOW = at('2026-08-28T00:00:00Z');

describe('an empty table produces NO list', () => {
  /**
   * The defect this exists for: `census - keys` over an empty table equals the
   * whole api, so a list printed there names every procedure whether nothing
   * has been called or nothing has been RECORDED. The two render identically
   * and only one is a fact about the procedures.
   */
  const result = report({ apiProcedures: CENSUS, noCaller: NO_CALLER, rows: [], now: NOW });

  test('the verdict says the recorder produced nothing, not that the api is silent', () => {
    expect(result.verdict).toBe('NO RECORDING');
  });

  test('there is no procedure list on that arm to print', () => {
    // The claim is STRUCTURAL: the union's `NO RECORDING` member has no
    // `neverFired` field, so a caller cannot reach one. An assertion that the
    // list is empty would pass just as well against a field that exists and
    // happens to be `[]`, which the next person could then fill in.
    expect('neverFired' in result).toBe(false);
    expect('window' in result).toBe(false);
  });

  test('the denominator is still reported, so the reader knows what was NOT listed', () => {
    expect(result.censusCount).toBe(4);
    expect(result.rowCount).toBe(0);
  });
});

describe('the never-fired list is the difference, and it is split but never widened', () => {
  const result = report({ apiProcedures: CENSUS, noCaller: NO_CALLER, rows: ROWS, now: NOW });
  if (result.verdict !== 'REPORT') throw new Error('expected a REPORT verdict');

  test('never fired is census minus the recorded keys', () => {
    // `epsilon.removed` has a row and is not in the census, so it must not
    // suppress anything; `alpha.list` and `beta.create` have rows.
    expect(result.neverFired).toEqual(['delta.archive', 'gamma.everything']);
  });

  test('the split is exhaustive and disjoint — it cannot add or drop a procedure', () => {
    expect([...result.neverFiredAndNoCaller, ...result.neverFiredWithCaller].sort()).toEqual(
      result.neverFired
    );
    expect(
      result.neverFiredAndNoCaller.filter((p) => result.neverFiredWithCaller.includes(p))
    ).toEqual([]);
  });

  /**
   * The membership itself, not just the shape — because the exhaustive-and-
   * disjoint arm above is satisfied perfectly by a classifier that puts
   * everything in one bucket.
   *
   * This fixture gives BOTH never-fired procedures to `noCaller`, so the second
   * half is legitimately empty here. The must-be-FOUND arm for that half is the
   * NEXT describe, which is the only place `neverFiredWithCaller` is ever seen
   * non-empty — delete it and a bucket nothing has ever landed in becomes
   * indistinguishable from one that cannot be reached.
   */
  test('when neither has a caller, both land in the first half and the second is empty', () => {
    expect(result.neverFiredAndNoCaller).toEqual(['delta.archive', 'gamma.everything']);
    expect(result.neverFiredWithCaller).toEqual([]);
  });

  test('a recorded procedure the router no longer defines is reported, not swallowed', () => {
    expect(result.recordedNotInCensus).toEqual(['epsilon.removed']);
  });

  test('the totals are the ones a reader can check the lists against', () => {
    expect(result.censusCount).toBe(4);
    expect(result.rowCount).toBe(3);
    expect(result.totalCalls).toBe(50);
  });
});

describe('a caller in the tree moves a procedure between halves and nothing else', () => {
  // The must-be-FOUND arm for the other bucket: same rows, one procedure now
  // has an in-repo caller. Without this the `neverFiredWithCaller` list has
  // never been seen non-empty, and a bucket nothing has ever landed in is
  // indistinguishable from one that cannot be reached.
  const result = report({
    apiProcedures: CENSUS,
    noCaller: ['delta.archive'],
    rows: ROWS,
    now: NOW,
  });
  if (result.verdict !== 'REPORT') throw new Error('expected a REPORT verdict');

  test('the same never-fired set is split differently', () => {
    expect(result.neverFired).toEqual(['delta.archive', 'gamma.everything']);
    expect(result.neverFiredAndNoCaller).toEqual(['delta.archive']);
    expect(result.neverFiredWithCaller).toEqual(['gamma.everything']);
  });
});

describe('the window ends at the last recorded call', () => {
  const result = report({ apiProcedures: CENSUS, noCaller: NO_CALLER, rows: ROWS, now: NOW });
  if (result.verdict !== 'REPORT') throw new Error('expected a REPORT verdict');

  test('it begins at the earliest first_seen_at, across all rows', () => {
    // `2026-05-01` belongs to the SECOND row, so `rows[0].firstSeenAt` reds.
    expect(result.window.from.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  test('it ends at the latest last_seen_at — NOT at `now`', () => {
    // The defect: reading the window as `[first_seen, now]` asserts the
    // recorder was observing for the whole period. It only observes while the
    // api is up, so a deployment that stopped a month ago would silently
    // lengthen every window anybody quotes.
    expect(result.window.to.toISOString()).toBe('2026-08-20T00:00:00.000Z');
    expect(result.window.spanMs).toBe(
      at('2026-08-20T00:00:00Z').getTime() - at('2026-05-01T00:00:00Z').getTime()
    );
  });

  test('the gap to now is reported separately and is non-zero here', () => {
    // A `to = now` implementation makes this 0, which is the reading that says
    // "the recorder was watching right up to this moment".
    expect(result.window.gapToNowMs).toBe(8 * 86_400_000);
  });
});

describe('no length of silence changes what is reported', () => {
  /**
   * The ticket's central constraint: print the date and let the reader judge,
   * do NOT bake in a default observation window. A constant here would later be
   * read as a decision the deployment's operator has not made.
   *
   * Reddening input: any threshold — "only report if the window exceeds N",
   * "mark these as stale after N" — introduced anywhere in `report()`.
   */
  const oneDayAfterRecordingStarted = at('2026-05-02T00:00:00Z');
  const twoYearsAfter = at('2028-05-01T00:00:00Z');

  const early = report({
    apiProcedures: CENSUS,
    noCaller: NO_CALLER,
    rows: ROWS,
    now: oneDayAfterRecordingStarted,
  });
  const late = report({
    apiProcedures: CENSUS,
    noCaller: NO_CALLER,
    rows: ROWS,
    now: twoYearsAfter,
  });
  if (early.verdict !== 'REPORT' || late.verdict !== 'REPORT') {
    throw new Error('expected REPORT verdicts');
  }

  test('a one-day-old record and a two-year-old one produce the same lists', () => {
    expect(early.neverFired).toEqual(late.neverFired);
    expect(early.neverFiredAndNoCaller).toEqual(late.neverFiredAndNoCaller);
    expect(early.recordedNotInCensus).toEqual(late.recordedNotInCensus);
  });

  test('only the gap to now differs, and it is a number the reader judges', () => {
    expect(early.window.from).toEqual(late.window.from);
    expect(early.window.to).toEqual(late.window.to);
    expect(early.window.gapToNowMs).not.toBe(late.window.gapToNowMs);
  });
});

describe('a census that produced nothing is refused, never resolved', () => {
  /**
   * Every arm here is a shape a DYING subprocess actually produces, and every
   * one of them would otherwise flow downstream as a census of no procedures —
   * making `census - keys` empty, which prints as *nothing is never-fired*.
   * That is the reassuring reading, so it is the one that has to be
   * unreachable.
   */
  const good = JSON.stringify({ apiProcedures: CENSUS, noCaller: NO_CALLER });

  test('the must-be-FOUND control: real census output is accepted', () => {
    // Without this arm every assertion below is satisfied by a function that
    // refuses everything, which would be a check with one reachable answer.
    const read = readCensusOutput(0, good, '');
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreachable');
    expect(read.apiProcedures).toEqual(CENSUS);
    expect(read.noCaller).toEqual(NO_CALLER);
  });

  test('a non-zero exit is refused, and the census stderr is carried through', () => {
    const read = readCensusOutput(2, '', 'api-procedure-callers: REFUSED · NOTHING MEASURED');
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.why.join('\n')).toContain('exited 2');
    // The reason belongs to the census and only it knows why; dropping it
    // leaves a reader with a refusal that names no cause.
    expect(read.why.join('\n')).toContain('NOTHING MEASURED');
  });

  test('a killed process — null exit code — is refused', () => {
    const read = readCensusOutput(null, '', '');
    expect(read.ok).toBe(false);
  });

  test('exit 0 with empty output is refused rather than read as an empty census', () => {
    const read = readCensusOutput(0, '   \n', '');
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.why.join('\n')).toContain('wrote nothing');
  });

  test('output truncated mid-document is refused rather than parsed as far as it goes', () => {
    const read = readCensusOutput(0, good.slice(0, 30), '');
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.why.join('\n')).toContain('not JSON');
  });

  test('valid JSON carrying an EMPTY denominator is refused', () => {
    // The quiet one: it parses, it has the right keys, and it makes every
    // later set difference vacuously empty.
    const read = readCensusOutput(0, JSON.stringify({ apiProcedures: [], noCaller: [] }), '');
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error('unreachable');
    expect(read.why.join('\n')).toContain('shape has changed');
  });

  test('valid JSON of the wrong shape is refused', () => {
    expect(readCensusOutput(0, JSON.stringify({ procedures: CENSUS }), '').ok).toBe(false);
    expect(readCensusOutput(0, JSON.stringify({ apiProcedures: CENSUS }), '').ok).toBe(false);
  });
});

describe('humanDuration', () => {
  test('renders the two largest non-zero units', () => {
    expect(humanDuration(90 * 86_400_000 + 5 * 3_600_000)).toBe('90d 5h');
    expect(humanDuration(5 * 3_600_000 + 30 * 60_000)).toBe('5h 30m');
    expect(humanDuration(45 * 60_000)).toBe('45m');
    expect(humanDuration(0)).toBe('0m');
  });

  test('a negative duration keeps its sign rather than clamping to zero', () => {
    // A `last_seen_at` ahead of this machine's clock means skew between here
    // and the database. Clamping renders the one input that indicates a broken
    // instrument as the healthiest possible reading.
    expect(humanDuration(-3 * 86_400_000)).toBe('-3d 0h');
    expect(humanDuration(-90_000)).toBe('-1m');
  });
});
