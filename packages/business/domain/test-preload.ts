import { setDefaultTimeout } from 'bun:test';

/**
 * The per-test budget, for EVERY test in the repo (SC-737).
 *
 * `bunfig.toml` cannot supply one: bun reads `[test]` and silently drops a
 * `timeout` key, so an ad-hoc `bun test <path>` runs on bun's 5000ms default
 * while `bun run test` gets 30s from `--timeout` on argv (SC-694). The two
 * invocations therefore disagreed, and only the by-hand one could die — which
 * is the worst direction, because it dies under exactly the load that made
 * somebody want a quick answer.
 *
 * SC-694 closed that per-file, with `setDefaultTimeout(30_000)` at the top of
 * each file that needed it. SC-737 asked what enumerates that class, and the
 * answer measured out as: nothing can. 53 files under `scripts/tests/` spawn a
 * subprocess and 8 carried a budget, so the obvious predicate is wrong 45 times
 * in 53 — and spawn CALL-SITE count INVERTS against the ground truth
 * (`oss-eligibility.test.ts` 15 sites and no budget; the eight at 1-3 each,
 * below the median). The cost is spawns x tests-executed x per-spawn cost and
 * none of those three is visible in the source.
 *
 * So the class is emptied rather than enumerated. This is the third home for
 * the budget, and it was measured rather than assumed — bare `bun test <path>`
 * on a 6000ms test, against this very file: unchanged it times out at 5000ms,
 * with this call it passes.
 *
 * TWO THINGS TO KNOW BEFORE READING A SLOW RED.
 *
 * A genuinely hung test now costs 30s to fail instead of 5s. That is the price
 * of the two invocations agreeing, and it is deliberate — but a suite that
 * feels slower on a FAILURE is this line, not your change.
 *
 * And this moves only the by-hand invocation. `bun run test` already passed
 * `--timeout 30000` and always did, so the gate is unaffected either way:
 * nothing here made the gate green, and nothing here can make it green.
 */
setDefaultTimeout(30_000);

import { acquireSuiteLock, busyMessage, nodeEnvRefusal } from './test-suite-guard';

// Before anything else: the suite has one NODE_ENV, and a root `.env` can
// take it away. See `nodeEnvRefusal` for why that is fatal rather than
// tolerated. Checked first so a misconfigured environment is named before a
// database connection is opened against it.
const envRefusal = nodeEnvRefusal(process.env.NODE_ENV);
if (envRefusal) {
  process.stderr.write(`\n${envRefusal}\n`);
  process.exit(1);
}

// Point repository tests at the running compose Postgres. The compose
// stack is the standard local dev harness (`bun run dev:stack`); tests
// don't provision their own DB. Per-test isolation is provided by
// `withTestDb` (see test/helpers/db.ts), which wraps each test body in
// a transaction and rolls back on exit.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://scani:scani@localhost:5433/scani?sslmode=disable';
}

// Refuse to run the suite against a non-local database.
//
// Bun auto-loads a root `.env`, so anyone who writes one to point the dev
// stack at a remote database silently redirects the ENTIRE test suite
// there too — `bun test` needs no flag and gives no warning. That happened
// on 2026-08-11 while testing against a Neon branch.
//
// This is fatal rather than a warning because not every DB test rolls
// back. `withTestDb` does, but several use-case tests (e.g.
// RollupPortfolioValueDailyUseCase, LinkTransferPairsUseCase) INSERT
// committed rows for users/tokens and clean up with `db.delete(...)` in
// afterEach. Against a production URL that is a write followed by a
// DELETE on real data, and an interrupted run leaves the writes behind.
// The app-boot equivalent of this check (`checkEnvIsolatedUrl` in
// apps/*/src/config/env.ts) is deliberately warn-only; a test suite that
// mutates rows has no business being that forgiving.
//
// Escape hatch for a deliberate remote run: ALLOW_REMOTE_TEST_DB=1.
const dbUrl = process.env.DATABASE_URL;
const looksLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0|host\.docker\.internal/i.test(dbUrl);
if (!looksLocal && process.env.ALLOW_REMOTE_TEST_DB !== '1') {
  const host = (() => {
    try {
      return new URL(dbUrl).host;
    } catch {
      return '<unparseable>';
    }
  })();
  throw new Error(
    `Refusing to run tests against a non-local database (host: ${host}).\n` +
      'Some DB tests commit rows and clean up with DELETE, so this can mutate real data.\n' +
      'Fix: unset DATABASE_URL, or run with an explicit local one:\n' +
      "  DATABASE_URL='postgres://scani:scani@localhost:5433/scani?sslmode=disable' bun test ...\n" +
      'If you genuinely mean to target a remote database, set ALLOW_REMOTE_TEST_DB=1.'
  );
}

// reflect-metadata must load before any @Service() class, since TypeDI
// reads decorator metadata at class-init time.
import 'reflect-metadata';
import { installContainerLeakGuard } from './test/helpers/container';

// One suite per database, or none. Two `bun run test` runs both land here on
// the shared compose database, and 3 of 4 processes failed when that was
// measured (SC-372) — on the rollup sweep and on a whole-table count, neither
// of which says whose run broke it. A run pointed at a database of its own
// never contends and never sees this.
if (process.env.SCANI_ALLOW_SHARED_TEST_DB !== '1') {
  const outcome = await acquireSuiteLock(dbUrl);
  if (outcome.kind === 'busy') {
    process.stderr.write(`\n${busyMessage(dbUrl, outcome.holder)}\n`);
    process.exit(1);
  }
}

// A stub left on the process-global typedi Container is read by every test
// file that runs after it, which is why this suite was green only in bun's
// default file order (SC-448). Installed last, so the patched `Container.set`
// is in place before any test file loads.
installContainerLeakGuard();
