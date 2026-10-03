import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { scrubGitLocation, sharedConfigChange } from '../test-git-guard';

const GUARD = resolve(import.meta.dir, '../test-git-guard.ts');
const lab = mkdtempSync(join(tmpdir(), 'test-git-guard-'));
afterAll(() => rmSync(lab, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

describe('scrubGitLocation (SC-1512)', () => {
  test('removes the variables a hook exports, and leaves the rest', () => {
    const env: Record<string, string | undefined> = {
      GIT_DIR: '/x/.git/worktrees/wt',
      GIT_INDEX_FILE: '/x/.git/worktrees/wt/index',
      GIT_EDITOR: 'true',
      HOME: '/home/t',
    };
    const removed = scrubGitLocation(env);
    expect(removed.sort()).toEqual(['GIT_DIR', 'GIT_INDEX_FILE']);
    expect(env).toEqual({ GIT_EDITOR: 'true', HOME: '/home/t' });
  });
});

describe('sharedConfigChange', () => {
  test('is silent when core.bare did not move', () => {
    expect(sharedConfigChange('/r/.git/config', 'false', 'false')).toBeNull();
  });

  test('names the file and both values when it did', () => {
    const msg = sharedConfigChange('/r/.git/config', 'false', 'true');
    expect(msg).toContain('/r/.git/config');
    expect(msg).toContain('from false to true');
  });
});

describe('the run-wide guard, in a real bun test run', () => {
  const main = join(lab, 'main');
  const wt = join(lab, 'wt');
  git(lab, 'init', '-q', '-b', 'main', main);
  git(
    main,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'one'
  );
  git(main, 'worktree', 'add', '-q', wt, '-b', 'wt');
  const config = join(main, '.git/config');
  writeFileSync(
    join(wt, 'guard.ts'),
    `import { installSharedConfigGuard } from '${GUARD}';\ninstallSharedConfigGuard(process.cwd());\n`
  );

  function runSuite(body: string): { code: number; out: string } {
    writeFileSync(join(wt, 'case.test.ts'), `import { test } from 'bun:test';\n${body}\n`);
    const r = Bun.spawnSync(['bun', 'test', '--preload', './guard.ts', './case.test.ts'], {
      cwd: wt,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  }

  test('CONTROL: a run that leaves the shared config alone passes', () => {
    const r = runSuite("test('quiet', () => {});");
    expect(r.code).toBe(0);
  });

  test('a run that flips core.bare fails naming SC-1512, and the value is put back', () => {
    const r = runSuite(
      `test('flips', () => { Bun.spawnSync(['git', 'config', '--file', '${config}', 'core.bare', 'true']); });`
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('SC-1512');
    expect(git(main, 'config', '--file', config, 'core.bare')).toBe('false');
  });
});
