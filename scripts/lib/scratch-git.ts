/**
 * The one place a git command bound for a scratch directory gets its
 * environment (SC-1512, SC-1515, SC-1517).
 *
 * Every git hook exports the variables git uses to locate a repository, and an
 * absolute `GIT_DIR` from a linked worktree names `.git/worktrees/<name>`. A
 * `git init` in a scratch directory that inherits it re-initialises THAT
 * repository instead, writing `core.bare = true` into the config every worktree
 * shares, and git then fails in every checkout on the machine. It happened from
 * a test run (SC-1512) and from the OSS guard's classifier (SC-1515), each
 * fixed at its own site. `scripts/tests/scratch-git-only.test.ts` fails when a
 * script makes a scratch directory and runs git without coming through here.
 */

/** The variables git uses to locate a repository, by git's own list. */
function localGitEnvVars(): string[] {
  const r = Bun.spawnSync(['git', 'rev-parse', '--local-env-vars'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return r.exitCode === 0 ? r.stdout.toString().split('\n').filter(Boolean) : [];
}

/**
 * Removes them from `env` in place, so nothing spawned afterwards inherits a
 * repository. When git cannot list them, every `GIT_*` variable goes instead:
 * an unreadable list never resolves toward keeping one.
 */
export function scrubGitLocation(env: Record<string, string | undefined>): string[] {
  const listed = localGitEnvVars();
  const names = listed.length > 0 ? listed : Object.keys(env).filter((k) => k.startsWith('GIT_'));
  const removed: string[] = [];
  for (const name of names) {
    if (env[name] !== undefined) removed.push(name);
    delete env[name];
  }
  return removed;
}

/** A copy of `env` for a git command run in a scratch directory. */
export function scratchGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const copy = { ...env };
  scrubGitLocation(copy);
  return copy;
}
