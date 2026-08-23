#!/usr/bin/env bun
// The local stack, isolated to this worktree.
//
// WHY THIS EXISTS (SC-491). `bun dev:stack` was `docker compose up` with the
// project name compose picks by default — the directory leaf, which is `scani`
// in every bb worktree. A second worktree starting a stack therefore did not
// get a stack of its own: it adopted the first one's containers and recreated
// them. That happened, to a running session's Postgres and Redis, during
// SC-474. The port bind error people noticed first is the loud symptom; the
// takeover is the one that cost something.
//
// So this passes an explicit `COMPOSE_PROJECT_NAME` and an explicit host port
// for every published service, both derived from this worktree's path in
// `scripts/lib/worktree.ts`, and `down` names the same project so it can only
// ever tear down its own.
//
//   bun run dev:stack              # sync env, start this worktree's stack
//   bun run dev:stack:down         # stop this worktree's stack, nothing else
//   bun scripts/dev-stack.ts env   # the variables, for a `docker compose` by hand
//
// Extra arguments are passed through to `docker compose`, so
// `bun run dev:stack:down -- --volumes` discards this worktree's data and
// nobody else's.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  type DockerProbe,
  describeBlindProbe,
  describeHolder,
  portOwnership,
} from './lib/port-holder';
import {
  composeProjectName,
  devDatabaseName,
  isPrimaryCheckout,
  portOffset,
  resolveStackPorts,
  STACK_SERVICES,
  type StackService,
  stackPortOverrides,
  worktreeSuffix,
} from './lib/worktree';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

/**
 * The variables the `docker-compose.yml` beside this script interpolates.
 *
 * WHY THIS IS DERIVED RATHER THAN DECLARED (SC-497). This file is shared with
 * a second repository whose compose file need not define the same services as
 * this one, and `STACK_SERVICES` is the union of what either might publish.
 * Printing all of it regardless would greet somebody with URLs nothing will
 * ever answer and the name of a database nothing creates — false lines on the
 * first command they run, which is the worst place to put one.
 *
 * The difference is read out of the compose file rather than declared, so it
 * lives in the thing that is already different between the two trees. A
 * declared difference has to be kept true by somebody; this one cannot rot,
 * and the day a service is added the output follows it with no edit here.
 *
 * `stackEnv` still emits every variable. An unread one costs nothing, and
 * narrowing there would make the two trees disagree about what a stack IS
 * rather than about what is worth showing a person.
 *
 * Read as text, the way `scripts/tests/compose-urls-follow-ports.test.ts`
 * reads it: `docker compose config` needs the daemon, and this has to answer
 * for `dev-stack.ts env` too.
 */
export function composeInterpolates(): ReadonlySet<string> {
  const source = readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  return new Set([...source.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1] as string));
}

/** The subset of `STACK_SERVICES` this checkout's compose file publishes. */
export function publishedServices(): readonly StackService[] {
  const interpolated = composeInterpolates();
  return STACK_SERVICES.filter((service) => interpolated.has(service.env));
}

/**
 * A name the operator set, or the one derived from this checkout.
 *
 * SAME RULE THE PORTS ALREADY FOLLOW — `resolveStackPorts` lets a
 * `<SERVICE>_HOST_PORT` in the environment win, and until SC-497 the three
 * NAMES below did not, which is the identical defect with a different
 * variable. `run()` builds `{ ...process.env, ...env }`, so a derived name
 * placed in `env` does not merely lose to the environment, it OVERWRITES it:
 * a `COMPOSE_PROJECT_NAME` the caller had deliberately exported was replaced
 * without a word. That is how it was found — upstream CI sets
 * `COMPOSE_PROJECT_NAME: mgrin-e2e-suite` for its E2E job and the Playwright
 * fixtures reach a container by that name, so every database assertion failed
 * with `No such container` while the stack itself was perfectly healthy.
 *
 * This does NOT reopen SC-491. That bug is what happens when NOBODY names the
 * project and compose falls back to the directory leaf, which is the same in
 * every checkout. An operator who exports a name has chosen one, and neither
 * repo's `.env.example` sets it — so the default path is still the derivation.
 *
 * Empty and whitespace are not choices, matching `stackPortOverrides`.
 */
function chosen(fromEnv: string | undefined, derived: string): string {
  const asked = fromEnv?.trim();
  return asked === undefined || asked === '' ? derived : asked;
}

/**
 * Image tags are per-worktree for the same reason container names are. Three
 * services build an image here, and a bare `docker compose up` (no `--build`,
 * which CLAUDE.md documents as an alternative to `dev:stack`) starts whatever
 * that tag currently points at — so a shared `:dev` tag means the worktree
 * that built last decides which source tree every other worktree runs.
 */
export function stackEnv(
  worktreePath: string,
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const primary = isPrimaryCheckout(worktreePath);
  return {
    COMPOSE_PROJECT_NAME: chosen(env.COMPOSE_PROJECT_NAME, composeProjectName(worktreePath)),
    SCANI_STACK_TAG: chosen(env.SCANI_STACK_TAG, worktreeSuffix(worktreePath)),
    SCANI_DEV_DB: chosen(env.SCANI_DEV_DB, devDatabaseName(worktreePath)),
    ...Object.fromEntries(
      Object.entries(resolveStackPorts(worktreePath, primary, env)).map(([k, v]) => [k, String(v)])
    ),
  };
}

