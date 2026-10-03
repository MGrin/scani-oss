import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratchGitEnv, scrubGitLocation } from '../lib/scratch-git';

describe('a scratch git command cannot reach the repository a hook runs in (SC-1515, SC-1517)', () => {
  const root = mkdtempSync(join(tmpdir(), 'oss-bound-scratch-env-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function sharedRepoAfterScratchInit(
    prepare: (hookEnv: NodeJS.ProcessEnv) => NodeJS.ProcessEnv
  ): string {
    const shared = mkdtempSync(join(root, 'shared-'));
    const scratch = mkdtempSync(join(root, 'scratch-'));
    const clean = scratchGitEnv();
    const gitIn = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, env: clean });
    gitIn(shared, 'init', '-q');
    gitIn(
      shared,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'a'
    );
    gitIn(shared, 'worktree', 'add', '-q', join(root, `${shared.split('/').pop()}-wt`));
    const linkedGitDir = join(shared, '.git', 'worktrees', `${shared.split('/').pop()}-wt`);
    spawnSync('git', ['init', '-q'], {
      cwd: scratch,
      env: prepare({ ...process.env, GIT_DIR: linkedGitDir }),
    });
    return spawnSync('git', ['config', '--get', 'core.bare'], {
      cwd: shared,
      env: scratchGitEnv(),
      encoding: 'utf8',
    }).stdout.trim();
  }

  test("the hazard: a linked worktree's inherited GIT_DIR turns the shared repository bare", () => {
    expect(sharedRepoAfterScratchInit((hookEnv) => hookEnv)).toBe('true');
  });

  test('scratchGitEnv leaves it a work tree', () => {
    expect(sharedRepoAfterScratchInit(scratchGitEnv)).toBe('false');
    const inherited = { ...process.env, GIT_DIR: '/x', GIT_INDEX_FILE: '/y', GIT_WORK_TREE: '/z' };
    const env = scratchGitEnv(inherited);
    expect([env.GIT_DIR, env.GIT_INDEX_FILE, env.GIT_WORK_TREE]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(inherited.GIT_DIR).toBe('/x');
    expect(env.PATH).toBe(process.env.PATH);
  });
});

describe('scrubGitLocation never resolves toward keeping a variable', () => {
  test('it removes what git lists, in place, and says what it removed', () => {
    const env: Record<string, string | undefined> = { GIT_DIR: '/x', PATH: '/bin' };
    expect(scrubGitLocation(env)).toEqual(['GIT_DIR']);
    expect(env).toEqual({ PATH: '/bin' });
  });
});
