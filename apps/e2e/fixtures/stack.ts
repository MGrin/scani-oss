import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // Resolve via `import.meta.url`, which is standard ESM and defined in
  // both runtimes. `import.meta.dir` is Bun-only: Playwright drives this
  // file under Node, where it is `undefined`. That made the original
  // `cwd: import.meta.dir` mean "inherit the parent's cwd", which
  // happened to be apps/e2e, so the spawn worked by accident — and would
  // have silently pointed at apps/e2e/fixtures/scripts/… the moment
  // anything ran it under Bun.
  const e2eRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const result = spawnSync('bun', ['scripts/wait-for-stack.ts'], {
    stdio: 'inherit',
    cwd: e2eRoot,
  });
  if (result.status !== 0) {
    throw new Error('Stack health check failed — see logs above');
  }
}
