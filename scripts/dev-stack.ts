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
import { censusFromMachine, orphanClause } from './lib/stack-census';
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

/**
 * One service block of `docker-compose.yml`, read as text (SC-706).
 *
 * `docker compose config` would parse this properly and needs the daemon, which
 * `dev-stack.ts env` cannot assume — the same constraint `composeInterpolates`
 * already works under. One reader rather than two, because the two questions
 * asked of it (which services are in the default profile, and which of those
 * are meant to stay up) differ only in the predicate.
 */
export interface ComposeServiceBlock {
  readonly name: string;
  /** No `profiles:` key, so compose starts it without `--profile`. */
  readonly inDefaultProfile: boolean;
  /** `restart: "no"` — the compose file's own marker for "this exits". */
  readonly oneShot: boolean;
  /** `${VAR}` names interpolated anywhere in the block. */
  readonly interpolations: readonly string[];
}

export function composeServiceBlocks(): readonly ComposeServiceBlock[] {
  const source = readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  const blocks: ComposeServiceBlock[] = [];
  let inServices = false;
  let name: string | null = null;
  let body: string[] = [];
  const flush = () => {
    if (name !== null) {
      const text = body.join('\n');
      blocks.push({
        name,
        inDefaultProfile: !/^ {4}profiles:/m.test(text),
        oneShot: /^ {4}restart:\s*["']?no["']?\s*$/m.test(text),
        interpolations: [...text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1] as string),
      });
    }
    name = null;
    body = [];
  };
  for (const line of source.split('\n')) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (/^[a-zA-Z]/.test(line)) {
      flush();
      inServices = false;
      continue;
    }
    if (!inServices) continue;
    const m = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (m) {
      flush();
      name = m[1] as string;
    } else body.push(line);
  }
  flush();
  return blocks;
}

/**
 * The variables interpolated by services in the DEFAULT profile — i.e. the
 * ones `--infra-only` actually starts (SC-706).
 *
 * Derived rather than declared, for the reason `publishedServices` is: a
 * second list would have to be kept true by somebody, and THE TWO TREES
 * DISAGREE ABOUT THE SERVICE SET. Upstream has `api` where the private tree
 * has `backend`, and the private tree has frontends upstream does not — so a
 * hardcoded infra list is already wrong in one of the two repos on the day it
 * is written.
 */
export function defaultProfileInterpolations(): ReadonlySet<string> {
  return new Set(
    composeServiceBlocks()
      .filter((b) => b.inDefaultProfile)
      .flatMap((b) => b.interpolations)
  );
}

/**
 * The DEFAULT-profile services meant to keep running (SC-706).
 *
 * `--wait` supervises whatever it is asked to start, and a one-shot that exits
 * 0 is a FAILURE to it. That is invisible in `full` mode because there the
 * one-shots are never asked for directly — they arrive as dependencies under
 * `condition: service_completed_successfully`, which `--wait` understands. Ask
 * for them by name, as the default profile does, and compose returns 1 over a
 * stack that is completely healthy:
 *
 *   container ..-minio-init-1 exited (0)
 *   dev-stack: UP · exit 1 · 4 running, 4 health-verified · infra-only
 *
 * This is the trap the `upArgs` docblock names for healthchecks with the sign
 * flipped: naming a service explicitly opts it out of the dependency machinery
 * that made its lifecycle legible.
 */
export function defaultProfileLongRunning(): readonly string[] {
  return longRunningServices('infra');
}

/**
 * The services this mode starts that are meant to STILL BE RUNNING afterwards
 * (SC-795).
 *
 * This is the denominator `up` had no way to name. `publishedServices` is the
 * neighbouring list and is the wrong one here: it answers "where can I reach
 * something", so it counts a service once per published PORT and cannot count
 * `worker`, which publishes none. The question a verdict needs is "how many
 * containers should still be up", and that is exactly the compose file's
 * non-one-shot services in the requested profile.
 *
 * Derived from the compose file for the reason `defaultProfileLongRunning` is:
 * the two trees do not agree about the service set — upstream has `api` where
 * this tree has `backend`, and this tree has frontends upstream does not — so a
 * hardcoded count is already wrong in one of the two repos on the day it is
 * written, and wrong in the direction that manufactures a false `UP
 * INCOMPLETE`.
 */
