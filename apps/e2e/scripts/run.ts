#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import {
  e2eProjectName,
  isPrimaryCheckout,
  stackPorts,
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
 */
const PORTS: Record<string, string> = Object.fromEntries(
  Object.entries(stackPorts(REPO_ROOT, isPrimaryCheckout(REPO_ROOT))).map(([name, port]) => [
    name,
    process.env[name] ?? String(port),
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
 */
const STACK_SERVICES = ['data-provider', 'backend', 'worker', 'frontend', 'mailpit'];

/** The `depends_on` gates above — they run to completion, so `up` reports only
 *  their exit code and their own output is where a boot failure explains itself. */
const ONE_SHOT_SERVICES = ['migrate', 'deps', 'env-sync', 'minio-init'];

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
 * The only path to `docker compose` in this file. `--project-name` is passed
 * on the command line as well as through the environment so the project this
 * run touches is visible in the process list and in a CI log, not only in a
 * variable — `scripts/tests/e2e-compose-project.test.ts` fails the build if a
 * second, unnamed call ever appears.
 */
function compose(args: string[], env: Record<string, string> = {}): number {
  return run('docker', ['compose', '--project-name', PROJECT, '--profile', 'full', ...args], {
    ...COMPOSE_ENV,
    ...env,
  });
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
  const stackWasUp = await probeStack();

  if (!stackWasUp) {
    ensureEnvFile();
    // intentional: progress marker for CI logs, and the one place a person can
    // read which stack this run is about to create and later delete
    console.log(`Starting docker-compose stack (Mode B) — project ${PROJECT}, api ${API_BASE_URL}`);
    const upStatus = compose(['up', '-d', '--build', ...STACK_SERVICES], {
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
  const callerChoseProjects = FORWARDED.some((arg) => arg.startsWith('--project'));
  const projectArgs = callerChoseProjects
    ? []
    : DEFAULT_SPEC_PROJECTS.flatMap((project) => ['--project', project]);
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

main();
