#!/usr/bin/env bun

// Stub. The real Mode A/B orchestrator lands in Task 6 of the e2e
// implementation plan; this stub exists so `bun test:e2e` resolves
// during the intervening scaffold + helper tasks. It just delegates to
// `playwright test` against an already-running stack.
import { spawnSync } from 'node:child_process';

const result = spawnSync('bunx', ['playwright', 'test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: import.meta.dir.replace(/\/scripts$/, ''),
});
process.exit(result.status ?? 1);
