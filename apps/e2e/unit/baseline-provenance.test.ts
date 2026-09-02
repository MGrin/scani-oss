import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  type BaselineRow,
  changedBaselines,
  describeBase,
  describeTree,
  EMPTY_MANIFEST,
  formatProvenance,
  type Git,
  type Manifest,
  manifestDrift,
  mergeManifest,
  readTreeProvenance,
  renderedDigest,
  type TreeProvenance,
} from '../visual/baseline-provenance';

/**
 * That the SC-833 record can say something other than "clean".
 *
 * Same charter as `session-provenance.test.ts` and `capture-size.test.ts`, and
 * it belongs in `unit/` for the same reason: the one directory the root `test`
 * script points at without sweeping `apps/e2e/tests/`'s Playwright specs into
 * `bun test`.
 *
 * **A provenance field that always reads clean is worse than none** — it makes
 * an unattributable baseline look attributed. So no arm below stands alone:
 * each names the counterpart it must NOT agree with, because a function
 * returning a constant passes every happy-path test perfectly.
 *
 * The second half runs against a REAL repository built in a temp directory and
 * deliberately made dirty, and deliberately put behind its own `origin/main`.
 * That is the control the whole file exists for: `readTreeProvenance` is
 * exercised through `git` rather than through a stub of it, so the reading
 * path itself is what is shown to be able to come back red.
 */

const CLEAN: TreeProvenance = {
  head: '44a8a731e5b6c7d8e9f0',
  renderedDigest: 'abcdef0123456789',
  dirty: [],
  dirtyCount: 0,
  base: { ref: '28e4dc446aabbccddee', confirmed: true, behind: 0 },
};

describe('renderedDigest', () => {
  test('does not depend on the order git listed the tree in', () => {
    const a = renderedDigest([
      { path: 'b.tsx', sha: '222' },
      { path: 'a.tsx', sha: '111' },
    ]);
    const b = renderedDigest([
      { path: 'a.tsx', sha: '111' },
      { path: 'b.tsx', sha: '222' },
    ]);
    expect(a).toBe(b);
  });

  test('changes when a single blob changes — the arm the reordering test needs', () => {
    const before = renderedDigest([{ path: 'a.tsx', sha: '111' }]);
    const after = renderedDigest([{ path: 'a.tsx', sha: '112' }]);
    expect(after).not.toBe(before);
  });
});

describe('describeTree', () => {
  test('a clean tree names the commit — the control every arm below needs', () => {
    expect(describeTree(CLEAN)).toBe('HEAD 44a8a731e, rendered paths clean');
  });

  test('a dirty tree says DIRTY and names the paths', () => {
    const sentence = describeTree({
      ...CLEAN,
      dirty: ['apps/frontend/app/src/v3/Home.tsx'],
      dirtyCount: 1,
    });
    expect(sentence).toContain('DIRTY');
    expect(sentence).toContain('apps/frontend/app/src/v3/Home.tsx');
    expect(sentence).not.toContain('clean');
  });

  /** The cap is a review property: a row nobody can read is a row nobody reads. */
  test('a large refactor is capped, and says how many it did not name', () => {
    const all = Array.from({ length: 40 }, (_, i) => `apps/frontend/app/src/f${i}.tsx`);
    const sentence = describeTree({ ...CLEAN, dirty: all.slice(0, 12), dirtyCount: 40 });
    expect(sentence).toContain('40 path(s) differ');
    expect(sentence).toContain('and 28 more');
  });

  test('no recorded commit reads UNKNOWN, never clean', () => {
    const sentence = describeTree({
      head: null,
      renderedDigest: null,
      dirty: [],
      dirtyCount: 0,
      base: { ref: null, confirmed: false, behind: 0 },
    });
    expect(sentence).toContain('UNKNOWN');
    expect(sentence).not.toContain('clean');
  });
});

