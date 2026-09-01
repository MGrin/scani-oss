#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, constants as fsConstants, statfsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  e2eProjectName,
  isPrimaryCheckout,
  resolveStackPorts,
  worktreeSuffix,
} from '../../../scripts/lib/worktree';
import { DEFAULT_SPEC_PROJECTS } from '../fixtures/devices';
import { resolveStackDb } from '../lib/stack-db';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const E2E_ROOT = resolve(import.meta.dir, '..');
const KEEP_STACK =
  process.env.KEEP_STACK_ON_FAILURE === '1' || process.argv.includes('--keep-stack');
const UI_MODE = process.argv.includes('--ui');

/**
 * WHY THIS RUN HAS A PROJECT NAME (SC-493).
 *
 * Compose identifies a container by project + service, and with no project
 * name it uses the directory leaf — `scani` in every bb worktree *and* in the
 * primary checkout. So this file used to compose against whatever stack was
 * already running under that name, and then tear it down with `down -v`.
 * `-v` removes volumes: aimed at a project this run did not create, it does
 * not restart somebody's Postgres, it deletes their database. SC-491 fixed
 * the same shape for `bun dev:stack`, where the ending was only a restart.
 *
 * So every compose call below names its project explicitly, and the name is
 * this checkout's, derived in `scripts/lib/worktree.ts` from the worktree
 * path — the same derivation the dev stack and the per-worktree database use,
 * with an `_e2e` suffix, because a stack that gets `-v`'d at the end of every
 * run must not be one somebody is developing against.
 *
 * A `COMPOSE_PROJECT_NAME` already in the environment wins: CI sets one for
 * the whole job, and an operator driving several stacks by hand has a reason.
 */
const PROJECT = process.env.COMPOSE_PROJECT_NAME || e2eProjectName(REPO_ROOT);

/**
 * The published host ports of this checkout — the primary keeps the documented
 * defaults, a linked worktree is offset. Without this the project name alone
 * would make the collision loud instead of silent: this run would try to
 * publish 5433 while the main checkout's Postgres holds it.
 *
 * The `process.env[name] ?? …` this file used to spell out inline is now
 * `resolveStackPorts` (SC-500), so every consumer of these ports reads one
 * override rule. This file had it and `dev:stack` and the visual gate did
 * not, which is how an override could move the e2e run and leave a gate
 * pointed at another worktree's Postgres.
 */
const PORTS: Record<string, string> = Object.fromEntries(
  Object.entries(resolveStackPorts(REPO_ROOT, isPrimaryCheckout(REPO_ROOT))).map(([name, port]) => [
    name,
    String(port),
  ])
);

/** Where the services this run talks to are, once the ports above are applied. */
const FRONTEND_URL =
  process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORTS.FRONTEND_HOST_PORT}`;
const API_BASE_URL = process.env.API_BASE_URL ?? `http://localhost:${PORTS.API_HOST_PORT}`;
const DATA_PROVIDER_URL =
  process.env.DATA_PROVIDER_URL ?? `http://localhost:${PORTS.DATA_PROVIDER_HOST_PORT}`;
const MAILPIT_URL = process.env.MAILPIT_URL ?? `http://localhost:${PORTS.MAILPIT_UI_HOST_PORT}`;

/** What `wait-for-stack.ts`, `playwright.config.ts` and the fixtures read. */
const SERVICE_ENV: Record<string, string> = {
  PLAYWRIGHT_BASE_URL: FRONTEND_URL,
  API_BASE_URL,
  DATA_PROVIDER_URL,
  MAILPIT_URL,
};

/**
 * Image tags are per-checkout for the same reason the project name is: three
 * services build an image here, and a shared `:dev` tag means whichever tree
 * built last decides what every other one runs.
 */
const COMPOSE_ENV: Record<string, string> = {
  COMPOSE_PROJECT_NAME: PROJECT,
  SCANI_STACK_TAG: process.env.SCANI_STACK_TAG ?? worktreeSuffix(REPO_ROOT),
  ...PORTS,
};

