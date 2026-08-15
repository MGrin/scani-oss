#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SPEC_PROJECTS } from '../fixtures/devices';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const E2E_ROOT = resolve(import.meta.dir, '..');
const HEALTH_URL = 'http://localhost:3011/health';
const KEEP_STACK =
  process.env.KEEP_STACK_ON_FAILURE === '1' || process.argv.includes('--keep-stack');
const UI_MODE = process.argv.includes('--ui');

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

async function probeStack(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2_000) });
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
    // intentional: progress marker for CI logs
    console.log('Starting docker-compose stack (Mode B)...');
    const upStatus = run(
      'docker',
      ['compose', '--profile', 'full', 'up', '-d', '--build', ...STACK_SERVICES],
      { STUB_AI: '1' }
    );
    if (upStatus !== 0) {
      console.error('Stack failed to start.');
      process.exit(upStatus);
    }
  } else {
    // intentional: confirm mode selection for CI logs
    console.log('Reusing already-running stack (Mode A).');
  }

  const waitScript = resolve(E2E_ROOT, 'scripts/wait-for-stack.ts');
  const healthStatus = run('bun', [waitScript], {});
  if (healthStatus !== 0) {
    if (!stackWasUp && !KEEP_STACK) {
      run('docker', ['compose', '--profile', 'full', 'down', '-v']);
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
      env: { ...process.env },
    }).status ?? 1;

  if (!stackWasUp && !KEEP_STACK) {
    // intentional: teardown confirmation for CI logs
    console.log('Tearing down stack...');
    run('docker', ['compose', '--profile', 'full', 'down', '-v']);
  } else if (KEEP_STACK) {
    // intentional: remind operator the stack is still alive
    console.log(
      `Stack kept alive (KEEP_STACK_ON_FAILURE=${process.env.KEEP_STACK_ON_FAILURE ?? ''}, --keep-stack=${process.argv.includes('--keep-stack')}). Run \`docker compose --profile full down -v\` when done.`
    );
  }

  process.exit(testStatus);
}

main();