describe('describeBase', () => {
  test('confirmed and level says so', () => {
    const sentence = describeBase({ ref: '28e4dc446a', confirmed: true, behind: 0 });
    expect(sentence).toContain('confirmed against the remote');
    expect(sentence).not.toContain('UNCONFIRMED');
    expect(sentence).not.toContain('AHEAD');
  });

  /**
   * UNCONFIRMED is not a weaker "current". A reader who cannot tell the two
   * apart reads the quiet one as the safe one, which is the failure the four
   * forms exist to prevent — `gate-db` learned it first (SC-734).
   */
  test('an unasked remote is UNCONFIRMED, and is not the same sentence as confirmed', () => {
    const unconfirmed = describeBase({ ref: '28e4dc446a', confirmed: false, behind: 0 });
    const confirmed = describeBase({ ref: '28e4dc446a', confirmed: true, behind: 0 });
    expect(unconfirmed).toContain('UNCONFIRMED');
    expect(unconfirmed).not.toBe(confirmed);
  });

  test('a base ahead under rendered paths says AHEAD and counts it', () => {
    const sentence = describeBase({ ref: '28e4dc446a', confirmed: true, behind: 4 });
    expect(sentence).toContain('4 rendered-path commit(s) AHEAD');
    expect(sentence).toContain('a tree main will never have');
  });

  test('an unreadable ref is UNKNOWN, which is not "no commits ahead"', () => {
    const sentence = describeBase({ ref: null, confirmed: false, behind: 0 });
    expect(sentence).toContain('UNKNOWN');
    expect(sentence).not.toContain('no rendered-path commits ahead');
  });
});

describe('formatProvenance', () => {
  test('a clean recording carries no advisory — the control the next arm needs', () => {
    const block = formatProvenance(['home-desktop'], CLEAN).join('\n');
    expect(block).toContain('home-desktop');
    expect(block).not.toContain('unattributable');
    // Both halves, by their content. Checking only that the block mentions the
    // baseline is what let `describeBase(provenance)` — the whole record where
    // its `.base` belonged — ship reading UNKNOWN over a confirmed remote; it
    // type-checks as neither shape has a required `ref`, and every assertion
    // here passed over it. Found by running the reader against this repository.
    expect(block).toContain('HEAD 44a8a731e');
    expect(block).toContain('28e4dc446');
    expect(block).toContain('confirmed against the remote');
    expect(block).not.toContain('base UNKNOWN');
  });

  test('a block whose base could not be read says so, and is not the clean block', () => {
    const block = formatProvenance(['home-desktop'], {
      ...CLEAN,
      base: { ref: null, confirmed: false, behind: 0 },
    }).join('\n');
    expect(block).toContain('base UNKNOWN');
    expect(block).not.toContain('confirmed against the remote');
  });

  test('a dirty or behind recording explains what the row means', () => {
    const block = formatProvenance(['home-desktop'], {
      ...CLEAN,
      dirty: ['apps/frontend/app/src/v3/Home.tsx'],
      dirtyCount: 1,
    }).join('\n');
    expect(block).toContain('unattributable');
    expect(block).toContain('SC-833');
    // It must not read as a failure: the whole design decision is that it is not.
    expect(block).toContain('a record, not a refusal');
  });
});

describe('changedBaselines', () => {
  /**
   * The row describes the BYTES. `--update` rewrites a matching screen with
   * identical bytes, and moving its row onto today's commit would assert a
   * tree that did not produce those pixels — a false provenance claim written
   * by the provenance feature itself.
   */
  test('identical bytes earn no new row', () => {
    expect(changedBaselines({ 'home-desktop': 'aaa' }, { 'home-desktop': 'aaa' })).toEqual([]);
  });

  test('changed bytes do, and so does a brand-new baseline', () => {
    expect(
      changedBaselines({ 'home-desktop': 'aaa' }, { 'home-desktop': 'bbb', 'new-phone': 'ccc' })
    ).toEqual(['home-desktop', 'new-phone']);
  });
});

describe('manifestDrift', () => {
  const row: BaselineRow = { ...CLEAN, sha256: 'aaa', capturedAt: '2026-09-02T00:00:00.000Z' };
  const manifest: Manifest = { baselines: { 'home-desktop': row } };

  test('a manifest that matches the disk is silent — the control', () => {
    expect(manifestDrift(manifest, { 'home-desktop': 'aaa' })).toBeNull();
  });

  test('a PNG whose bytes are not the recorded ones is reported', () => {
    const message = manifestDrift(manifest, { 'home-desktop': 'bbb' });
    expect(message).not.toBeNull();
    expect(message).toContain('BYTES DIFFER');
    expect(message).toContain('home-desktop');
    expect(message).toContain('SC-833');
  });

  test('a baseline no row describes is reported', () => {
    const message = manifestDrift(manifest, { 'home-desktop': 'aaa', 'stray-phone': 'zzz' });
    expect(message).toContain('NO ROW AT ALL');
    expect(message).toContain('stray-phone');
  });

  /** A description of a picture that is gone is as broken a claim as the reverse. */
  test('a row whose baseline is gone is reported', () => {
    const message = manifestDrift(manifest, {});
    expect(message).toContain('ROW WITH NO BASELINE');
    expect(message).toContain('home-desktop');
  });

  test('an empty manifest over real baselines is not silent', () => {
    expect(manifestDrift(EMPTY_MANIFEST, { 'home-desktop': 'aaa' })).not.toBeNull();
  });
});

