import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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
  // `import.meta.dir` is THIS file's directory — apps/e2e/fixtures — not
  // the app root, so the old `cwd: import.meta.dir` made
  // `scripts/wait-for-stack.ts` resolve to apps/e2e/fixtures/scripts/…,
  // which has never existed. The spawn failed, status was non-zero, and
  // globalSetup threw before a single test ran.
  const e2eRoot = join(import.meta.dir, '..');
  const result = spawnSync('bun', ['scripts/wait-for-stack.ts'], {
    stdio: 'inherit',
    cwd: e2eRoot,
  });
  if (result.status !== 0) {
    throw new Error('Stack health check failed — see logs above');
  }
}