/** Flags this wrapper consumes; everything else is forwarded to Playwright. */
const OWN_FLAGS = new Set(['--keep-stack', '--ui']);
const FORWARDED = process.argv.slice(2).filter((arg) => !OWN_FLAGS.has(arg));

/**
 * The services the spec suite actually exercises. `--profile full` also boots
 * landing, cloud and admin, none of which any spec visits — three extra Vite
 * servers is tolerable on a laptop and is minutes of a CI job. Compose pulls
 * in each of these services' `depends_on` (postgres, redis, minio, env-sync,
 * deps, migrate) on its own, so the list stays this short.
 *
 * `mailpit` is named explicitly because nothing depends on it: the api sends
 * mail *outward* to SMTP, so compose has no edge to follow, but every sign-in
 * in the suite reads its OTP back out of the mailbox.
 *
 * The api service is missing from this list on purpose — see
 * `API_SERVICE_ALIASES`, which is the one name the two repos spell
 * differently.
 *
 * NOT `STACK_SERVICES`, which `scripts/lib/worktree.ts` already exports as a
 * list of PORT DESCRIPTORS. These are compose SERVICE NAMES. One test now
 * imports both, and two exports of one name differing only in what they hold
 * is the label/value hazard SC-724 and SC-740 were each a case of.
 *
 * Exported so `scripts/tests/e2e-stack-services.test.ts` can check every name
 * against what this repo's compose file declares (SC-725). It is a list of
 * literals about a `merge=ours` file, which is the shape that produced
 * `no such service: backend` — see `API_SERVICE_ALIASES`.
 */
export const BOOT_SERVICES = ['data-provider', 'worker', 'frontend', 'mailpit'];

/**
 * WHY THE API SERVICE IS ASKED FOR AND NOT NAMED (SC-496).
 *
 * `docker-compose.yml` is `merge=ours` in both repos: each keeps its own copy,
 * and the api service is deliberately spelled differently — `api` here,
 * `backend` in the private tree. That is the same public-audience scrub that
 * gives the two trees different `SERVICE_NAME` values, declared in
 * `scripts/oss-eligibility.ts` (`serviceNameScrub`), so it is not drift to
 * flatten.
 *
 * This file, however, is shared verbatim, so a literal here can only ever be
 * right in one of the two repos — and the literal that stood here was the
 * private spelling. `bun run test:e2e` had never once started a stack in this
 * repo: it printed `no such service: backend` from the day the runner was
 * written. CI never saw it, because CI stands the stack up itself and passes
 * no service list at all.
 *
 * So the compose file is asked rather than assumed, which is the rule
 * `oss-eligibility.ts` states for this whole family: shared code must not
 * read a `merge=ours` file's content. `docker compose config --services` is
 * compose answering for its own file, in either repo, without this one
 * knowing which it is standing in.
 */
export const API_SERVICE_ALIASES = ['api', 'backend'];

/** The `depends_on` gates above — they run to completion, so `up` reports only
 *  their exit code and their own output is where a boot failure explains itself. */
export const ONE_SHOT_SERVICES = ['migrate', 'deps', 'env-sync', 'minio-init'];

/**
 * Which of `API_SERVICE_ALIASES` this repo's compose file declares — the pure
 * half of `apiService()`, split out so it can be run (SC-725).
 *
 * SC-496 fixed the api name by ASKING compose instead of assuming it. What it
 * could not fix is that the asking happens inside a function that spawns
 * docker and calls `process.exit`, so the resolution itself was reachable by
 * no test — and `apps/e2e/scripts/run.ts` is run by no CI that executes
 * (private CI is billing-blocked, upstream CI invokes `bunx playwright test`
 * directly and says so in its own comment). A resolution bug here therefore
 * ships silently, which is exactly how the `backend` literal survived from the
 * day the runner was written.
 *
 * Returning the error rather than printing it is the seam: the message is the
 * half that runs in the reader, and it is asserted rather than eyeballed.
 */