describe('mergeManifest', () => {
  const row = (sha: string): BaselineRow => ({ ...CLEAN, sha256: sha, capturedAt: null });

  test('replaces the rows it was given and leaves the rest standing', () => {
    const merged = mergeManifest({ baselines: { a: row('1'), b: row('2') } }, { b: row('9') });
    expect(merged.baselines.a?.sha256).toBe('1');
    expect(merged.baselines.b?.sha256).toBe('9');
  });

  test('orders the keys, so a regeneration produces a readable diff', () => {
    const merged = mergeManifest(EMPTY_MANIFEST, { z: row('1'), a: row('2') });
    expect(Object.keys(merged.baselines)).toEqual(['a', 'z']);
  });
});

/**
 * That the manifest committed in this repository describes the baselines
 * committed in this repository.
 *
 * This is `manifestDrift` run against the real artefacts, in `bun run test`,
 * with no Docker and no stack — so the arm that catches a PNG changed without
 * its row (a hand edit, a conflict resolution that took one and not the other,
 * a half cherry-pick) fires in the gate everyone already runs rather than only
 * inside `bun run visual`.
 *
 * The bootstrap rows are asserted for what they are ALLOWED to claim, not just
 * for being present. Backfilling them with a plausible HEAD would be the exact
 * defect the ticket is about, and it is the change this arm exists to refuse.
 */
describe('the committed manifest', () => {
  const dir = resolve(import.meta.dir, '../visual/__screenshots__');
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../visual/baselines.provenance.json'), 'utf8')
  ) as Manifest;

  const onDisk: Record<string, string> = {};
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.png')) continue;
    onDisk[file.slice(0, -'.png'.length)] = createHash('sha256')
      .update(readFileSync(join(dir, file)))
      .digest('hex');
  }

  test('has a baseline to describe — the control the next arm needs', () => {
    expect(Object.keys(onDisk).length).toBeGreaterThan(0);
  });

  test('describes every committed baseline, and only those', () => {
    expect(manifestDrift(manifest, onDisk)).toBeNull();
  });

  test('a row claims a commit or claims none — never a plausible-looking guess', () => {
    for (const [name, row] of Object.entries(manifest.baselines)) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
      if (row.head === null) {
        // A bytes-only row: the bytes are known and nothing else is.
        expect(row.renderedDigest, name).toBeNull();
        expect(row.capturedAt, name).toBeNull();
        expect(row.base.ref, name).toBeNull();
      } else {
        expect(row.head, name).toMatch(/^[0-9a-f]{40}$/);
        expect(row.renderedDigest, name).toMatch(/^[0-9a-f]{64}$/);
        expect(row.capturedAt, name).toBeString();
      }
    }
  });
});

/**
 * The control this file exists for.
 *
 * A real repository, a real `git`, and three states it must tell apart: clean,
 * dirty under a rendered path, and behind `origin/main` under a rendered path.
 * Plus the arm that must NOT fire — a remote commit under
 * `apps/frontend/landing`, which is the exact drift that made the SC-825
 * near-miss harmless. A check that fired on it would be noise, and noise is
 * how a check stops being read.
 */
