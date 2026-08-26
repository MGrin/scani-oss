/**
 * Read-only sessions, and the policy that decides when one is opened.
 *
 * WHY THIS IS NOT A COMMENT SOMEWHERE (SC-422). Every dispatch brief tells a
 * thread that production is read-only for it, and until this module nothing
 * enforced that for code reaching Postgres through `@scani/db`. An SC-395 dry
 * run — a script whose entire contract is that it writes nothing — ran against
 * production on a read-write session. Nothing was written, but that is the
 * script behaving, not the connection refusing.
 *
 * WHAT ACTUALLY DECIDES, measured 2026-08-19 against production Neon and the
 * local compose Postgres on postgres.js 3.4.9 — and it is NOT the passing form:
 *
 *   * `parseOptions` merges every URL query param it does not recognise into
 *     the startup packet, so `?options=-c default_transaction_read_only=on`
 *     DOES take effect. The prior belief that postgres.js silently ignores it
 *     is retracted; it is not reproducible on either host.
 *   * The ENDPOINT decides. Neon's pooled host refuses BOTH forms at connect
 *     with `08P01 unsupported startup parameter in options` — loudly, which is
 *     the good case. The Neon API hands out the pooled host by default; drop
 *     `-pooler` from the hostname to get one where this works at all.
 *   * Query params are spread AFTER `connection` in `parseOptions`, so an
 *     `options` param in `DATABASE_URL` REPLACES the option below rather than
 *     adding to it. That is the one silent defeat that remains, and
 *     `assertNoConflictingOptionsParam` is why it cannot happen quietly.
 *
 * So the passing form is a detail and the guarantee is not: the only claim
 * worth making is one the live session answers. `assertSessionReadOnly` asks
 * it, and nothing here trusts a config object to describe a session.
 */

import type { Sql } from 'postgres';

/**
 * The startup parameter that makes Postgres itself refuse writes. Passed
 * through postgres.js's `connection` object, which becomes the startup packet.
 */
export const READ_ONLY_STARTUP_OPTION = '-c default_transaction_read_only=on';

/**
 * The one flag a repair script uses to mean "write this time". One flag and
 * not a family: a script whose write flag is spelled differently would parse
 * itself as a dry run while the connection opened read-write, and the two
 * halves of the guard have to be reading the same word.
 * `scripts/tests/repair-db.test.ts` holds every repair script to it.
 */
export const REPAIR_WRITE_FLAG = '--commit';

/** Env var that overrides the policy in both directions. */
export const READ_ONLY_ENV_VAR = 'SCANI_DB_READ_ONLY';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);