export function resolveApiService(
  declared: readonly string[]
): { service: string } | { error: string } {
  const match = API_SERVICE_ALIASES.find((name) => declared.includes(name));
  if (match) return { service: match };
  return {
    error:
      `No api service in docker-compose.yml. Looked for ${API_SERVICE_ALIASES.join(' or ')}; ` +
      `compose declares: ${declared.join(', ') || '(nothing — the command above failed)'}`,
  };
}

/**
 * WHY A BOOT FAILURE GETS A REPORT AND NOT A SENTENCE (SC-894).
 *
 * `Stack failed to start.` was the whole diagnosis this file produced, and it
 * is unfalsifiable: a reader cannot tell a timed-out wait from a crashed
 * container from a compose file that would not parse from an image that would
 * not pull. Measured on the private `Accessibility gate & mobile smoke` job at
 * 2026-09-01T02:39:02Z — 4m18s, and the two lines a person had to work from
 * were that sentence and `error: script "test:e2e:a11y" exited with code 1`.
 *
 * The actual cause there was the RUNNER'S DISK, and it is the reason this
 * report reads disk before it reads anything else. A full disk is the one boot
 * failure a service structurally cannot report, because writing the log line
 * needs the same disk that ran out: `deps` emitted `bun install v1.3.13` and
 * then nothing at all, and the only evidence anywhere in that job was an
 * `ENOSPC` from `actions/checkout`'s own post-step three seconds later. So an
 * EMPTY container log is a symptom to be explained, not the absence of one —
 * and `dumpOneShotLogs`, which this file already had, could only ever hand
 * back that same silence.
 *
 * SC-190 / SC-488 / SC-640 are the family: a non-result rendering as a settled
 * one. Naming the service and the reason is what makes the next failure a
 * question somebody can answer.
 */
export interface ComposeContainerState {
  service: string;
  /** compose's own word — `running`, `exited`, `created`, `restarting`, … */
  state: string;
  exitCode: number;
  /** `healthy` / `unhealthy` / `starting`, or empty where no healthcheck exists. */
  health: string;
}

/**
 * One filesystem, as this process can see it. `free`/`total` are `null` when
 * the path could not be stat'd — which is a real answer and not a zero: on a
 * Mac the docker root lives inside a VM and is not a host path at all, and
 * reporting `0 GiB free` for it would be a fabricated out-of-disk verdict.
 */
export interface DiskReading {
  label: string;
  path: string;
  free: number | null;
  total: number | null;
}

/** Below this, say so in words rather than leaving a reader to compare figures. */
const LOW_DISK_BYTES = 2 * 1024 ** 3;

function parseJsonOrNull(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `docker compose ps --format json` emits a JSON ARRAY on some compose
 * versions and one object PER LINE on others, and which one you get is a
 * property of the reader's docker rather than of this repo. Both shapes are
 * accepted because a parser that handles one of them fails by returning an
 * empty list — which this report would then render as "compose reported no
 * containers", a confident sentence about the wrong thing.
 *
 * A row with no `Service` is dropped rather than guessed at: the service name
 * is the only field the report is built on.
 */
export function parseComposePs(stdout: string): ComposeContainerState[] {
  const text = stdout.trim();
  if (!text) return [];
  const rows = text.startsWith('[')
    ? asRows(parseJsonOrNull(text))
    : text.split('\n').flatMap((line) => asRows(parseJsonOrNull(line.trim())));
  return rows
    .map(toContainerState)
    .filter((state): state is ComposeContainerState => state !== null);
}

function asRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value !== null && typeof value === 'object' ? [value] : [];
}