export function longRunningServices(mode: StackMode): readonly string[] {
  return composeServiceBlocks()
    .filter((b) => !b.oneShot && (mode === 'full' || b.inDefaultProfile))
    .map((b) => b.name);
}

/**
 * The services this run is entitled to expect, or `null` when it cannot say
 * (SC-795).
 *
 * `null` IS NOT ZERO AND IS NEVER RESOLVED TOWARD ONE — the same rule
 * `downVerdict` and `upVerdict` already follow for an unaskable docker. A
 * caller who named services (`bun run dev:stack -- postgres`) asked compose to
 * start a subset this script did not choose, so the derived set is not what
 * they expect and comparing against it would print `UP INCOMPLETE` over a
 * start that did exactly what it was told.
 *
 * THAT MATTERS MORE THAN THE DEFECT IT GUARDS. A verdict word people meet on
 * healthy runs is one they learn to skip, and the next real `UP INCOMPLETE`
 * is then read as noise — which leaves the stack in SC-795's original state
 * with an extra word in the way.
 *
 * A bare argument is a service name; anything beginning `-` is a compose flag
 * (`--force-recreate`, `--pull`), which narrows nothing.
 */
export function expectedServices(
  mode: StackMode,
  passthrough: readonly string[]
): readonly string[] | null {
  if (passthrough.some((arg) => !arg.startsWith('-'))) return null;
  return longRunningServices(mode);
}

/**
 * The subset of `STACK_SERVICES` this checkout's compose file publishes.
 *
 * Under `infra`, the app services are dropped — otherwise `up` would print
 * `app  http://localhost:5473` for a container it deliberately did not start,
 * which is a false claim about where something is reachable rather than a
 * cosmetic surplus (SC-706).
 */
