#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import {
  e2eProjectName,
  isPrimaryCheckout,
  resolveStackPorts,
  worktreeSuffix,
} from '../../../scripts/lib/worktree';
import { DEFAULT_SPEC_PROJECTS } from '../fixtures/devices';

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
 * override rule. This file had it and `dev:stack`, `gate-db` and the visual
 * gate did not, which is how an override could move the e2e run and leave the
 * gate pointed at another worktree's Postgres.
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
 */
const STACK_SERVICES = ['data-provider', 'worker', 'frontend', 'mailpit'];

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
const API_SERVICE_ALIASES = ['api', 'backend'];

/** The `depends_on` gates above — they run to completion, so `up` reports only
 *  their exit code and their own output is where a boot failure explains itself. */
const ONE_SHOT_SERVICES = ['migrate', 'deps', 'env-sync', 'minio-init'];

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

/** Which of `API_SERVICE_ALIASES` this repo's compose file actually declares. */
function apiService(): string {
  const declared = composeCapture(['config', '--services'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const match = API_SERVICE_ALIASES.find((name) => declared.includes(name));
  if (!match) {
    console.error(
      `No api service in docker-compose.yml. Looked for ${API_SERVICE_ALIASES.join(' or ')}; compose declares: ${declared.join(', ') || '(nothing — the command above failed)'}`
    );
    process.exit(1);
  }
  return match;
}

// `docker compose up` reports only `service "x" didn't complete successfully:
// exit 1` and discards the container's own output, so a boot failure here is
// undiagnosable from a CI log alone — which is exactly what happened to
// `migrate` upstream on 2026-08-15, where the reason ("Refusing to migrate a
// non-local database") only became visible once the one-shot containers were
// dumped. Ported from scani-oss caebf28e, which put the dump in `ci.yml`;
// this repo boots the stack from here rather than from a workflow step.
function dumpOneShotLogs() {
  compose(['logs', '--no-color', ...ONE_SHOT_SERVICES]);
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
    const upStatus = compose(['up', '-d', '--build', apiService(), ...STACK_SERVICES], {
      STUB_AI: '1',
      STUB_CHAIN_DATA: '1',
    });
    if (upStatus !== 0) {
      console.error('Stack failed to start.');
      dumpOneShotLogs();
      process.exit(upStatus);
    }
    // The suite's two direct-SQL assertions reach Postgres by container name,
    // which is `<project>-<service>-1` — knowable only here.
    SERVICE_ENV.POSTGRES_CONTAINER = process.env.POSTGRES_CONTAINER ?? `${PROJECT}-postgres-1`;
  } else {
    // intentional: confirm mode selection for CI logs
    console.log(`Reusing already-running stack (Mode A) at ${API_BASE_URL}.`);
  }

  const waitScript = resolve(E2E_ROOT, 'scripts/wait-for-stack.ts');
  const healthStatus = run('bun', [waitScript], SERVICE_ENV);
  if (healthStatus !== 0) {
    dumpOneShotLogs();
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
// compose stack and calls `process.exit` — the same trap `scripts/gate-db.ts`
// documents at the bottom of itself.
if (import.meta.main) await main();