function toContainerState(row: unknown): ComposeContainerState | null {
  if (row === null || typeof row !== 'object') return null;
  const fields = row as Record<string, unknown>;
  const service = typeof fields.Service === 'string' ? fields.Service : '';
  if (!service) return null;
  const exitCode = Number(fields.ExitCode);
  return {
    service,
    state: typeof fields.State === 'string' && fields.State ? fields.State : 'unknown',
    exitCode: Number.isFinite(exitCode) ? exitCode : 0,
    health: typeof fields.Health === 'string' ? fields.Health : '',
  };
}

/**
 * A one-shot that finished its work is `exited` with code 0, and is not a
 * failure — `env-sync`, `deps`, `migrate` and `minio-init` all end there on a
 * healthy boot. Everything else that is not `running` never reached a good
 * state, and a `running` container whose healthcheck says `unhealthy` is worse
 * than one that died, because compose waited on it.
 */
export function stackServiceIsBroken(state: ComposeContainerState): boolean {
  if (state.state === 'running') return state.health === 'unhealthy';
  if (state.state === 'exited') return state.exitCode !== 0;
  return true;
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

function describeContainer(state: ComposeContainerState): string {
  if (state.state === 'exited') return `exited ${state.exitCode}`;
  if (state.state === 'created') return 'created — never started';
  if (state.health) return `${state.state} (${state.health})`;
  return state.state;
}

/**
 * The half of the diagnosis that is the same wherever the stack went wrong, so
 * the boot failure and the health-wait failure cannot drift apart.
 *
 * Returned rather than printed: the message is the half that runs in the
 * reader, and `scripts/tests/e2e-stack-failure.test.ts` asserts it rather than
 * anyone eyeballing a CI log — the same seam `resolveApiService` exists for.
 */
export function describeStackState(
  containers: readonly ComposeContainerState[],
  disks: readonly DiskReading[]
): string {
  const lines: string[] = [];

  if (containers.length === 0) {
    lines.push(
      'compose reported no containers for this project, so whatever failed is upstream of',
      'any service: a compose file it could not parse, an image it could not pull, or a',
      "docker it could not reach. Compose's own output above is the whole diagnosis."
    );
  } else {
    const broken = containers.filter(stackServiceIsBroken);
    const healthy = containers.filter((c) => !stackServiceIsBroken(c));
    if (broken.length === 0) {
      lines.push(
        'Every container compose knows about is running or exited 0, so the failure is not',
        `one of them. Up: ${healthy.map((c) => c.service).join(', ')}.`
      );
    } else {
      lines.push('Did not come up:');
      const width = Math.max(...broken.map((c) => c.service.length));
      for (const state of broken) {
        lines.push(`  ${state.service.padEnd(width)}  ${describeContainer(state)}`);
      }
      lines.push(
        healthy.length > 0
          ? `Up: ${healthy.map((c) => c.service).join(', ')}.`
          : 'Nothing else came up either.'
      );
    }
  }

  lines.push('', 'Disk:');
  for (const disk of disks) {
    if (disk.free === null || disk.total === null) {
      lines.push(
        `  ${disk.label} ${disk.path}: not readable from this host — docker is remote or`,
        '    in a VM, so the reading above is this checkout, which may not be what filled.'
      );
      continue;
    }
    const usedPct = disk.total > 0 ? Math.round(((disk.total - disk.free) / disk.total) * 100) : 0;
    lines.push(
      `  ${disk.label} ${disk.path}: ${gib(disk.free)} free of ${gib(disk.total)} (${usedPct}% used)`
    );
  }

  const starved = disks.filter(
    (disk): disk is DiskReading & { free: number } =>
      disk.free !== null && disk.free < LOW_DISK_BYTES
  );
  if (starved.length > 0) {
    lines.push(
      '',
      `OUT OF DISK — ${gib(starved[0]?.free ?? 0)} free on ${starved[0]?.path}. Read this BEFORE the`,
      'container logs below. A full disk is the one boot failure a service cannot report,',
      'because writing the log line needs the same disk that ran out, so an EMPTY log is',
      'the symptom rather than the absence of one.'
    );
  }

  return lines.join('\n');
}

/**
 * The spec path a caller's own `--project <name>` is about to swallow, or
 * `null` (SC-533).
 *
 * Playwright declares `--project <project-name...>` as VARIADIC, so in the
 * space-separated form it keeps consuming argv until it meets something
 * beginning with `-`. A trailing spec path is therefore read as one more
 * PROJECT NAME, and the run is not the run that was asked for:
 *
 *   playwright test --project chromium --project webkit tests/holdings/x.spec.ts
 *   -> Project(s) "tests/holdings/x.spec.ts" not found. Available projects: ...
 *
 * MEASURED 2026-08-22 on @playwright/test 1.60.0, and it is worth recording
 * that the ticket's headline is not quite what happens: playwright validates
 * project names, so a swallowed SPEC PATH errors rather than silently running
 * the wrong set. What it does not do is say the word "path" — it blames a
 * project that the caller never typed, minutes after this file has built and
 * booted a whole compose stack, and a caller who does not know the flag is
 * variadic has nothing to work back from. A swallowed token that DOES name a
 * real project (`--project chromium tests/… iphone`) has no error at all.
 *
 * The projects this file emits itself use `--project=<name>`, which ends the
 * variadic at the `=` and lets a trailing path through as the positional
 * filter it is. This function covers the half that cannot be fixed that way:
 * a caller who wrote the space form in their own argv, which is forwarded
 * verbatim.
 *
 * The discriminator is "looks like a path" — a `/` or a `.ts` suffix — and not
 * "is not a known project", because this file does not know playwright's
 * project list and asking for it would put a second process in front of every
 * run. The benign case that shares the shape is a caller naming several
 * projects (`--project chromium webkit`): viewport names in `fixtures/
 * devices.ts` carry neither a slash nor an extension, so they do not trip it.
 *
 * `--` ends option parsing outright, so anything after it is already safe and
 * scanning stops there.
 */
export function projectFlagEatsPath(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--') return null;
    if (args[i] !== '--project') continue;
    // args[i + 1] is the flag's own value and is legitimate whatever it looks
    // like. Everything after it that does not start with `-` is still being
    // eaten by the variadic.
    for (let j = i + 2; j < args.length; j += 1) {
      const arg = args[j] ?? '';
      if (arg === '--' || arg.startsWith('-')) break;
      if (arg.includes('/') || arg.endsWith('.ts')) return arg;
    }
  }
  return null;
}

