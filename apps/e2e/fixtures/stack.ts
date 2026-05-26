import { spawnSync } from 'node:child_process';

/**
 * Playwright globalSetup. Runs once before any test. Confirms the stack
 * is healthy — if it isn't, fails fast with a clear message rather
 * than letting individual tests time out.
 *
 * The stack itself is started by `scripts/run.ts` BEFORE Playwright
 * launches (in Mode B), so by the time this runs the stack is either
 * already up (Mode A) or just-started (Mode B). Either way, /health
 * should respond.
 */
export default async function globalSetup() {
  const e2eRoot = import.meta.dir;
  const result = spawnSync('bun', ['scripts/wait-for-stack.ts'], {
    stdio: 'inherit',
    cwd: e2eRoot,
  });
  if (result.status !== 0) {
    throw new Error('Stack health check failed — see logs above');
  }
}
