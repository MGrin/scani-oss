/**
 * One `docs:check` runner for the test files that spawn it, so a killed
 * subprocess refuses instead of returning zeros (SC-730).
 *
 * `Bun.spawnSync` reports a killed child as `exitCode: null` with EMPTY stdout
 * and stderr, while the field is declared `number`. Six test files consumed
 * that as though the check had reported something:
 *
 *     the check reported no problems   exitCode 0     text
 *     the check found a problem        exitCode 1     text
 *     the process was KILLED           exitCode null  ''
 *
 * So `expect(exitCode).toBe(0)` collapsed "reported nothing wrong" and "never
 * ran" onto one value — the `ESRCH`-vs-`EPERM` shape, where a check that could
 * not look is indistinguishable from one that looked and found nothing.
 *
 * The empty output is the worse half, and it is worse in both directions.
 * Downstream it reads as "the scratch tree has no files", so every inventory
 * check fails at once: 42 errors naming every router, scheduled job and
 * package, and not one naming the dead subprocess — the signature SC-694 spent
 * a day diagnosing. Where the caller instead asks whether the check FIRED
 * (`output.includes(...)`), empty output answers `false` and the assertion
 * passes GREEN over a check that never ran.
 *
 * SC-694 raised the per-test budget to 30s, which makes the kill rare rather
 * than impossible: a saturated box or a CI runner can still cross it, and when
 * it does the failure is exactly as misdirected as it was before.
 *
 * `command` exists so the guard can be tested through a real spawn that really
 * dies, rather than by breaking `PATH` — process-global mutation leaks into
 * every other file in the run, which is how a test once broke two files it
 * never touched.
 */

export type CheckDocsRun = {
  /** Never `null`: a killed run throws rather than reaching a caller. */
  exitCode: number;
  output: string;
};

export type RunCheckDocsOptions = {
  /** Passed through untouched; omitted entirely when absent, as before. */
  env?: Record<string, string | undefined>;
  /** Test seam. Defaults to the real `docs:check` invocation. */
  command?: string[];
};

export function runCheckDocs(repoRoot: string, options: RunCheckDocsOptions = {}): CheckDocsRun {
  const command = options.command ?? ['bun', 'scripts/check-docs.ts'];
  const run = Bun.spawnSync(command, {
    cwd: repoRoot,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const output = `${run.stdout.toString()}${run.stderr.toString()}`;

  if (run.exitCode === null) {
    throw new Error(
      `\`${command.join(' ')}\` was killed by ${run.signalCode ?? 'an unknown signal'} and ` +
        'produced no output. Bun reports that as `exitCode: null` with empty stdout and stderr, ' +
        'so an assertion on 0 or 1 would read "never ran" as a verdict, and the empty output ' +
        'would read downstream as an empty tree — missing routers, jobs and packages that are ' +
        'all present. Nothing in this run is evidence about the repository. Re-run it; if it ' +
        'keeps dying, the box is out of room rather than the tree out of files.'
    );
  }

  return { exitCode: run.exitCode, output };
}
