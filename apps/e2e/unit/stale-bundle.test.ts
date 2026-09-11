import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { movedSince, parseReflog, parseStartedAt, REFLOG_ARGS } from '../visual/stale-bundle';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const STARTED = 1_000;

/** Reflog text, newest first, as `git` prints it under `REFLOG_ARGS`. */
function reflog(...rows: [number, string, string][]): string {
  return `${rows.map(([at, sha, subject]) => `HEAD@{${at}}\t${sha}\t${subject}`).join('\n')}\n`;
}

describe('movedSince — has HEAD left the commit the frontend started on', () => {
  test('a detach to another commit and back after the container started is found', () => {
    // must-be-FOUND: the excursion that photographed a raw i18n key.
    const entries = parseReflog(
      reflog(
        [1_200, A, 'checkout: moving from ' + B + ' to feature'],
        [1_100, B, 'checkout: moving from feature to ' + B],
        [900, A, 'commit: earlier work']
      )
    );
    expect(movedSince(entries, STARTED)?.at).toBe(1_200);
  });

  test('a merge or reset after start is found too', () => {
    expect(
      movedSince(
        parseReflog(reflog([1_100, C, 'merge main: Fast-forward'], [900, A, 'x'])),
        STARTED
      )
    ).not.toBeNull();
    expect(
      movedSince(parseReflog(reflog([1_100, C, 'reset: moving to HEAD~1'], [900, A, 'x'])), STARTED)
    ).not.toBeNull();
  });

  test('control: commits on top after start are not a move', () => {
    const entries = parseReflog(
      reflog(
        [1_300, C, 'commit (amend): tweak'],
        [1_200, B, 'commit: more work'],
        [900, A, 'checkout: moving from main to feature']
      )
    );
    expect(movedSince(entries, STARTED)).toBeNull();
  });

  test('control: checkout -b leaves HEAD on the same commit, so it is not a move', () => {
    const entries = parseReflog(
      reflog([1_100, A, 'checkout: moving from main to new-branch'], [900, A, 'commit: base'])
    );
    expect(movedSince(entries, STARTED)).toBeNull();
  });

  test('control: an excursion BEFORE the container started is already in its graph', () => {
    const entries = parseReflog(
      reflog([900, A, 'checkout: moving from x to feature'], [800, B, 'y'])
    );
    expect(movedSince(entries, STARTED)).toBeNull();
  });
});

describe('parseStartedAt', () => {
  test('reads docker nanosecond timestamps', () => {
    expect(parseStartedAt('2026-09-11T01:02:03.123456789Z\n')).toBe(
      Math.floor(Date.parse('2026-09-11T01:02:03.123Z') / 1000)
    );
  });

  test('an unstarted container or garbage is null, never epoch zero', () => {
    expect(parseStartedAt('0001-01-01T00:00:00Z')).toBeNull();
    expect(parseStartedAt('')).toBeNull();
  });
});

/**
 * Against a REAL repository, because the fixtures above encode an assumption
 * about git's output and the first version of that assumption was wrong: `%ct`
 * in a reflog format is the commit's committer date, so a checkout back to an
 * old commit read as having happened when that commit was made. Commits here
 * are back-dated a day so the two clocks cannot coincide.
 */
describe('REFLOG_ARGS reads when HEAD moved, not when the commit was made', () => {
  function repo(): (args: string[]) => string {
    const dir = mkdtempSync(join(tmpdir(), 'stale-bundle-'));
    // Only COMMITS are back-dated: the committer date also stamps reflog
    // entries, so back-dating the checkout would hide the very move under test.
    const old = {
      GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
    };
    return (args) => {
      if (args[0] === 'add') writeFileSync(join(dir, 'f'), `${Math.random()}`);
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: dir,
        env: args[0] === 'commit' ? { ...process.env, ...old } : process.env,
        encoding: 'utf8',
      });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
  }

  test('a detach to an old commit after the start time is found', () => {
    const git = repo();
    git(['init', '-q', '-b', 'main']);
    git(['add', '-A']);
    git(['commit', '-qm', 'one']);
    git(['add', '-A']);
    git(['commit', '-qm', 'two']);
    const started = Math.floor(Date.now() / 1000);
    git(['checkout', '-q', '--detach', 'HEAD~1']);
    const moved = movedSince(parseReflog(git(REFLOG_ARGS)), started);
    expect(moved?.subject).toContain('checkout: moving from main to HEAD~1');
  });

  test('control: with no move after the start time, nothing is found', () => {
    const git = repo();
    git(['init', '-q', '-b', 'main']);
    git(['add', '-A']);
    git(['commit', '-qm', 'one']);
    const entries = parseReflog(git(REFLOG_ARGS));
    // must-be-FOUND: the reflog was read and parsed to real times.
    expect(entries.length).toBeGreaterThan(0);
    expect(Number.isFinite(entries[0]?.at)).toBe(true);
    expect(movedSince(entries, Math.floor(Date.now() / 1000) + 5)).toBeNull();
  });
});