export interface ReadOnlyIntentInput {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Every spelling this repo uses for "write this time".
 *
 * `REPAIR_WRITE_FLAG` is the one a NEW script should use and the only one
 * `beginRepair` reads. `--apply` is here because ten scripts predate the
 * harness and spell it that way; the connection has to know both, or those ten
 * parse themselves as a dry run while it opens read-write — which is the exact
 * failure `REPAIR_WRITE_FLAG`'s own comment above warns about, and was the
 * live state of this repo until SC-646.
 */
export const WRITE_FLAGS: readonly string[] = [REPAIR_WRITE_FLAG, '--apply'];

/**
 * Whether the entry point is an operator script — a one-off tool a human runs
 * by hand, rather than a service, a test, or library code.
 *
 * DECIDED BY THE DIRECTORY, NOT THE FILE NAME (SC-646). This used to require
 * the name to match `repair-*`, so a destructive script called anything else
 * got a writable connection whatever its intent — ten of them did, and one was
 * a `--apply` repair for transactions on the wrong holding. A population
 * defined by a naming convention is an honour system; SC-644 removed the same
 * defect from the test that was supposed to report it.
 *
 * A directory is not behaviour either, and it is not claimed to be: it is the
 * SCOPE, and the flag below is the INTENT. What makes it safe is the direction
 * it fails in — a new file dropped in `scripts/` is covered automatically and
 * gets read-only until it says otherwise, so forgetting produces a loud refusal
 * at the first write rather than a silent hole.
 *
 * `.test.ts` is excluded because `bun test <file>` puts the TEST FILE in
 * `argv[1]`; without it one test file's path would open the whole suite's
 * connection read-only and fail every test that writes.
 *
 * NOTE the deliberate breadth: ANY directory named `scripts` matches, not just
 * the repo root's. `apps/e2e/scripts/` and four others exist and none of them
 * opens a database connection today (measured 2026-08-26). If one ever does it
 * will come up read-only and say so, which is the correct way round.
 */
export function isOperatorScript(argv: readonly string[]): boolean {
  const entry = argv[1];
  if (!entry) return false;
  const segments = entry.split(/[\\/]/);
  const name = segments.pop() ?? '';
  if (!/\.tsx?$/.test(name)) return false;
  if (/\.test\.tsx?$/.test(name)) return false;
  return segments.pop() === 'scripts';
}

/** An operator script invoked without asking to write. */
export function isDryRunOperatorScript(argv: readonly string[]): boolean {
  return isOperatorScript(argv) && !argv.some((arg) => WRITE_FLAGS.includes(arg));
}

/**
 * Whether this process should open read-only sessions.
 *
 * An unrecognised `SCANI_DB_READ_ONLY` THROWS rather than falling back to
 * read-write: a typo that reads as "off" is this ticket's failure mode again,
 * one layer up.
 */
export function resolveReadOnlyIntent({ argv, env }: ReadOnlyIntentInput): boolean {
  const raw = env[READ_ONLY_ENV_VAR];
  if (raw !== undefined && raw.trim() !== '') {
    const value = raw.trim().toLowerCase();
    if (TRUTHY.has(value)) return true;
    if (FALSY.has(value)) return false;
    throw new Error(
      `${READ_ONLY_ENV_VAR} is "${raw}", which is neither on nor off. ` +
        `Use one of ${[...TRUTHY].join('/')} or ${[...FALSY].join('/')} — a value this cannot read ` +
        'must not be guessed as read-write.'
    );
  }
  return isDryRunOperatorScript(argv);
}

/**
 * Refuse a `DATABASE_URL` that carries its own `options` param while a
 * read-only session is wanted. postgres.js spreads URL query params over the
 * `connection` object, so such a URL would replace the read-only option with
 * no error and no warning — the one way this guard can still be defeated
 * quietly.
 */
export function assertNoConflictingOptionsParam(databaseUrl: string): void {
  let param: string | null = null;
  try {
    param = new URL(databaseUrl).searchParams.get('options');
  } catch {
    return; // A URL this cannot parse is the connection's problem, not ours.
  }
  if (param === null) return;
  throw new Error(
    `DATABASE_URL carries options="${param}" and a read-only session was requested. ` +
      'postgres.js merges URL query params OVER the connection object, so that param would ' +
      'silently replace the read-only startup option. Remove it from the URL.'
  );
}

/**
 * Ask the live session whether it is read-only and refuse to continue if the
 * answer is not the one intended.
 *
 * Asserted in BOTH directions on purpose. A check that only ever confirms
 * "read-only" passes just as happily when everything is read-only, including
 * a `--commit` run that is about to fail on its first write.
 */
export async function assertSessionReadOnly(
  // biome-ignore lint/suspicious/noExplicitAny: any postgres.js client shape, schema-independent
  client: Sql<any>,
  expected: boolean
): Promise<void> {
  let rows: Array<{ transaction_read_only?: string }>;
  try {
    rows = await client`show transaction_read_only`;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === '08P01') {
      throw new Error(
        "This endpoint refuses the read-only startup parameter — Neon's pooled host does. " +
          'Drop "-pooler" from the DATABASE_URL hostname and run it against the unpooled ' +
          `endpoint. Original error: ${(error as Error).message}`
      );
    }
    throw error;
  }
  const actual = rows[0]?.transaction_read_only === 'on';
  if (actual === expected) return;
  throw new Error(
    expected
      ? 'Session is READ-WRITE but a read-only one was intended. Refusing to continue — ' +
          'a dry run on a writable connection is exactly the hole SC-422 closed.'
      : 'Session is READ-ONLY but a writing run was intended. Refusing to continue — ' +
          `every write would fail. Check ${READ_ONLY_ENV_VAR}.`
  );
}
