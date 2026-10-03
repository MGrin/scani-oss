import { afterAll } from 'bun:test';
import { join } from 'node:path';

/**
 * SC-1512. Keep a test run from writing the real repository's git state.
 *
 * Every git hook exports an absolute `GIT_DIR` naming the linked worktree's
 * gitdir. A process started under one — a gate run from a hook, a test that
 * spawns git — inherits it, and `git -C <scratch> init` then re-initialises
 * THAT repository instead of the scratch directory, writing `core.bare = true`
 * into the config every worktree shares. git then fails with "this operation
 * must be run in a work tree" in every checkout on the machine. Measured
 * 2026-10-02 (14:27Z and ~15:00Z) and reproduced in a throwaway repository.
 */

function git(args: readonly string[], cwd?: string): { rc: number; out: string } {
  const r = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return { rc: r.exitCode, out: r.stdout.toString().trim() };
}

/** The variables git uses to locate a repository, by git's own list. */
export function localGitEnvVars(): string[] {
  const r = git(['rev-parse', '--local-env-vars']);
  return r.rc === 0 ? r.out.split('\n').filter(Boolean) : [];
}

/** Removes them from `env`, so nothing spawned later inherits a repository. */
export function scrubGitLocation(env: Record<string, string | undefined>): string[] {
  const removed: string[] = [];
  for (const name of localGitEnvVars()) {
    if (env[name] !== undefined) removed.push(name);
    delete env[name];
  }
  return removed;
}

/** The config file every worktree of the repository at `cwd` reads. */
export function sharedGitConfig(cwd: string): string | null {
  const r = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  return r.rc === 0 && r.out ? join(r.out, 'config') : null;
}

export function readCoreBare(config: string): string | null {
  const r = git(['config', '--file', config, 'core.bare']);
  return r.rc === 0 ? r.out : null;
}

export function sharedConfigChange(
  config: string,
  before: string | null,
  after: string | null
): string | null {
  if (after === before) return null;
  return (
    `SC-1512: this test run changed core.bare in the SHARED git config ${config} ` +
    `from ${before ?? '(unset)'} to ${after ?? '(unset)'}, which breaks git in every ` +
    'worktree of this repository. It has been put back. Something ran `git init` or ' +
    '`git config` against the real repository: give its git calls an explicit -C or ' +
    '--git-dir, and an environment without GIT_DIR.'
  );
}

/** Fails the run, once at its end, if the shared core.bare moved under it. */
export function installSharedConfigGuard(cwd: string): void {
  const config = sharedGitConfig(cwd);
  if (config === null) return;
  const before = readCoreBare(config);
  afterAll(() => {
    const after = readCoreBare(config);
    const change = sharedConfigChange(config, before, after);
    if (change === null) return;
    if (before !== null) git(['config', '--file', config, 'core.bare', before]);
    throw new Error(change);
  });
}