describe('readTreeProvenance against a real checkout', () => {
  let dir = '';
  let remote = '';
  let git: Git;

  const run = (cwd: string, args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 20_000 });

  const write = (root: string, path: string, body: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };

  const commit = (root: string, message: string) => {
    run(root, ['add', '-A']);
    run(root, [
      '-c',
      'user.email=t@example.invalid',
      '-c',
      'user.name=t',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      message,
    ]);
  };

  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), 'sc833-'));
    dir = join(base, 'work');
    remote = join(base, 'remote.git');
    mkdirSync(dir, { recursive: true });
    run(base, ['init', '--bare', '--initial-branch=main', remote]);
    run(dir, ['init', '--initial-branch=main']);
    run(dir, ['remote', 'add', 'origin', remote]);
    write(dir, 'apps/frontend/app/src/Home.tsx', 'export const Home = 1;\n');
    write(dir, 'apps/frontend/landing/src/Hero.tsx', 'export const Hero = 1;\n');
    commit(dir, 'initial');
    run(dir, ['push', 'origin', 'main']);
    run(dir, ['fetch', 'origin']);
    git = (args) => {
      const out = run(dir, [...args]);
      return out.status === 0 ? out.stdout : null;
    };
  });

  afterAll(() => {
    if (dir) rmSync(join(dir, '..'), { recursive: true, force: true });
  });

  /**
   * Pushed from a second clone rather than from `dir`, so the working tree
   * under test genuinely does not contain the commit — pushing from `dir`
   * would move `origin/main` to somewhere HEAD already is and the "behind"
   * reading could never be non-zero.
   */
  const pushFromElsewhere = (path: string, body: string, message: string) => {
    const other = mkdtempSync(join(tmpdir(), 'sc833-other-'));
    run(other, ['clone', remote, 'clone']);
    const clone = join(other, 'clone');
    write(clone, path, body);
    commit(clone, message);
    run(clone, ['push', 'origin', 'main']);
    rmSync(other, { recursive: true, force: true });
    run(dir, ['fetch', 'origin']);
  };

  let cleanDigest = '';

  test('a clean checkout reads clean, and the remote is confirmed', () => {
    const provenance = readTreeProvenance(git);
    expect(provenance.head).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.dirtyCount).toBe(0);
    expect(provenance.renderedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.base.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(provenance.base.confirmed).toBe(true);
    expect(provenance.base.behind).toBe(0);
    expect(describeTree(provenance)).toContain('clean');
    cleanDigest = provenance.renderedDigest as string;
  });

  /**
   * The arm the ticket is about. An uncommitted edit to a rendered path is
   * invisible to `HEAD` and to the index alike, and a digest read off
   * `ls-files -s` alone would agree with a tree that stopped existing when
   * somebody saved the file.
   */
  test('an UNCOMMITTED edit under a rendered path is recorded, and moves the digest', () => {
    write(dir, 'apps/frontend/app/src/Home.tsx', 'export const Home = 2;\n');
    const provenance = readTreeProvenance(git);
    expect(provenance.dirtyCount).toBe(1);
    expect(provenance.dirty).toEqual(['apps/frontend/app/src/Home.tsx']);
    expect(provenance.renderedDigest).not.toBe(cleanDigest);
    expect(describeTree(provenance)).toContain('DIRTY');
  });

  test('an untracked file under a rendered path is recorded too', () => {
    write(dir, 'apps/frontend/app/src/New.tsx', 'export const New = 1;\n');
    const provenance = readTreeProvenance(git);
    expect(provenance.dirty).toContain('apps/frontend/app/src/New.tsx');
  });

  /** Back to clean, so the base arms below are not reading a dirty tree. */
  test('reverting the edits restores the original digest exactly', () => {
    write(dir, 'apps/frontend/app/src/Home.tsx', 'export const Home = 1;\n');
    rmSync(join(dir, 'apps/frontend/app/src/New.tsx'));
    const provenance = readTreeProvenance(git);
    expect(provenance.dirtyCount).toBe(0);
    expect(provenance.renderedDigest).toBe(cleanDigest);
  });

  /**
   * The must-NOT-fire arm, and it is the reason RENDERED_PATHS is scoped at
   * all. This is the SC-825 near-miss reproduced: `origin/main` genuinely
   * ahead, and genuinely unable to reach a baseline.
   */
  test('a landing-only commit on origin/main does NOT read as behind', () => {
    pushFromElsewhere('apps/frontend/landing/src/Hero.tsx', 'export const Hero = 2;\n', 'landing');
    const provenance = readTreeProvenance(git);
    expect(provenance.base.behind).toBe(0);
    expect(describeBase(provenance.base)).not.toContain('AHEAD');
  });

  /** And the arm that must: the same drift under a path the gate renders. */
  test('an app commit on origin/main reads as behind, and names the count', () => {
    pushFromElsewhere('apps/frontend/app/src/Home.tsx', 'export const Home = 3;\n', 'app');
    const provenance = readTreeProvenance(git);
    expect(provenance.base.behind).toBe(1);
    expect(describeBase(provenance.base)).toContain('1 rendered-path commit(s) AHEAD');
  });

  test('outside a git checkout everything reads UNKNOWN, never clean', () => {
    const provenance = readTreeProvenance(() => null);
    expect(provenance.head).toBeNull();
    expect(provenance.renderedDigest).toBeNull();
    expect(provenance.base.ref).toBeNull();
    expect(describeTree(provenance)).toContain('UNKNOWN');
    expect(describeBase(provenance.base)).toContain('UNKNOWN');
  });
});