export function publishedServices(mode: StackMode = 'full'): readonly StackService[] {
  const interpolated = mode === 'infra' ? defaultProfileInterpolations() : composeInterpolates();
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

function reachableAt(env: Record<string, string>, mode: StackMode = 'full'): string {
  const services = publishedServices(mode);
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
/**
 * The argv for `down`, with `--remove-orphans` (SC-663).
 *
 * Compose only stops containers whose service is defined in the compose file
 * it is reading NOW. `COMPOSE_PROJECT_NAME` is derived from the worktree PATH
 * (SC-491) while the service SET comes from the BRANCH, and the two compose
 * files do not agree: private has `admin`, `backend`, `cloud-frontend` and
 * `landing`; upstream has `api`. So a stack started on one branch and torn
 * down after switching leaves between one and four containers running, and
 * compose reports success over every one of them.
 *
 * The port bind on the next `up` is the loud symptom. The quiet one is a
 * teardown that says it finished — and this is the command the docs name as
 * the only way to stop a stack.
 *
 * The blast radius is exactly this worktree's own project: the name is
 * per-worktree, the e2e runner uses a `_e2e` suffix so its containers are
 * never in it, and no workflow calls `down` at all.
 *
 * Exported so a test can assert the flag is present. Its absence is invisible
 * in a green run, which is how it survived.
 */
export function downArgs(passthrough: readonly string[] = []): string[] {
  return ['docker', 'compose', '--profile', 'full', 'down', '--remove-orphans', ...passthrough];
}

export interface DownVerdict {
  readonly message: string;
  readonly exit: number;
}

/**
 * What `down` is allowed to claim, given what is still running (SC-663).
 *
 * `remaining` is `null` when docker could not be asked. That is NOT the same
 * as zero and is never resolved toward it: a teardown that cannot prove it
 * finished must not print a bare success, which is the whole defect this
 * function exists to close. It should be unreachable in practice — compose
 * just talked to the same daemon — so reaching it is an anomaly worth failing
 * on rather than a routine degraded mode.
 *
 * THE NUMBER IN THE MESSAGE IS THE ONE THIS PROCESS EXITS WITH. The first
 * version printed compose's code there, so a real run read
 * `DOWN INCOMPLETE · exit 0 · 1 container(s) still in ...` — the number beside
 * the word contradicting the word, on a command that does exit 1. Compose's
 * own code is still shown when it differs, labelled, because a compose failure
 * and an incomplete teardown are different problems. Found by running it
 * rather than by the tests, which asserted the exit and the text separately
 * and never that they agree; `the verdict line cannot contradict its own exit
 * code` now does.
 */
export function downVerdict(
  code: number,
  remaining: readonly string[] | null,
  project: string
): DownVerdict {
  const compose = code === 0 ? '' : ` · compose exit ${code}`;
  if (remaining === null) {
    const exit = code === 0 ? 1 : code;
    return {
      message: `dev-stack: DOWN UNVERIFIED · exit ${exit}${compose} · docker could not be asked what remains in ${project} — this is not a clean teardown`,
      exit,
    };
  }
  if (remaining.length > 0) {
    const exit = code === 0 ? 1 : code;
    return {
      message:
        `dev-stack: DOWN INCOMPLETE · exit ${exit}${compose} · ${remaining.length} container(s) still in ${project}:\n` +
        remaining.map((name) => `  ${name}`).join('\n'),
      exit,
    };
  }
  return {
    message: `dev-stack: DOWN · exit ${code} · 0 containers remain in ${project}`,
    exit: code,
  };
}

/**
 * Every container compose still labels as this project's, running or not.
 *
 * `-a` rather than running-only: a stopped leftover holds its name and fails
 * the next `up` with a name conflict, which is the same class of problem.
 * Returns `null` when docker could not be asked — see `downVerdict`.
 */
async function remainingContainers(env: Record<string, string>): Promise<string[] | null> {
  const proc = Bun.spawn(
    [
      'docker',
      'ps',
      '-a',
      '--format',
      '{{.Names}}',
      '--filter',
      `label=com.docker.compose.project=${env.COMPOSE_PROJECT_NAME}`,
    ],
    { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return null;
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Which half of the compose file to start (SC-706). `full` is every service;
 * `infra` is the four a gate actually uses, plus the one-shots that prepare
 * them. See `upArgs` for why the distinction is a profile rather than a list.
 */
export type StackMode = 'full' | 'infra';

/**
 * `up` waits for the healthchecks that are already declared (SC-669).
 *
 * `docker compose up -d <service>` returns once the containers have STARTED.
 * It does not wait for healthchecks, and `depends_on: condition:
 * service_healthy` only governs services pulled in AS DEPENDENCIES — so naming
 * a service explicitly opts out of the very healthcheck declared for it.
 *
 * This is `down`'s defect with the sign flipped, in the same file:
 *
 *   down  reported success over work it did NOT do          (SC-663)
 *   up    reported success over work not yet FINISHED       (this)
 *
 * Both are true statements about compose having returned, and neither is the
 * statement the caller needs. Every worker here runs a gate straight after an
 * `up`, so a stack that reports ready before Postgres accepts connections
 * turns a SETUP failure into a wall of red tests attributed to the caller's
 * own change.
 *
 * `--wait` does NOT hang on a service that can never report healthy — measured
 * 2026-08-26 against the nine here that declare no healthcheck (worker, the
 * four `oven/bun` frontends, and the four one-shots): compose returned and
 * reported them Started. Only a service whose healthcheck FAILS holds it.
 *
 * Exported so a test can assert the flag is present. Its absence is invisible
 * in a green run, which is how it survived alongside healthchecks that were
 * already there.
 *
 * `infra` STARTS WHAT A GATE USES AND NOTHING ELSE (SC-706). `bun run test`
 * reaches Postgres, Redis, MinIO and Mailpit; it never touches a vite dev
 * server, an api or the worker. Every gate in this fleet nevertheless started
 * eleven containers, and measured during a live gate the three largest
 * consumers on a 10-core box were the frontend dev servers this mode omits —
 * `cloud-frontend` 152%, `frontend` 126%, `admin` 84%.
 *
 * The mechanism is one flag, because docker-compose.yml already draws the line
 * exactly here: the four services a gate needs — and the `env-sync`, `deps`
 * and `minio-init` one-shots that prepare them — declare no `profiles:` key,
 * while all seven a gate does not need sit in `full`. So the infra set is not
 * a list maintained beside the compose file, which would drift from it. It is
 * the compose file's own default, and `--profile full` is the only difference.
 *
 * WHY THIS IS A FLAG ON THIS TOOL RATHER THAN A DOCUMENTED COMPOSE COMMAND.
 * CLAUDE.md used to answer this with `docker compose up -d postgres redis
 * mailpit minio`, and that command is worse than the waste it saves. It
 * exports nothing, so compose takes the project name from the directory leaf
 * — which is `scani` in EVERY bb worktree — and a second `up` does not
 * conflict with the first, it ADOPTS and recreates the primary checkout's
 * containers (SC-491). It also publishes `${POSTGRES_HOST_PORT:-5433}` while
 * `gate-db` derives its own port from a sha256 over this worktree's absolute
 * path, so the gate then finds nothing and refuses with exit 3.
 *
 * Note the asymmetry, because only one half is survivable: the port mismatch
 * is LOUD and safe — exit 3, NO TESTS RAN, nothing damaged. The project-name
 * adoption is SILENT and reaches outside the worktree that ran it. Going
 * through this tool is what makes both impossible, since it is the one place
 * the project name and every derived port are computed together.
 */
export function upArgs(passthrough: readonly string[] = [], mode: StackMode = 'full'): string[] {
  return [
    'docker',
    'compose',
    ...(mode === 'full' ? ['--profile', 'full'] : []),
    'up',
    '-d',
    '--build',
    '--wait',
    // Named, so `--wait` supervises only what is meant to stay up. See
    // `defaultProfileLongRunning`: asking it to wait on a one-shot returns 1
    // over a healthy stack. The one-shots are omitted rather than started
    // unwaited — `env-sync` and `deps` prepare the APP containers this mode
    // does not run, and `sync-env.ts` has already run on the host by here.
    ...(mode === 'infra' ? defaultProfileLongRunning() : []),
    ...passthrough,
  ];
}

export interface ServiceHealth {
  readonly name: string;
  /**
   * The compose SERVICE this container is an instance of, read from the
   * `com.docker.compose.service` label rather than parsed out of `name`
   * (SC-795). Parsing would work today and is a guess about a format compose
   * owns; the label is the thing the format is derived FROM.
   */
  readonly service: string;
  /** `none` is a container with no healthcheck — started, never verified. */
  readonly state: 'healthy' | 'unhealthy' | 'starting' | 'none';
}

export interface UpVerdict {
  readonly message: string;
  readonly exit: number;
}

/**
 * What `up` is allowed to claim, given what is actually running (SC-669).
 *
 * `health` is `null` when docker could not be asked, and that is never
 * resolved toward "fine" — the same rule `downVerdict` follows, for the same
 * reason: a start that cannot prove it finished must not print a bare success.
 *
 * THE VERDICT COUNTS WHAT IT VERIFIED, NOT WHAT IT STARTED. `12 running, 4
 * health-verified` is a checkable claim; `12 running` invites the reader to
 * assume the other eight were checked and passed. Most services here declare
 * no healthcheck at all, so the gap is the normal case rather than an alarm —
 * printing it is how the reader knows which services `--wait` actually stood
 * behind.
 *
 * AND IT COUNTS AGAINST A DENOMINATOR, BECAUSE UNTIL SC-795 THERE WAS A WORD
 * FOR "A SERVICE DID NOT BECOME HEALTHY" AND NONE FOR "A SERVICE WAS NEVER
 * CREATED". A `full` stack whose worker image failed to build printed
 *
 *   dev-stack: UP · exit 1 · 2 running, 2 health-verified in <project> · full
 *
 * over roughly nine services that did not exist. Every one of them is absent
 * from `health`, so the unhealthy filter has nothing to find and the run falls
 * through to the success word — and `2 running` is a true statement that reads
 * as a small stack rather than a broken one. The reader meets `UP` first.
 *
 * `expected` is the fix and `null` is its refusal: see `expectedServices`.
 * A count with no denominator is the shape that made SC-500 invisible, and
 * this is the same shape one field over.
 */
export function upVerdict(
  code: number,
  health: readonly ServiceHealth[] | null,
  project: string,
  mode: StackMode = 'full',
  expected: readonly string[] | null = null
): UpVerdict {
  const compose = code === 0 ? '' : ` · compose exit ${code}`;
  // Named on BOTH modes on purpose (SC-706). A count with no provenance is
  // what made SC-500's failure invisible, and the same shape is available
  // here: `7 running` under infra-only is a healthy stack, and identical to
  // what a broken `full` stack would print. Saying `full` when it is full is
  // what stops the word's ABSENCE being read as a claim.
  const started = mode === 'infra' ? ' · infra-only (no app services)' : ' · full';
  if (health === null) {
    const exit = code === 0 ? 1 : code;
    return {
      message: `dev-stack: UP UNVERIFIED · exit ${exit}${compose}${started} · docker could not be asked what is running in ${project} — this is not a stack you should gate against`,
      exit,
    };
  }
  // `of N expected` only when there IS an N. Printing a denominator the run
  // could not establish would be the false-provenance failure this exists to
  // close, wearing the fix's clothes.
  const denominator = expected === null ? '' : ` of ${expected.length} expected`;
  const running = new Set(health.map((h) => h.service));
  const missing = expected === null ? [] : expected.filter((s) => !running.has(s));
  if (missing.length > 0) {
    // BEFORE the unhealthy branch, and the order is an argument rather than a
    // preference: a service that was never created explains a dependent that
    // is unhealthy, and never the other way round. Leading with the dependent
    // would name a symptom of the thing on the line below it.
    const exit = code === 0 ? 1 : code;
    return {
      message:
        `dev-stack: UP INCOMPLETE · exit ${exit}${compose}${started} · ${health.length} running${denominator} in ${project} · ${missing.length} service(s) were never created:\n` +
        missing.map((name) => `  ${name}`).join('\n'),
      exit,
    };
  }
  const bad = health.filter((h) => h.state === 'unhealthy' || h.state === 'starting');
  if (bad.length > 0) {
    const exit = code === 0 ? 1 : code;
    return {
      message:
        `dev-stack: UP UNHEALTHY · exit ${exit}${compose}${started} · ${bad.length} of ${health.length} service(s) in ${project} did not become healthy:\n` +
        bad.map((h) => `  ${h.name} (${h.state})`).join('\n'),
      exit,
    };
  }
  const verified = health.filter((h) => h.state === 'healthy').length;
  return {
    message: `dev-stack: UP · exit ${code} · ${health.length} running${denominator}, ${verified} health-verified in ${project}${started}`,
    exit: code,
  };
}

/**
 * The health of every container compose currently runs for this project.
 *
 * Running-only, and that is the deliberate difference from
 * `remainingContainers`. `down` uses `-a` because a stopped leftover holds its
 * name and fails the next `up`; here an exited container is `env-sync`,
 * `deps`, `migrate` or `minio-init` having finished, which is success. Listing
 * them would report four permanent failures on every healthy stack.
 *
 * Returns `null` when docker could not be asked — see `upVerdict`.
 */
async function containerHealth(env: Record<string, string>): Promise<ServiceHealth[] | null> {
  const proc = Bun.spawn(
    [
      'docker',
      'ps',
      '--format',
      '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Label "com.docker.compose.service"}}',
      '--filter',
      `label=com.docker.compose.project=${env.COMPOSE_PROJECT_NAME}`,
    ],
    { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return null;
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name = '', , status = '', service = ''] = line.split('\t');
      // `Status` carries the health in parentheses when a healthcheck exists:
      // `Up 3 minutes (healthy)`. No parenthetical means no healthcheck, which
      // is started-but-unverified rather than a failure.
      const state: ServiceHealth['state'] = /\(healthy\)/.test(status)
        ? 'healthy'
        : /\(unhealthy\)/.test(status)
          ? 'unhealthy'
          : /\(health: starting\)/.test(status)
            ? 'starting'
            : 'none';
      return { name, service, state };
    });
}

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

/**
 * `--infra-only` is OURS, not compose's (SC-706). It has to be removed from
 * argv before the rest is handed on, because `docker compose up` rejects an
 * unknown flag — so forwarding it would turn the feature into a usage error.
 */
export function parseMode(passthrough: readonly string[]): {
  mode: StackMode;
  rest: string[];
} {
  const rest = passthrough.filter((a) => a !== '--infra-only');
  return { mode: rest.length === passthrough.length ? 'full' : 'infra', rest };
}

async function main(): Promise<never> {
  const [subcommand, ...rawPassthrough] = process.argv.slice(2);
  const { mode, rest: passthrough } = parseMode(rawPassthrough);
  const env = stackEnv(REPO_ROOT);
  const offset = portOffset(REPO_ROOT, isPrimaryCheckout(REPO_ROOT));

  if (subcommand === 'env') {
    for (const [key, value] of Object.entries(env)) process.stdout.write(`${key}=${value}\n`);
    process.exit(0);
  }

  if (subcommand !== 'up' && subcommand !== 'down') {
    process.stderr.write(
      'dev-stack: usage: bun scripts/dev-stack.ts <up|down|env> [--infra-only] [docker compose args]\n'
    );
    process.exit(64);
  }

  const overridden = Object.keys(stackPortOverrides());
  // The database is named only where the compose file reads `SCANI_DEV_DB`.
  // Elsewhere the stack's own Postgres volume is per-project already, so this
  // would name a database nothing creates — see `composeInterpolates`.
  const database = composeInterpolates().has('SCANI_DEV_DB') ? ` · db ${env.SCANI_DEV_DB}` : '';
  process.stderr.write(
    `dev-stack: project ${env.COMPOSE_PROJECT_NAME}${database}` +
      `${mode === 'infra' ? ' · infra-only' : ''} · ports ` +
      `${offset === 0 ? 'documented defaults (primary checkout)' : `+${offset}`}` +
      `${overridden.length === 0 ? '' : ` · overridden by the environment: ${overridden.join(', ')}`}\n`
  );

  if (subcommand === 'down') {
    // `stackEnv` always sets it; the index signature does not say so.
    const project = env.COMPOSE_PROJECT_NAME ?? composeProjectName(REPO_ROOT);
    const code = await run(downArgs(passthrough), env);
    const verdict = downVerdict(code, await remainingContainers(env), project);
    process.stderr.write(`${verdict.message}\n`);
    // SC-530. Here rather than on `up` because this is where a person is
    // already reading about stacks and has just finished with one. The cheap
    // probe (~0.13s, no sizes) because `down` runs at the end of every gate;
    // `dev:stacks` pays the 4s for sizes. Silent unless there is an orphan.
    const clause = orphanClause(censusFromMachine(REPO_ROOT, false).projects, project);
    if (clause !== null) process.stderr.write(`${clause}\n`);
    process.exit(verdict.exit);
  }

  // Bootstraps the root .env when there is none, and never rewrites one that
  // exists (SC-474). Before compose, because the `env-sync` service only
  // materializes the per-app files once the stack is already coming up.
  const synced = await run(['bun', 'scripts/sync-env.ts'], env);
  if (synced !== 0) process.exit(synced);

  const code = await run(upArgs(passthrough, mode), env);
  if (code !== 0) process.stderr.write(explainPortConflicts(env));

  const project = env.COMPOSE_PROJECT_NAME ?? composeProjectName(REPO_ROOT);
  const verdict = upVerdict(
    code,
    await containerHealth(env),
    project,
    mode,
    expectedServices(mode, passthrough)
  );
  process.stderr.write(`${verdict.message}\n`);
  if (verdict.exit !== 0) process.exit(verdict.exit);

  process.stderr.write(`dev-stack: this worktree's stack is at\n${reachableAt(env, mode)}\n`);
  process.exit(0);
}

if (import.meta.main) await main();