function reachableAt(env: Record<string, string>): string {
  const services = publishedServices();
  if (services.length === 0) return '';
  const width = Math.max(...services.map((s) => s.label.length));
  return services
    .map((s) => {
      const port = env[s.env];
      const where = s.scheme === 'http' ? `http://localhost:${port}` : `localhost:${port}`;
      return `  ${s.label.padEnd(width)}  ${where}`;
    })
    .join('\n');
}

/**
 * `env` wins over `process.env`, which is correct only because `stackEnv` has
 * already folded any `<SERVICE>_HOST_PORT` the operator set INTO `env`
 * (SC-500). Before it did, this spread was the bug: the derived value
 * overwrote the one the environment asked for, so a documented override was
 * discarded without a word.
 */
async function run(command: string[], env: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(command, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['inherit', 'inherit', 'inherit'],
  });
  return await proc.exited;
}

/**
 * Which of this stack's ports somebody else is already publishing (SC-500).
 *
 * Compose's own bind error names the port and stops there, and the port is the
 * least useful half: 20 offset slots means two worktrees CAN draw the same
 * one, and the answer is either an override or a stack somebody forgot to tear
 * down. Two compose projects were running on this machine with no worktree
 * behind them at all, and nothing anywhere said so.
 *
 * Nothing is stopped or removed here, deliberately. Those containers hold
 * volumes that are somebody's database, and a script that reaps them on a bind
 * failure would delete a colleague's work to save a restart.
 */
export function explainPortConflicts(env: Record<string, string>): string {
  const lines: string[] = [];
  let asked = false;
  let blind: DockerProbe | null = null;

  // Only what this compose file publishes: a port no service binds cannot be
  // the reason an `up` failed, and naming its holder would send somebody after
  // a container that was never in the way.
  for (const service of publishedServices()) {
    const port = Number(env[service.env]);
    if (!Number.isInteger(port)) continue;
    const ownership = portOwnership(port, REPO_ROOT);
    if (!ownership.determined) {
      blind = ownership.blind;
      break;
    }
    asked = true;
    if (ownership.foreign) lines.push(`  ${describeHolder(ownership.foreign, port)}`);
  }

  if (!asked) {
    // Naming WHICH blindness, because the reader's next move differs (SC-591):
    // a timeout can be re-run, a denied or absent socket cannot be waited out.
    return (
      'dev-stack: could not ask docker who holds these ports, so the bind failure above is all there is\n' +
      (blind === null ? '' : `dev-stack: ${describeBlindProbe(blind)}\n`)
    );
  }
  if (lines.length === 0) return '';

  return (
    "dev-stack: another checkout already publishes some of this stack's ports:\n" +
    `${lines.join('\n')}\n` +
    "dev-stack: set that service's <SERVICE>_HOST_PORT to move THIS stack, e.g.\n" +
    '  POSTGRES_HOST_PORT=7233 bun run dev:stack\n' +
    'dev-stack: a holder whose directory no longer exists is NOT necessarily an\n' +
    '  orphan. A deleted worktree that ran a bare `docker compose up` adopted the\n' +
    '  default project name and stamped its path onto containers serving another\n' +
    "  checkout. Nothing is stopped or removed here: those volumes are somebody's\n" +
    '  database, and the label alone cannot tell you whose.\n'
  );
}

async function main(): Promise<never> {
  const [subcommand, ...passthrough] = process.argv.slice(2);
  const env = stackEnv(REPO_ROOT);
  const offset = portOffset(REPO_ROOT, isPrimaryCheckout(REPO_ROOT));

  if (subcommand === 'env') {
    for (const [key, value] of Object.entries(env)) process.stdout.write(`${key}=${value}\n`);
    process.exit(0);
  }

  if (subcommand !== 'up' && subcommand !== 'down') {
    process.stderr.write(
      'dev-stack: usage: bun scripts/dev-stack.ts <up|down|env> [docker compose args]\n'
    );
    process.exit(64);
  }

  const overridden = Object.keys(stackPortOverrides());
  // The database is named only where the compose file reads `SCANI_DEV_DB`.
  // Elsewhere the stack's own Postgres volume is per-project already, so this
  // would name a database nothing creates — see `composeInterpolates`.
  const database = composeInterpolates().has('SCANI_DEV_DB') ? ` · db ${env.SCANI_DEV_DB}` : '';
  process.stderr.write(
    `dev-stack: project ${env.COMPOSE_PROJECT_NAME}${database} · ports ` +
      `${offset === 0 ? 'documented defaults (primary checkout)' : `+${offset}`}` +
      `${overridden.length === 0 ? '' : ` · overridden by the environment: ${overridden.join(', ')}`}\n`
  );

  if (subcommand === 'down') {
    const code = await run(['docker', 'compose', '--profile', 'full', 'down', ...passthrough], env);
    process.exit(code);
  }

  // Bootstraps the root .env when there is none, and never rewrites one that
  // exists (SC-474). Before compose, because the `env-sync` service only
  // materializes the per-app files once the stack is already coming up.
  const synced = await run(['bun', 'scripts/sync-env.ts'], env);
  if (synced !== 0) process.exit(synced);

  const code = await run(
    ['docker', 'compose', '--profile', 'full', 'up', '-d', '--build', ...passthrough],
    env
  );
  if (code !== 0) {
    process.stderr.write(explainPortConflicts(env));
    process.exit(code);
  }

  process.stderr.write(`dev-stack: this worktree's stack is at\n${reachableAt(env)}\n`);
  process.exit(0);
}

if (import.meta.main) await main();
