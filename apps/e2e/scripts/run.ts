#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, constants as fsConstants } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../../..');
const E2E_ROOT = resolve(import.meta.dir, '..');
const HEALTH_URL = 'http://localhost:3011/health';
const KEEP_STACK =
  process.env.KEEP_STACK_ON_FAILURE === '1' || process.argv.includes('--keep-stack');
const UI_MODE = process.argv.includes('--ui');

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
    const upStatus = run('docker', ['compose', '--profile', 'full', 'up', '-d', '--build'], {
      STUB_AI: '1',
    });
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

  const playwrightArgs = UI_MODE ? ['playwright', 'test', '--ui'] : ['playwright', 'test'];
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
