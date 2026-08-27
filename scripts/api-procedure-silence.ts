#!/usr/bin/env bun
/**
 * Which api procedures have NOT been called — the absent rows (SC-754).
 *
 *   DATABASE_URL=... bun scripts/api-procedure-silence.ts
 *
 * READ ONLY. One `SELECT` against `api_procedure_calls` and one subprocess that
 * reads the router. There is no write path in this file and no flag that adds
 * one.
 *
 * The set arithmetic, why an empty table is a fact about the recorder rather
 * than about the procedures, and why the observation window is bounded at both
 * ends are in `scripts/lib/api-procedure-silence.ts`. Read that before quoting
 * anything from this.
 *
 * ## Four verdicts, and three of them produce NO LIST
 *
 *     exit 0   REPORT        rows exist; the never-fired list and the window
 *     exit 2   NO CENSUS     the router did not load, or the subprocess died
 *     exit 3   NO DATABASE   unreachable, unset, or the table does not exist
 *     exit 4   NO RECORDING  the table was reached and is EMPTY
 *
 * `NO RECORDING` is the one worth spelling out. With no rows the difference
 * `census - keys` is the entire api, so a list of every procedure would render
 * identically whether nothing has been called or the recorder has never run —
 * and that list, printed once, is the artefact somebody quotes. So it is not
 * printed. Same reason `gate-db` prints `NO TESTS RAN` rather than a pass: an
 * exit code cannot tell "everything is silent" from "nothing was observed".
 *
 * ## Why the census runs as a SUBPROCESS
 *
 * `scripts/api-procedure-callers.ts` forces `DATABASE_URL` to a dead address
 * before importing the two routers, deliberately, so that a census run by
 * somebody holding a production URL cannot reach production through the import
 * graph. This tool needs the real URL. Running the census in its own process
 * keeps both true without a second copy of that mechanism here — the routers
 * are never imported into a process that holds a live database handle, and
 * there is no duplicated safeguard to drift.
 *
 * The cost is that a subprocess can be KILLED, and a killed `Bun.spawn` returns
 * a null exit code and EMPTY output — which reads downstream as a census of
 * nothing, which would read as every procedure being never-fired. All four ways
 * that can happen are checked below and every one exits 2 saying NO LIST
 * PRODUCED.
 *
 * ## No procedure path is written literally in this file
 *
 * That census treats a comment exactly like code — deliberately, because a
 * prose-detecting heuristic hid all five URL-only callers when SC-728 was
 * measured. So a real procedure path spelled out in a file it scans makes that
 * file a CALLER of the procedure, moving it out of the very set both tools
 * exist to find. Do not add an example; nothing here needs one.
 *
 * THIS PARTICULAR FILE IS CURRENTLY OUTSIDE THAT POPULATION, AND THAT IS A BUG
 * RATHER THAN A LICENCE (SC-755). The census's pathspec puts `**` between two
 * slashes, and git requires an intermediate directory there — measured
 * 2026-08-28, it reaches 0 of the 67 `.ts` files sitting directly under
 * `scripts/` and 125 of 125 under `scripts/{lib,tests}/`. So the sibling lib and
 * test ARE scanned, this one is not, and it will be the day SC-755 lands.
 * Writing a real path here would be relying on a defect to stay unfixed.
 */

import { SQL } from 'bun';
import {
  humanDuration,
  type ProcedureCallRow,
  readCensusOutput,
  report,
} from './lib/api-procedure-silence';

const REPO_ROOT = new URL('..', import.meta.url).pathname;

function refuse(code: number, verdict: string, lines: string[]): never {
  process.stderr.write(
    `\napi-procedure-silence: ${verdict} · exit ${code} · NO LIST PRODUCED\n` +
      lines.map((l) => `  ${l}\n`).join('')
  );
  process.exit(code);
}

/**
 * The census, from its own process.
 *
 * Only the SPAWN is here; deciding whether what came back is usable is
 * `readCensusOutput`, which is pure and driven by the four failure shapes in
 * `scripts/tests/api-procedure-silence.test.ts`. Reaching those from a test of
 * this function would mean corrupting process-global state, and `bun test` runs
 * every file in one process.
 */
