/**
 * The ABSENT rows — which no query against `api_procedure_calls` returns (SC-754).
 *
 * `api_procedure_calls` gets one row per procedure the api has SERVED. The
 * artefact SC-680 and SC-727 need is the opposite: the procedures with no row.
 * Those are absent by definition, so the answer cannot come from that table
 * alone. It comes from a difference:
 *
 *     neverFired = census(router) - keys(api_procedure_calls)
 *
 * with the table supplying only the negative and the router supplying the
 * denominator. `scripts/api-procedure-callers.ts` already walks the runtime
 * router, so the census is reused rather than rebuilt — which also means this
 * inherits its denominator's guarantees (a factory-built router and a mount key
 * that differs from its file name are both counted) and its limits.
 *
 * ## An EMPTY table is a fact about the RECORDER, never about the procedures
 *
 * With no rows, `census - keys` equals the whole census, and a list of every
 * procedure in the api renders identically whether nothing has been called or
 * nothing has been RECORDED. That is the fourth confident-zero shape: the
 * instrument works and the world has not produced the thing yet.
 *
 * So `report()` returns a DISCRIMINATED UNION and the `NO RECORDING` arm has no
 * `neverFired` field. A caller cannot print the list in that state because
 * there is no list to reach — making the state unreachable rather than handling
 * it, since a handled state can be handled wrongly by the next person.
 *
 * ## The window is bounded at BOTH ends, and the second end is the one missed
 *
 * `min(first_seen_at)` dates the start of recording. The obvious reading of the
 * other end is `now`, and it is wrong: the recorder only writes while the api
 * is up and serving. `max(last_seen_at)` is the last moment anything is known
 * to have been observed, and the gap between it and now is time in which a
 * stopped api and a quiet one are the same reading.
 *
 * Both ends and the gap are reported. NO THRESHOLD IS APPLIED TO ANY OF THEM.
 * What length of silence licenses a deletion belongs to whoever operates the
 * deployment being read, and a constant here would later be read as that
 * decision having been made for them.
 */

/**
 * What the census subprocess produced, or why it cannot be used.
 *
 * The reading is separated from the spawning so it can be driven with the
 * outputs a dying subprocess actually produces. A test that reached those by
 * corrupting the process — breaking `PATH`, say — would leak that state into
 * every other file in the run, since `bun test` uses one process (SC-730). The
 * seam is the fix; a `finally` is not.
 */
export type CensusRead =
  | { ok: true; apiProcedures: string[]; noCaller: string[] }
  | { ok: false; why: string[] };

/**
 * Four ways the census can hand back nothing, and they are not alike.
 *
 * A killed `Bun.spawn` returns a null exit code with EMPTY output, and empty
 * output would parse downstream as a census of no procedures — which makes the
 * difference `census - keys` empty, which prints as *nothing is never-fired*.
 * That is the reassuring direction, so every one of these has to refuse rather
 * than resolve toward a clean-looking answer.
 */
