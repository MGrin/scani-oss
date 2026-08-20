import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * The claim the naming scheme rests on is a claim about git, so it is tested
 * against git: two branches, each adding one migration, merged in each order.
 *
 * Under the old scheme both branches also had to append to
 * `meta/_journal.json`, and the last test here shows what that did — a
 * conflict in the one file whose hand-resolution is how a journal ended up
 * naming a `0043_sc328` that did not exist while omitting the `0043` that
 * did. Removing the file removed the resolution, and with it the mistake.
 */
const repos: string[] = [];

afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync({
    cmd: ['git', ...args],
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    code: proc.exitCode,
    out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
  };
}

async function write(repo: string, file: string, body: string): Promise<void> {
  await Bun.write(path.join(repo, file), body);
}

/**
 * A repo at a shared base, with two branches each adding one file. `shared`
 * is an optional file both branches append a line to — the journal's shape.
 */
async function twoBranches(options: {
  a: Record<string, string>;
  b: Record<string, string>;
  shared?: { file: string; base: string; a: string; b: string };
}): Promise<string> {
  const repo = mkdtempSync(path.join(tmpdir(), 'scani-merge-'));
  repos.push(repo);

  git(repo, 'init', '-q', '-b', 'main');
  await write(repo, 'migrations/0049_base.sql', 'select 1\n');
  if (options.shared) await write(repo, options.shared.file, options.shared.base);
  git(repo, 'add', '-A');
  expect(git(repo, 'commit', '-qm', 'base').code).toBe(0);

  for (const [branch, files] of [
    ['a', options.a],
    ['b', options.b],
  ] as const) {
    git(repo, 'checkout', '-q', '-b', branch, 'main');
    for (const [file, body] of Object.entries(files)) await write(repo, file, body);
    if (options.shared) {
      await write(repo, options.shared.file, options.shared[branch]);
    }
    git(repo, 'add', '-A');
    expect(git(repo, 'commit', '-qm', `branch ${branch}`).code).toBe(0);
  }

  git(repo, 'checkout', '-q', 'main');
  return repo;
}

function mergeBoth(repo: string, order: readonly string[]): { code: number; out: string } {
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'reset', '-q', '--hard', 'main');
  for (const branch of order) {
    const result = git(repo, 'merge', '--no-edit', branch);
    if (result.code !== 0) return result;
  }
  return { code: 0, out: '' };
}

function files(repo: string): string[] {
  return git(repo, 'ls-tree', '-r', '--name-only', 'HEAD')
    .out.split('\n')
    .filter((line) => line.endsWith('.sql'))
    .sort();
}

describe('two branches each adding a migration', () => {
  const A = { 'migrations/20260817120000_branch_a.sql': '-- a\n' };
  const B = { 'migrations/20260817110001_branch_b.sql': '-- b\n' };
  const both = [
    'migrations/0049_base.sql',
    'migrations/20260817110001_branch_b.sql',
    'migrations/20260817120000_branch_a.sql',
  ];

  test('merge a then b: clean, both migrations present', async () => {
    const repo = await twoBranches({ a: A, b: B });
    const merge = mergeBoth(repo, ['a', 'b']);
    expect(merge.out).not.toContain('CONFLICT');
    expect(merge.code).toBe(0);
    expect(files(repo)).toEqual(both);
  });

  test('merge b then a: clean, both migrations present', async () => {
    const repo = await twoBranches({ a: A, b: B });
    const merge = mergeBoth(repo, ['b', 'a']);
    expect(merge.out).not.toContain('CONFLICT');
    expect(merge.code).toBe(0);
    expect(files(repo)).toEqual(both);
  });

  test('the two orders produce the same tree', async () => {
    const forward = await twoBranches({ a: A, b: B });
    const reverse = await twoBranches({ a: A, b: B });
    mergeBoth(forward, ['a', 'b']);
    mergeBoth(reverse, ['b', 'a']);
    expect(files(forward)).toEqual(files(reverse));
  });

  test('a shared registry file conflicts instead — which is why the journal left git', async () => {
    // Not a test of our code. It is the evidence for the decision: as long as
    // one tracked file has to list every migration, every concurrent pair of
    // branches stops on it and someone resolves it by hand.
    const repo = await twoBranches({
      a: A,
      b: B,
      shared: {
        file: 'migrations/meta/_journal.json',
        base: '{\n  "entries": [\n    "0049_base"\n  ]\n}\n',
        a: '{\n  "entries": [\n    "0049_base",\n    "0050_branch_a"\n  ]\n}\n',
        b: '{\n  "entries": [\n    "0049_base",\n    "0050_branch_b"\n  ]\n}\n',
      },
    });
    const merge = mergeBoth(repo, ['a', 'b']);
    expect(merge.code).not.toBe(0);
    expect(merge.out).toContain('CONFLICT');
  });
});
