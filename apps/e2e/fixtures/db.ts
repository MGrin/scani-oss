import { spawn } from 'node:child_process';

const DB_USER = 'scani';

/**
 * WHAT THIS FILE NO LONGER DOES, AND WHY (SC-494).
 *
 * It used to hold `const DB_NAME = 'scani'` and fall back to a container named
 * `mgrin-e2e-suite-postgres-1`. Both are wrong for any stack the runner did
 * not itself create — and a constant is worse than nothing here, because it
 * produces a CONFIDENT WRONG TARGET rather than a refusal.
 *
 * The measured failure: reusing a running `bun dev:stack` (Mode A), the
 * database that stack uses is `scani_dev_<label>_<hash>` (SC-429) while
 * `scani` also exists and is EMPTY — 0 tables. So the query errored on a
 * missing relation and the spec's `rows.length > 0` failed, reading as an
 * OTP-storage defect. The verdict was wrong about WHAT was broken, not about
 * whether something was.
 *
 * The expensive version has not happened yet and is why this was worth fixing
 * now: a spec asserting ABSENCE — "no plaintext OTP is stored" — passes
 * VACUOUSLY against an empty database. Nobody has written that spec, so the
 * fix is cheap today and the failure it prevents is not.
 *
 * So there is no fallback. `apps/e2e/scripts/run.ts` resolves the container
 * and the database from the api that actually answered its health probe, and
 * puts them here in the environment. If it could not, it puts the REASON here
 * instead and this file refuses with it.
 */
function resolveTarget(): { container: string; database: string } {
  const unresolved = process.env.E2E_DB_UNRESOLVED;
  if (unresolved) {
    throw new Error(
      `queryDb: NO QUERY WAS MADE — the runner could not determine which database this stack uses: ${unresolved}`
    );
  }
  const container = process.env.POSTGRES_CONTAINER;
  const database = process.env.E2E_DB_NAME;
  if (!container || !database) {
    // Naming the missing half matters: the two are set together, so one
    // present and one absent means something set it by hand.
    const missing = [!container && 'POSTGRES_CONTAINER', !database && 'E2E_DB_NAME']
      .filter(Boolean)
      .join(' and ');
    throw new Error(
      `queryDb: NO QUERY WAS MADE — ${missing} is not set. These are set by \`apps/e2e/scripts/run.ts\`; run the suite through \`bun run e2e\` rather than calling playwright directly.`
    );
  }
  return { container, database };
}

/**
 * Execute a SELECT against the stack's Postgres via `docker exec psql -tAc`.
 * Returns the raw stdout split by newline (each line is a row;
 * multi-column rows are `|`-delimited; caller parses).
 *
 * Used only by the specs that need a direct DB assertion the tRPC surface
 * doesn't expose (hashed-OTP storage check, cross-context state
 * verifications). Do NOT use this to seed test fixtures — tests should
 * drive everything through the real UI/API.
 */
export async function queryDb(sql: string): Promise<string[]> {
  const { container, database } = resolveTarget();
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'docker',
      ['exec', container, 'psql', '-U', DB_USER, '-d', database, '-tAc', sql],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      // The target is named in the failure on purpose: a psql error that does
      // not say which database it reached is the defect this file is about.
      if (code !== 0)
        return reject(new Error(`psql exited ${code} against ${container}/${database}: ${stderr}`));
      resolve(stdout.split('\n').filter((line) => line.length > 0));
    });
  });
}