/**
 * MODE A DOES NOT KNOW WHOSE STACK IT FOUND (SC-494).
 *
 * Mode A is chosen by probing `${API_BASE_URL}/health`, which says an api
 * answered and nothing about which stack it belongs to. `fixtures/db.ts` used
 * to fill that gap with constants — container `mgrin-e2e-suite-postgres-1`,
 * database `scani` — and a reused `bun dev:stack` uses
 * `scani_dev_<label>_<hash>` (SC-429) while `scani` sits there EMPTY, 0
 * tables. The direct-SQL spec then failed as though OTP storage were broken.
 *
 * So ask the api that ANSWERED. Whatever publishes that port is the process
 * under test, and its own `DATABASE_URL` cannot disagree with it. There is no
 * fallback: on any failure the REASON travels to the point of use in
 * `E2E_DB_UNRESOLVED`, and `fixtures/db.ts` refuses with it rather than
 * querying something plausible.
 *
 * This does NOT fail the run. Exactly one spec needs a database; the other
 * sixty-odd are unaffected by a stack whose Postgres we cannot name, and
 * refusing all of them would be a worse trade than the bug.
 */
function applyResolvedDb(): void {
  const port = Number(PORTS.API_HOST_PORT);
  const resolved = resolveStackDb(port, {
    containersPublishing: (p) =>
      dockerQuery('ps', [
        '--filter',
        `publish=${p}`,
        '--format',
        '{{.Names}}\t{{.Label "com.docker.compose.project"}}',
      ]),
    environmentOf: (name) =>
      dockerQuery('inspect', [name, '--format', '{{range .Config.Env}}{{println .}}{{end}}']),
  });
  if ('error' in resolved) {
    SERVICE_ENV.E2E_DB_UNRESOLVED = resolved.error;
    console.log(`Mode A: could not determine this stack's database — ${resolved.error}`);
    return;
  }
  SERVICE_ENV.POSTGRES_CONTAINER = resolved.container;
  SERVICE_ENV.E2E_DB_NAME = resolved.database;
  // intentional: the one line that lets a person check the suite queried the
  // database they think it did. SC-500 made `gate-db` name the database it
  // reached for the same reason.
  console.log(
    `Mode A: database ${resolved.database} on ${resolved.container} (project ${resolved.project}).`
  );
}

