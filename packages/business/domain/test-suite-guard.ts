/**
 * One test suite per database, enforced at preload.
 *
 * WHY THIS EXISTS (SC-372). `bun run test` sets no DATABASE_URL, so
 * `test-preload.ts` defaults it to the shared compose database on :5433 and
 * every suite on this Mac lands in the same one. Two of those at once is not
 * a flake, it is two processes writing one database:
 *
 *   - `fixture-isolation.test.ts` counts every row in `tokens` before and
 *     inside its transaction. A neighbour COMMITTING a token between the two
 *     counts fails it (168 vs 169). `withTestDb` rolls this process's writes
 *     back; it cannot roll back another process's.
 *   - `RollupPortfolioValueDailyUseCase` sweeps EVERY user with a base
 *     currency, so the neighbour's sweep takes the per-user advisory lock on
 *     THIS process's fixture users and this run's rollup legitimately skips
 *     them. The lock keys do not collide — the user rows are shared.
 *
 * Neither failure carries any mark of whose run caused it, and that is the
 * actual harm: SC-369's gate ran beside another suite and surfaced two REAL
 * defects, so a noisy run is not worthless — it is unattributable. The cure
 * is one suite per database, not one suite per machine, because with CI dead
 * account-wide (SC-128) the local suite is the only signal a PR gets and
 * serialising the machine would mean never gating two branches at once.
 *
 * A run given a database of its own never contends, so this guard never fires
 * for one. It fires for the bare `bun run test` path, which is the one that
 * shares whatever DATABASE_URL already points at.
 *
 * A session-level advisory lock rather than a row or a lock file: it is
 * atomic against a simultaneous start, it is scoped to the DATABASE (so a
 * gate run is automatically in its own namespace), and it dies with the
 * connection, so a killed suite leaves nothing to clean up.
 */

import postgres from 'postgres';

/**
 * Arbitrary but fixed. Advisory-lock keys share one namespace per database,
 * so this must not be a value `advisoryLockKey()` can produce for a real
 * lock name — it is far outside the FNV-1a output the app uses in practice,
 * and the app's locks are taken on app databases rather than this one.
 */
export const SUITE_LOCK_KEY = 372_372_372_372n;

export interface SuiteHolder {
  /** OS pid of the holding `bun test`, carried in `application_name`. */
  pid: string;
  /** Postgres backend pid, for `pg_terminate_backend` if it is a zombie. */
  backendPid: number;
  startedAt: string;
}

export type SuiteLockOutcome =
  | { kind: 'acquired' }
  | { kind: 'busy'; holder: SuiteHolder | null }
  | { kind: 'unreachable'; reason: string };

const APP_NAME_PREFIX = 'scani-test-suite:';

export function databaseNameOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, '') || '<unknown>';
  } catch {
    return '<unparseable>';
  }
}

export function busyMessage(url: string, holder: SuiteHolder | null): string {
  const who = holder
    ? `pid ${holder.pid} (postgres backend ${holder.backendPid}), connected ${holder.startedAt}`
    : 'another process (it disconnected while we looked it up)';
  return (
    `Refusing to run: another test suite already holds database "${databaseNameOf(url)}".\n` +
    `  Holder: ${who}\n\n` +
    'Two suites on one database interfere in ways nothing in the output attributes\n' +
    "to a run: whole-table counts see the neighbour's committed rows, and the\n" +
    "portfolio rollup takes advisory locks on the neighbour's fixture users\n" +
    '(SC-370, SC-372). A failure would be yours or theirs with no way to tell.\n\n' +
    'Give this run its own database — two runs can then go at once. Any empty\n' +
    'database this run can reach will do; the lines below are the compose route\n' +
    'this repo ships:\n' +
    '  docker compose exec -T postgres createdb -U scani scani_test_$$\n' +
    '  DATABASE_URL=postgres://scani:scani@localhost:5433/scani_test_$$ \\\n' +
    '    bun run db:migrate && bun run test\n\n' +
    'To share the database deliberately: SCANI_ALLOW_SHARED_TEST_DB=1\n'
  );
}

/**
 * Takes the lock and keeps the connection open for the life of the process.
 * The caller is not given a release handle on purpose: the lock must outlive
 * every test in the run, and the only correct release is process exit.
 */