async function readCensus(): Promise<{ apiProcedures: string[]; noCaller: string[] }> {
  const proc = Bun.spawn(['bun', 'scripts/api-procedure-callers.ts', '--json'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const read = readCensusOutput(await proc.exited, stdout, stderr);
  if (!read.ok) refuse(2, 'NO CENSUS', read.why);
  return { apiProcedures: read.apiProcedures, noCaller: read.noCaller };
}

/** `host:port/database`, so the verdict names what it reached. Never the credentials. */
function describeDatabase(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '<unparseable DATABASE_URL>';
  }
}

async function readRows(url: string): Promise<ProcedureCallRow[]> {
  const db = new SQL(url, { max: 1 });
  try {
    const rows = await db`
      SELECT procedure, calls, first_seen_at, last_seen_at
      FROM api_procedure_calls
    `;
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      procedure: String(r.procedure),
      // `calls` is a bigint; postgres may hand it back as a string.
      calls: Number(r.calls),
      firstSeenAt: new Date(r.first_seen_at as string),
      lastSeenAt: new Date(r.last_seen_at as string),
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missingTable =
      (err as { code?: string })?.code === '42P01' ||
      /api_procedure_calls.*does not exist/.test(message);
    refuse(3, 'NO DATABASE', [
      `${describeDatabase(url)} — ${message}`,
      ...(missingTable
        ? [
            'the table does not exist in this database: the SC-742 migration has not been',
            'applied here. `bun run db:migrate` against the database you meant to read.',
          ]
        : []),
    ]);
  } finally {
    await db.close();
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  refuse(3, 'NO DATABASE', [
    "DATABASE_URL is unset. This tool reads a deployment's record of what it has served;",
    'there is no default, because the answer is only meaningful for one named database.',
  ]);
}

const { apiProcedures, noCaller } = await readCensus();
const rows = await readRows(url);
const result = report({ apiProcedures, noCaller, rows, now: new Date() });
const where = describeDatabase(url);

if (result.verdict === 'NO RECORDING') {
  refuse(4, 'NO RECORDING', [
    `${where} · \`api_procedure_calls\` has 0 rows · ${result.censusCount} procedure(s) in the census`,
    '',
    'This is a fact about the RECORDER, not about the procedures. With no rows every',
    'procedure is "absent", so a never-fired list here would name the whole api whether',
    'nothing has been called or nothing has been observed. It is not printed for that',
    'reason.',
    '',
    'Either the api carrying SC-742 has not been deployed against this database, or it',
    'has served no request since it was. Neither is answerable from this table.',
  ]);
}

const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z');
const pad = (n: number) => String(n).padStart(4);

const out: string[] = [
  '',
  `api-procedure-silence: REPORT · ${where}`,
  '',
  `  census (runtime router)                 ${pad(result.censusCount)}   <- the denominator`,
  `  procedures with a row                   ${pad(result.rowCount)}`,
  `  NEVER FIRED (no row at all)             ${pad(result.neverFired.length)}`,
  `    and no caller in this tree            ${pad(result.neverFiredAndNoCaller.length)}`,
  `    but something in this tree calls it   ${pad(result.neverFiredWithCaller.length)}`,
  `  recorded calls, all procedures          ${pad(result.totalCalls)}`,
  '',
  '  Observation window — JUDGE THIS BEFORE READING THE LISTS. No length of',
  '  silence is treated as significant here, deliberately: what licenses a',
  '  deletion is a decision nobody has made, and a constant in this tool would',
  '  later read as that decision having been made.',
  '',
  `    recording began       ${iso(result.window.from)}   (min first_seen_at)`,
  `    last recorded call    ${iso(result.window.to)}   (max last_seen_at)`,
  `    span                  ${humanDuration(result.window.spanMs)}`,
  `    since last call       ${humanDuration(result.window.gapToNowMs)}   <- no evidence either way in this period`,
  '',
];

if (result.neverFiredAndNoCaller.length > 0) {
  out.push('  NEVER FIRED, and no caller in this tree — the strongest evidence available,');
  out.push('  and still A QUESTION rather than a deletion list (SC-680):');
  for (const p of result.neverFiredAndNoCaller) out.push(`    ${p}`);
  out.push('');
}

if (result.neverFiredWithCaller.length > 0) {
  out.push('  NEVER FIRED, but this tree contains a caller — a different question: the');
  out.push('  call site exists and nothing has exercised it in the window above.');
  for (const p of result.neverFiredWithCaller) out.push(`    ${p}`);
  out.push('');
}

if (result.recordedNotInCensus.length > 0) {
  out.push(
    `  ${result.recordedNotInCensus.length} recorded procedure(s) the router no longer defines — removed or`
  );
  out.push('  renamed since they were last served, or a sub-router that failed to mount:');
  for (const p of result.recordedNotInCensus) out.push(`    ${p}`);
  out.push('');
}

out.push('  What this cannot say:');
out.push('    - when a procedure was ADDED. One added after recording began has a shorter');
out.push('      effective window than the one above, and this table holds no column that');
out.push("      could say so. Its absence is weaker evidence than an old procedure's.");
out.push('    - anything about the gap between the last recorded call and now. A stopped');
out.push('      api and a quiet one write the same nothing.');
out.push('    - an exact total. The recorder buffers and flushes, so counts lose whatever');
out.push('      was unflushed when a machine went away. Presence and recency are the');
out.push('      load-bearing facts and neither is affected by a lost partial minute.');
out.push('    - whether a caller exists OUTSIDE this repository. The split above comes');
out.push('      from `api-procedure-callers`, which sees only tracked files in this tree');
out.push('      — not a dynamic call, not a saved request, not an integration nobody');
out.push('      wrote down. That is why the first list is a QUESTION for whoever operates');
out.push('      this deployment, and never a deletion list (SC-680).');
out.push('    - how many callers that split missed. While SC-755 is open the census');
out.push('      excludes every script sitting directly under `scripts/`, which can only');
out.push('      UNDER-count callers — so the first list above is a CEILING and the second');
out.push('      is a floor. Close SC-755 before acting on either.');
out.push('');

console.log(out.join('\n'));