/**
 * The ONE place this file spawns docker without `composeArgv` (SC-494).
 *
 * `composeArgv` exists so no compose call can ever run against an unnamed
 * project — SC-493, where a teardown with `-v` was aimed at whatever stack was
 * already up. These two calls are NOT compose calls: `ps` and `inspect` are
 * read-only, take no project, and are how this file finds out WHICH project a
 * stack it did not create belongs to. Routing them through `composeArgv` would
 * be meaningless, and hand-assembling docker argv at each site is the thing the
 * guard rightly forbids.
 *
 * So there is exactly one of them, it is named, and the verb is a separate
 * parameter — `scripts/tests/e2e-compose-project.test.ts` reads the call sites
 * and fails on any verb outside the read-only set.
 */
function dockerQuery(
  verb: 'ps' | 'inspect' | 'info',
  args: string[]
): { status: number; stdout: string } {
  const r = spawnSync('docker', [verb, ...args], { cwd: REPO_ROOT, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '' };
}

async function probeStack(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], env: Record<string, string> = {}): number {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
  return result.status ?? 1;
}

/**
 * The only argv this file ever hands to docker. `--project-name` is passed on
 * the command line as well as through the environment so the project this run
 * touches is visible in the process list and in a CI log, not only in a
 * variable — `scripts/tests/e2e-compose-project.test.ts` fails the build if a
 * compose call that does not come from here ever appears.
 */
function composeArgv(args: string[]): string[] {
  return ['compose', '--project-name', PROJECT, '--profile', 'full', ...args];
}

function compose(args: string[], env: Record<string, string> = {}): number {
  return run('docker', composeArgv(args), { ...COMPOSE_ENV, ...env });
}

/**
 * The same call with stdout captured, for the one question this run asks
 * compose rather than tells it. A failure prints compose's own stderr and
 * returns nothing: the caller then exits naming what it was looking for, so a
 * docker that is not running cannot read as "this repo declares no api".
 */
function composeCapture(args: string[]): string {
  const result = spawnSync('docker', composeArgv(args), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...COMPOSE_ENV },
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    return '';
  }
  return result.stdout;
}

