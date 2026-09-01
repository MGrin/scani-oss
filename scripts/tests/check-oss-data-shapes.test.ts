import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ASSERTED_NOT_PRODUCTION,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_UNKNOWN,
  findInLine,
  looksSynthetic,
  RULES,
  selfTest,
} from '../check-oss-data-shapes';

const SCRIPT = path.resolve(import.meta.dir, '..', 'check-oss-data-shapes.ts');

/**
 * SC-838. Every guard that stood between the private tree and the mirror
 * detects a CLAIM; what leaked on 2026-09-01 was DATA, which carries no scope
 * word and no measurement. This file asserts the new guard in BOTH directions,
 * because a data guard that only fires is noise and one that only stays quiet
 * is decoration, and the tree is currently clean enough that neither failure
 * would announce itself.
 */
describe('SC-838 · the data-shape guard, both directions', () => {
  test('every rule carries both fixtures and both behave', () => {
    expect(RULES.length).toBeGreaterThan(0);
    expect(selfTest()).toEqual([]);
  });

  /**
   * THE ARM THAT MATTERS MOST. `looksSynthetic` admits without review, so an
   * exemption that also admitted production data would be worse than no guard —
   * it would be a guard somebody trusts. 200 rather than a handful: the arms
   * are probabilistic in effect even though each is a hard property, and one
   * lucky UUID proves nothing either way.
   */
  test('200 real v4 UUIDs are all classified NOT synthetic', () => {
    const real = Array.from({ length: 200 }, () => randomUUID());
    const admitted = real.filter((u) => looksSynthetic(u));
    expect(admitted).toEqual([]);
  });

  test('each documented synthetic shape is admitted', () => {
    // run of >= 6 identical symbols
    expect(looksSynthetic('5c331000-0000-4000-8000-000000000001')).toBe(true);
    // <= 8 distinct symbols
    expect(looksSynthetic('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(true);
    // periodic
    expect(
      looksSynthetic('0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789')
    ).toBe(true);
    // sequential, both wraps
    expect(looksSynthetic('1234567890')).toBe(true);
    expect(looksSynthetic('0123456789abcdef')).toBe(true);
    // doubled
    expect(looksSynthetic('0xc0ffee11223344556677889900aabbccddeeff01')).toBe(true);
  });

  /**
   * The convention this repository actually writes — a pronounceable hex word
   * then a stride — is NOT structurally synthetic, and is admitted by the
   * allowlist instead. Asserted so that a later loosening of `looksSynthetic`
   * to cover it goes red here rather than silently widening the hole for every
   * real value shaped the same way.
   */
  test('the repo fixture convention is admitted by the list, not by the structure test', () => {
    for (const v of [
      '0xa11ce0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7',
      '0xb0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9',
    ]) {
      expect(looksSynthetic(v)).toBe(false);
      expect(ASSERTED_NOT_PRODUCTION.has(v)).toBe(true);
      expect(findInLine(`const owner = '${v}';`)).toEqual([]);
    }
  });

  test('an opaque value of each shape is reported', () => {
    expect(
      findInLine("where id = '43a7d2a8-f227-4e24-8c17-5028de8449e4'").map((f) => f.rule)
    ).toEqual(['row-identifier']);
    expect(
      findInLine("const owner = '0x3a23f943181408eac424116af7b7790c94cb97a5';").map((f) => f.rule)
    ).toEqual(['wallet-address']);
    expect(findInLine("memo: 'Deposit to account 4029571836'").map((f) => f.rule)).toEqual([
      'account-number',
    ]);
  });

  /**
   * The digits alone are a version, a timestamp or a row count. Without the
   * keyword this rule would fire on most of the tree.
   */
  test('a long digit run with no payment word beside it is not an account number', () => {
    expect(findInLine('const buildId = 4029571836;')).toEqual([]);
    expect(findInLine('expect(total).toBe(1756423900123);')).toEqual([]);
  });
});

describe('SC-838 · the process', () => {
  function repo(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'scani-data-shapes-'));
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 't@example.com'],
      ['config', 'user.name', 'T'],
      ['config', 'commit.gpgsign', 'false'],
    ]) {
      const r = Bun.spawnSync(['git', ...args], { cwd: dir });
      if (!r.success) throw new Error(`git ${args[0]} failed`);
    }
    writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
    Bun.spawnSync(['git', 'commit', '-qm', 'seed'], { cwd: dir });
    return dir;
  }

  function run(dir: string, argv: string[], stdin = ''): { code: number; out: string } {
    const r = Bun.spawnSync(['bun', SCRIPT, ...argv], {
      cwd: dir,
      stdin: new TextEncoder().encode(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const dec = new TextDecoder();
    return { code: r.exitCode ?? -1, out: dec.decode(r.stdout) + dec.decode(r.stderr) };
  }

  test('a commit carrying an opaque row identifier is refused', () => {
    const dir = repo();
    try {
      writeFileSync(
        path.join(dir, 'm.sql'),
        "delete from transactions where id = '43a7d2a8-f227-4e24-8c17-5028de8449e4';\n"
      );
      Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
      Bun.spawnSync(['git', 'commit', '-qm', 'add'], { cwd: dir });
      const sha = new TextDecoder()
        .decode(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout)
        .trim();
      const { code, out } = run(dir, ['--stdin-commits'], `${sha}\n`);
      expect(out).toContain('43a7d2a8-f227-4e24-8c17-5028de8449e4');
      expect(out).toContain('m.sql:1');
      expect(code).toBe(EXIT_REFUSED);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the same commit with the scrubbed identifier passes', () => {
    const dir = repo();
    try {
      writeFileSync(
        path.join(dir, 'm.sql'),
        "delete from transactions where id = '5c331000-0000-4000-8000-000000000001';\n"
      );
      Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
      Bun.spawnSync(['git', 'commit', '-qm', 'add'], { cwd: dir });
      const sha = new TextDecoder()
        .decode(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout)
        .trim();
      const { code, out } = run(dir, ['--stdin-commits'], `${sha}\n`);
      expect(out).toContain('oss-data-shapes: PASS');
      expect(code).toBe(EXIT_OK);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * FAIL CLOSED. A directory that is not a git repository is the cheapest way
   * to make the population unreadable, and it is the exact shape SC-775
   * measured: a dead `git` hands back `''`, which splits to no files, which
   * reads downstream as *the tree is clean*. The guard must say it could not
   * look, with its own code, rather than print PASS over nothing.
   */
  test('a tree it cannot read is UNKNOWN, not PASS', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'scani-data-shapes-nogit-'));
    try {
      const { code, out } = run(dir, ['--scan']);
      expect(out).toContain('NOTHING WAS SCANNED');
      expect(out).not.toContain('PASS');
      expect(code).toBe(EXIT_UNKNOWN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * There is no `OSS_ALLOW_DATA_SHAPES`, unlike every other guard here. An
   * environment variable is set by whoever is blocked, at the moment they are
   * blocked, and leaves nothing behind. Asserted rather than merely intended:
   * adding one later should have to delete this test.
   */
  test('no environment variable silences it', () => {
    const dir = repo();
    try {
      writeFileSync(
        path.join(dir, 'm.sql'),
        "delete from transactions where id = '43a7d2a8-f227-4e24-8c17-5028de8449e4';\n"
      );
      Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
      Bun.spawnSync(['git', 'commit', '-qm', 'add'], { cwd: dir });
      const sha = new TextDecoder()
        .decode(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout)
        .trim();
      for (const name of [
        'OSS_ALLOW_DATA_SHAPES',
        'OSS_ALLOW_FIGURES',
        'OSS_ALLOW_NEW_FILES',
        'OSS_ALLOW_INTERNAL_REFS',
      ]) {
        const r = Bun.spawnSync(['bun', SCRIPT, '--stdin-commits'], {
          cwd: dir,
          env: { ...process.env, [name]: '1' },
          stdin: new TextEncoder().encode(`${sha}\n`),
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(r.exitCode).toBe(EXIT_REFUSED);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SC-838 · the guard is wired where it can stop something', () => {
  const root = path.resolve(import.meta.dir, '..', '..');

  test('the pre-push hook runs it', async () => {
    const hook = await Bun.file(path.join(root, '.githooks', 'pre-push')).text();
    expect(hook).toContain('scripts/check-oss-data-shapes.ts');
  });

  test('the CI boundary gate runs it', async () => {
    const wf = await Bun.file(path.join(root, '.github', 'workflows', 'ci.yml')).text();
    expect(wf).toContain('bun scripts/check-oss-data-shapes.ts --stdin-commits');
  });
});