export async function acquireSuiteLock(
  url: string,
  options: { key?: bigint; pid?: string } = {}
): Promise<SuiteLockOutcome> {
  const key = options.key ?? SUITE_LOCK_KEY;
  const pid = options.pid ?? String(process.pid);
  const sql = postgres(url, {
    max: 1,
    onnotice: () => {},
    connect_timeout: 5,
    connection: { application_name: `${APP_NAME_PREFIX}${pid}` },
  });

  try {
    const rows = await sql<Array<{ locked: boolean }>>`
      select pg_try_advisory_lock(${key.toString()}::bigint) as locked`;
    if (rows[0]?.locked === true) return { kind: 'acquired' };
  } catch (error) {
    await sql.end({ timeout: 0 }).catch(() => {});
    return { kind: 'unreachable', reason: error instanceof Error ? error.message : String(error) };
  }

  let holder: SuiteHolder | null = null;
  try {
    const rows = await sql<Array<{ app: string; backend: number; started: string }>>`
      select a.application_name as app, a.pid as backend, a.backend_start::text as started
      from pg_locks l
      join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'advisory'
        and l.granted
        and l.objsubid = 1
        and l.classid::bigint * 4294967296 + l.objid::bigint = ${key.toString()}::bigint
        and a.pid <> pg_backend_pid()
      limit 1`;
    const row = rows[0];
    if (row) {
      holder = {
        pid: row.app.startsWith(APP_NAME_PREFIX) ? row.app.slice(APP_NAME_PREFIX.length) : row.app,
        backendPid: row.backend,
        startedAt: row.started,
      };
    }
  } catch {
    // Reporting the holder is a courtesy; refusing is the contract.
  }

  await sql.end({ timeout: 0 }).catch(() => {});
  return { kind: 'busy', holder };
}

/**
 * The one NODE_ENV this suite is allowed to run under.
 *
 * WHY THIS EXISTS (SC-399). `bun test` sets `NODE_ENV=test` itself, but only
 * when nothing already set it — and a WRAPPER can set it without meaning to.
 * Bun auto-loads a root `.env` into every program it starts, `.env.example`
 * (the file the quick start says to copy) sets `NODE_ENV=development`. Any
 * wrapper that is itself a `bun` program therefore loads `development` into
 * its own environment, spawns `bun run test` with it inherited as a real
 * variable, and the runner's own default never applies. The whole suite then
 * runs in DEVELOPMENT mode.
 *
 * That is not cosmetic. `@scani/logging` picks its default level off the same
 * variable, so `loadLoggingConfig({}).level` is `debug` under development and
 * `info` otherwise: one gate failure with nothing to do with the change under
 * test. Measured 2026-08-19 on 6231515c — 6630 pass / 1 fail with a copied
 * `.env`, 6635 / 0 with the pin below.
 *
 * Two traps in verifying it, both of which report green:
 *   - `bun test <that file>` is unwrapped, so the runner's default applies.
 *   - a bare `bun run test` is too: measured 2026-08-19, `bun run` does not
 *     promote a `.env` value over the runner's default. Only an extra `bun`
 *     process in front does, so verifying without such a wrapper cannot see
 *     this bug at all.
 *
 * `.github/workflows/ci.yml` sets `NODE_ENV: test` for the test job, so `test`
 * is what the suite is specified to run under; the root `test` script now
 * pins the same value, which is the choke point every wrapper goes through.
 * This guard is what notices if either stops doing it, because the symptom
 * otherwise is one unrelated assertion in 6600.
 *
 * Refuse rather than normalise: silently rewriting the value would make the
 * pin removable without consequence, and the next person to hit this would
 * again be told a passing suite is a correct one.
 */
export const EXPECTED_NODE_ENV = 'test';

export function nodeEnvRefusal(value: string | undefined): string | null {
  if (value === EXPECTED_NODE_ENV) return null;
  const found = value === undefined ? '<unset>' : `"${value}"`;
  return (
    `Refusing to run: the test suite must run with NODE_ENV=${EXPECTED_NODE_ENV}, found ${found}.\n\n` +
    'NODE_ENV changes what the code under test does — @scani/logging alone\n' +
    'switches its default level on it — so a suite run under another value\n' +
    'fails assertions that have nothing to do with your change (SC-399).\n\n' +
    'The usual cause is a root `.env` — every checkout has one now, written\n' +
    'from `.env.example` by scripts/sync-env.ts, and that file sets\n' +
    'NODE_ENV=development (SC-474). Bun loads it into any\n' +
    'program it starts, including any wrapper that is itself a `bun` program,\n' +
    'which then passes it down as a real variable and suppresses\n' +
    "`bun test`'s own NODE_ENV=test default.\n\n" +
    'Run the suite the way CI does — the root `test` script pins the value:\n' +
    '  bun run test\n'
  );
}
