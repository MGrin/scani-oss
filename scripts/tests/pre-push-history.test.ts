import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HOOK = resolve(import.meta.dir, '../../.githooks/pre-push');
const MIRROR_URL = 'https://github.com/MGrin/scani-oss.git';
const ZERO = '0'.repeat(40);

let dir: string;

function git(...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], {
    cwd: dir,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commit(message: string): string {
  writeFileSync(join(dir, 'f.txt'), `${message}\n`);
  git('add', 'f.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-verify', '-m', message);
  return git('rev-parse', 'HEAD');
}

function runHook(sha: string, remoteUrl = MIRROR_URL) {
  const r = Bun.spawnSync(['bash', HOOK, 'upstream', remoteUrl], {
    cwd: dir,
    stdin: new TextEncoder().encode(`refs/heads/port ${sha} refs/heads/port ${ZERO}\n`),
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  return { code: r.exitCode, err: r.stderr.toString() + r.stdout.toString() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pre-push-history-'));
  git('init', '-q', '-b', 'main');
  // The mirror's history: its own root, recorded as the upstream tracking ref.
  const mirrorRoot = commit('mirror root');
  git('update-ref', 'refs/remotes/upstream/main', mirrorRoot);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pre-push refuses private history bound for the mirror (SC-1342)', () => {
  test('a branch built on a different root is refused', () => {
    git('checkout', '-q', '--orphan', 'private');
    commit('private root');
    const privateTip = commit('private work');
    const r = runHook(privateTip);
    expect(r.code).toBe(1);
    expect(r.err).toContain('SC-1342');
  });

  test('a port that merged private history into mirror history is refused', () => {
    git('checkout', '-q', '--orphan', 'private');
    const privateTip = commit('private root');
    git('checkout', '-q', '-b', 'port', 'refs/remotes/upstream/main');
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'merge',
      '-q',
      '--no-verify',
      '--allow-unrelated-histories',
      '-s',
      'ours',
      '-m',
      'merge private',
      privateTip
    );
    const r = runHook(git('rev-parse', 'HEAD'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('SC-1342');
  });

  test('control: a branch on the mirror root passes the history check and reaches the next check', () => {
    git('checkout', '-q', '-b', 'port', 'refs/remotes/upstream/main');
    const tip = commit('a port');
    const r = runHook(tip);
    expect(r.err).not.toContain('SC-1342');
    // The temp repo has no scripts/, so the NEXT check refuses: proof the hook got past history.
    expect(r.err).toContain('check-oss-bound-paths.ts is not in this tree');
  });

  test('an unreadable mirror root refuses rather than passes', () => {
    git('update-ref', '-d', 'refs/remotes/upstream/main');
    const r = runHook(git('rev-parse', 'HEAD'));
    expect(r.code).toBe(1);
    expect(r.err).toContain('HISTORY WAS NOT CHECKED');
  });

  test('a push to a non-mirror remote is not judged', () => {
    git('checkout', '-q', '--orphan', 'private');
    const tip = commit('private root');
    const r = runHook(tip, 'https://github.com/MGrin/scani.git');
    expect(r.code).toBe(0);
    expect(r.err).not.toContain('SC-1342');
  });
});