/** Asks compose what it declares, then hands the answer to `resolveApiService`. */
function apiService(): string {
  const declared = composeCapture(['config', '--services'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const resolved = resolveApiService(declared);
  if ('error' in resolved) {
    console.error(resolved.error);
    process.exit(1);
  }
  return resolved.service;
}

/** What `describeStackState` reads, gathered from a stack that is already up
 *  (or half up). Failures here are reported as failures, never as zero. */
function readStackState(): ComposeContainerState[] {
  return parseComposePs(composeCapture(['ps', '--all', '--format', 'json']));
}

function readDisk(label: string, path: string): DiskReading {
  try {
    const stats = statfsSync(path);
    const block = Number(stats.bsize);
    return {
      label,
      path,
      free: Number(stats.bavail) * block,
      total: Number(stats.blocks) * block,
    };
  } catch {
    return { label, path, free: null, total: null };
  }
}

/**
 * The checkout always, and the docker root when docker names one this host can
 * see. On a Linux CI runner they are the same filesystem and the second line
 * is redundant; on a box where `/var/lib/docker` is its own volume it is the
 * only one that matters, because images, volumes and the build cache are what
 * actually fill up.
 */
function readDisks(): DiskReading[] {
  const disks = [readDisk('checkout', REPO_ROOT)];
  const dockerRoot = dockerQuery('info', ['--format', '{{.DockerRootDir}}']).stdout.trim();
  if (dockerRoot && dockerRoot !== REPO_ROOT) disks.push(readDisk('docker root', dockerRoot));
  return disks;
}

// `docker compose up` reports only `service "x" didn't complete successfully:
// exit 1` and discards the container's own output, so a boot failure here is
// undiagnosable from a CI log alone — which is exactly what happened to
// `migrate` upstream on 2026-08-15, where the reason ("Refusing to migrate a
// non-local database") only became visible once the one-shot containers were
// dumped. Ported from scani-oss caebf28e, which put the dump in `ci.yml`;
// this repo boots the stack from here rather than from a workflow step.
//
// The one-shots stay in the list whatever compose says about them (SC-894):
// `migrate` can exit 0 having refused, and `deps` is what every long-running
// service waits on. What is added is the services compose itself reports as
// broken — a crashed `frontend` is exactly as mute as a crashed `deps` was,
// and it was in no list here.
function dumpServiceLogs(containers: readonly ComposeContainerState[]) {
  const broken = containers.filter(stackServiceIsBroken).map((c) => c.service);
  const services = [...new Set([...broken, ...ONE_SHOT_SERVICES])];
  console.error(`--- docker compose logs: ${services.join(', ')} ---`);
  compose(['logs', '--no-color', ...services]);
}

/** `down -v` only ever runs against `PROJECT`, so it can only delete volumes
 *  this run created. */
function tearDown() {
  compose(['down', '-v']);
}

function ensureEnvFile() {
  const envPath = resolve(REPO_ROOT, '.env');
  const examplePath = resolve(REPO_ROOT, '.env.example');
  // COPYFILE_EXCL makes the copy atomic + idempotent: if .env already
  // exists the syscall fails with EEXIST and we leave the existing
  // file alone. Avoids the existsSync→read→write TOCTOU.
  try {
    copyFileSync(examplePath, envPath, fsConstants.COPYFILE_EXCL);
    // intentional: inform the operator a new .env was bootstrapped
    console.log('Created .env from .env.example');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return;
    if (code === 'ENOENT' && !existsSync(examplePath)) {
      throw new Error('Neither .env nor .env.example exists at repo root');
    }
    throw err;
  }
}

async function main() {
  // Before the stack, not after it. Playwright meets this same argv at the far
  // end of a compose build, a boot and a health wait, and refuses there with a
  // sentence about a project nobody named (SC-533).
  const eaten = projectFlagEatsPath(FORWARDED);
  if (eaten) {
    console.error(
      `Refusing to run: "${eaten}" would be read as a PROJECT NAME, not a spec path.\n` +
        "  Playwright's --project is variadic, so the space-separated form keeps\n" +
        '  eating argv until it meets a flag. Write it with an equals sign, which\n' +
        '  ends the variadic:\n' +
        `    bun run test:e2e --project=<name> ${eaten}\n` +
        '  Passing no --project at all also works — this runner then adds the\n' +
        `  desktop pair in the same form: ${DEFAULT_SPEC_PROJECTS.map((p) => `--project=${p}`).join(' ')}`
    );
    // 2 rather than 1: this is a refusal to start, not a suite that ran and
    // failed, and the stack has not been touched.
    process.exit(2);
  }

  const stackWasUp = await probeStack();

  if (!stackWasUp) {
    ensureEnvFile();
    // intentional: progress marker for CI logs, and the one place a person can
    // read which stack this run is about to create and later delete
    console.log(`Starting docker-compose stack (Mode B) — project ${PROJECT}, api ${API_BASE_URL}`);
    const upStatus = compose(['up', '-d', '--build', apiService(), ...BOOT_SERVICES], {
      STUB_AI: '1',
      STUB_CHAIN_DATA: '1',
    });
    if (upStatus !== 0) {
      const containers = readStackState();
      console.error(`Stack failed to start — \`docker compose up\` exited ${upStatus}.`);
      console.error(describeStackState(containers, readDisks()));
      dumpServiceLogs(containers);
      process.exit(upStatus);
    }
    // The suite's direct-SQL assertions reach Postgres by container name,
    // which is `<project>-<service>-1` — knowable only here. This run created
    // the stack, so it also knows the database: it passes no `SCANI_DEV_DB`,
    // and compose defaults that to `scani`.
    SERVICE_ENV.POSTGRES_CONTAINER = process.env.POSTGRES_CONTAINER ?? `${PROJECT}-postgres-1`;
    SERVICE_ENV.E2E_DB_NAME = process.env.SCANI_DEV_DB ?? 'scani';
  } else {
    // intentional: confirm mode selection for CI logs
    console.log(`Reusing already-running stack (Mode A) at ${API_BASE_URL}.`);
    applyResolvedDb();
  }

  const waitScript = resolve(E2E_ROOT, 'scripts/wait-for-stack.ts');
  const healthStatus = run('bun', [waitScript], SERVICE_ENV);
  if (healthStatus !== 0) {
    // `wait-for-stack.ts` already names which URLs never answered. What it
    // cannot see is WHY — a container that exited, or a disk that filled while
    // the wait was running — so the same report follows it (SC-894).
    const containers = readStackState();
    console.error(describeStackState(containers, readDisks()));
    dumpServiceLogs(containers);
    if (!stackWasUp && !KEEP_STACK) {
      tearDown();
    }
    process.exit(healthStatus);
  }

  // The mobile viewports exist as projects but aren't part of the default
  // suite (see fixtures/devices.ts). A caller that names its own `--project`
  // — the CI accessibility gate does, because the mobile shell is a different
  // tree from the desktop one — gets exactly what it asked for; everyone else
  // gets the desktop pair. Any other forwarded argument (a spec path, a
  // `--grep`) is passed straight through.
  //
  // `--project=<name>`, never `--project <name>` — see `projectFlagEatsPath`.
  const callerChoseProjects = FORWARDED.some((arg) => arg.startsWith('--project'));
  const projectArgs = callerChoseProjects
    ? []
    : DEFAULT_SPEC_PROJECTS.map((project) => `--project=${project}`);
  const playwrightArgs = UI_MODE
    ? ['playwright', 'test', '--ui', ...projectArgs, ...FORWARDED]
    : ['playwright', 'test', ...projectArgs, ...FORWARDED];
  const testStatus =
    spawnSync('bunx', playwrightArgs, {
      stdio: 'inherit',
      cwd: E2E_ROOT,
      env: { ...process.env, ...SERVICE_ENV },
    }).status ?? 1;

  if (!stackWasUp && !KEEP_STACK) {
    // intentional: teardown confirmation for CI logs
    console.log(`Tearing down stack ${PROJECT}...`);
    tearDown();
  } else if (KEEP_STACK) {
    // intentional: remind operator the stack is still alive
    console.log(
      `Stack kept alive (KEEP_STACK_ON_FAILURE=${process.env.KEEP_STACK_ON_FAILURE ?? ''}, --keep-stack=${process.argv.includes('--keep-stack')}). Run \`docker compose --project-name ${PROJECT} --profile full down -v\` when done.`
    );
  }

  process.exit(testStatus);
}

// Only when this file is the ENTRYPOINT. `scripts/tests/e2e-project-flag.test.ts`
// imports `projectFlagEatsPath`, and without the guard that import boots a
// compose stack and calls `process.exit`.
if (import.meta.main) await main();