export function readCensusOutput(code: number | null, stdout: string, stderr: string): CensusRead {
  if (code !== 0) {
    return {
      ok: false,
      why: [
        `\`bun scripts/api-procedure-callers.ts --json\` exited ${code}`,
        ...stderr.trim().split('\n').filter(Boolean),
      ],
    };
  }
  if (stdout.trim() === '') {
    return {
      ok: false,
      why: ['the census exited 0 and wrote nothing — the process was almost certainly killed'],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    return {
      ok: false,
      why: [
        `the census output is not JSON: ${err instanceof Error ? err.message : String(err)}`,
        'a partial document means the process died part-way through writing it',
      ],
    };
  }

  const { apiProcedures, noCaller } = parsed as { apiProcedures?: unknown; noCaller?: unknown };
  // The population, asserted rather than assumed. The census refuses its own
  // floor at exit 2, so reaching here with an empty array means its output
  // SHAPE changed rather than that the router is small — and an empty
  // denominator makes every later difference vacuously empty. No number is
  // repeated from the census here: duplicating its floor would be a second
  // copy to drift.
  if (!Array.isArray(apiProcedures) || apiProcedures.length === 0 || !Array.isArray(noCaller)) {
    return {
      ok: false,
      why: ['the census returned no `apiProcedures` — its output shape has changed'],
    };
  }
  return { ok: true, apiProcedures: apiProcedures as string[], noCaller: noCaller as string[] };
}

/** One row of `api_procedure_calls`, as read. */
export interface ProcedureCallRow {
  procedure: string;
  calls: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface SilenceInput {
  /**
   * Every procedure the api's runtime router defines — the DENOMINATOR. Taken
   * from the census rather than counted here, so this module has no second
   * idea of what the api serves.
   */
  apiProcedures: string[];
  /**
   * Census procedures with no caller anywhere in the tracked tree. Used only to
   * SPLIT the never-fired list; it never adds to or removes from it.
   */
  noCaller: string[];
  rows: ProcedureCallRow[];
  now: Date;
}

// Not exported: it exists only as the shape of `SilenceReport.window`, and
// `deps:unused` correctly reports an exported type nothing outside imports.
interface ObservationWindow {
  /** `min(first_seen_at)` — when the first row was written. */
  from: Date;
  /** `max(last_seen_at)` — the last moment anything is known to have been observed. */
  to: Date;
  spanMs: number;
  /** `now - to`. Time in which the recorder produced no evidence either way. */
  gapToNowMs: number;
}

export type SilenceReport =
  | {
      /**
       * The table has no rows. There is deliberately no procedure list on this
       * arm: see the docblock above.
       */
      verdict: 'NO RECORDING';
      censusCount: number;
      rowCount: 0;
    }
  | {
      verdict: 'REPORT';
      censusCount: number;
      rowCount: number;
      totalCalls: number;
      window: ObservationWindow;
      /** Census procedures with no row. Sorted. */
      neverFired: string[];
      /** Never fired AND no caller in the tracked tree. A question, not a deletion list. */
      neverFiredAndNoCaller: string[];
      /** Never fired but something in the tree calls it. A different question. */
      neverFiredWithCaller: string[];
      /**
       * Rows naming a procedure the router no longer defines — removed,
       * renamed, or a sub-router that failed to mount. A disagreement between
       * the two instruments, which is a question rather than a finding.
       */
      recordedNotInCensus: string[];
    };

export function report(input: SilenceInput): SilenceReport {
  const censusCount = input.apiProcedures.length;

  if (input.rows.length === 0) {
    return { verdict: 'NO RECORDING', censusCount, rowCount: 0 };
  }

  const recorded = new Set(input.rows.map((r) => r.procedure));
  const census = new Set(input.apiProcedures);
  const noCaller = new Set(input.noCaller);

  const neverFired = [...census].filter((p) => !recorded.has(p)).sort();
  const recordedNotInCensus = [...recorded].filter((p) => !census.has(p)).sort();

  const from = new Date(Math.min(...input.rows.map((r) => r.firstSeenAt.getTime())));
  const to = new Date(Math.max(...input.rows.map((r) => r.lastSeenAt.getTime())));

  return {
    verdict: 'REPORT',
    censusCount,
    rowCount: input.rows.length,
    totalCalls: input.rows.reduce((n, r) => n + r.calls, 0),
    window: {
      from,
      to,
      spanMs: to.getTime() - from.getTime(),
      gapToNowMs: input.now.getTime() - to.getTime(),
    },
    neverFired,
    neverFiredAndNoCaller: neverFired.filter((p) => noCaller.has(p)),
    neverFiredWithCaller: neverFired.filter((p) => !noCaller.has(p)),
    recordedNotInCensus,
  };
}

/**
 * A duration a reader can judge, in the largest two units that are non-zero.
 *
 * Rendered rather than left as milliseconds because the whole point of the
 * window is that a person decides whether it is long enough, and nobody decides
 * that from `1209600000`. Negative inputs are rendered with a leading `-`
 * rather than clamped: a `last_seen_at` in the future means clock skew between
 * this machine and the database, and hiding it behind a `0` would make the one
 * reading that indicates a broken instrument look like the healthiest one.
 */
export function humanDuration(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const total = Math.abs(ms);
  const days = Math.floor(total / 86_400_000);
  const hours = Math.floor((total % 86_400_000) / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  if (days > 0) return `${sign}${days}d ${hours}h`;
  if (hours > 0) return `${sign}${hours}h ${minutes}m`;
  return `${sign}${minutes}m`;
}
