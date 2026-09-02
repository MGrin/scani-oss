import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ASSERTED_NOT_PRODUCTION,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_UNKNOWN,
  findInLine,
  looksSynthetic,
  main,
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
      findInLine("where id = 'f269e434-c1e4-477a-ae3d-9db32ee72aa5'").map((f) => f.rule)
    ).toEqual(['row-identifier']);
    expect(
      findInLine("const owner = '0xfd91d367ab8a3722031528e5a5c6a08b743aef80';").map((f) => f.rule)
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
        "delete from transactions where id = 'f269e434-c1e4-477a-ae3d-9db32ee72aa5';\n"
      );
      Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
      Bun.spawnSync(['git', 'commit', '-qm', 'add'], { cwd: dir });
      const sha = new TextDecoder()
        .decode(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout)
        .trim();
      const { code, out } = run(dir, ['--stdin-commits'], `${sha}\n`);
      expect(out).toContain('f269e434-c1e4-477a-ae3d-9db32ee72aa5');
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
        "delete from transactions where id = 'f269e434-c1e4-477a-ae3d-9db32ee72aa5';\n"
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

/**
 * SC-918. `--scan` audits the whole tree and could not be wired blocking,
 * because a mode that returns the same red on a clean branch as on a dirty one
 * is the SC-190 family — a non-result that reads as a result. Two things had to
 * change before it could block, and both are asserted here rather than in the
 * private caller, because both travel: the population has to be nameable, and
 * a file it could not read has to stop being a smaller denominator.
 */
describe('SC-918 · --scan as a population a caller can block on', () => {
  function scanRepo(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'scani-data-shapes-scan-'));
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.email', 't@example.com'],
      ['config', 'user.name', 'T'],
    ]) {
      Bun.spawnSync(['git', ...args], { cwd: dir });
    }
    for (const [name, body] of Object.entries(files)) {
      const full = path.join(dir, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, body);
    }
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir });
    return dir;
  }

  function capture(fn: () => number): { code: number; out: string } {
    const lines: string[] = [];
    const realErr = console.error;
    const realLog = console.log;
    console.error = (...a: unknown[]) => void lines.push(a.join(' '));
    console.log = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      return { code: fn(), out: lines.join('\n') };
    } finally {
      console.error = realErr;
      console.log = realLog;
    }
  }

  const OPAQUE = "const owner = '0xfd91d367ab8a3722031528e5a5c6a08b743aef80';\n";

  /**
   * The default has to be the CLOSED one, or a caller that forgets to pass a
   * population gets a quiet pass instead of the stricter answer. Both arms,
   * because a predicate that exempted nothing and one that was never consulted
   * read identically from the exit code alone.
   */
  test('with no population every finding counts; with one, only the published paths do', () => {
    const dir = scanRepo({ 'pub/a.ts': OPAQUE, 'priv/b.ts': OPAQUE });
    try {
      expect(capture(() => main(['--scan'], dir, '')).code).toBe(EXIT_REFUSED);
      const scoped = capture(() =>
        main(['--scan'], dir, '', { unpublished: (p) => p.startsWith('priv/') })
      );
      expect(scoped.code).toBe(EXIT_REFUSED);
      expect(scoped.out).toContain('1 opaque identifier(s) in 1 file(s)');
      expect(scoped.out).toContain('published paths only');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A scoped scan that says nothing about what it skipped is indistinguishable
   * from one that read everything and found it clean — and the difference here
   * is roughly a hundred real identifiers. It names the FILES and withholds the
   * VALUES: printing those would republish them into every log that runs the
   * check, which is the thing the guard exists to stop.
   */
  test('a skipped path is named and its value is not', () => {
    const dir = scanRepo({ 'priv/b.ts': OPAQUE });
    try {
      const r = capture(() => main(['--scan'], dir, '', { unpublished: () => true }));
      expect(r.code).toBe(EXIT_OK);
      expect(r.out).toContain('priv/b.ts');
      expect(r.out).toContain('does NOT publish');
      expect(r.out).not.toContain('0xfd91d367ab8a3722031528e5a5c6a08b743aef80');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * This was `unreadable++; continue` — counted in the tail, changing no exit
   * code. Fine for an audit somebody reads, fatal for a check that blocks: an
   * unreadable tree read as a clean one with a denominator nobody was checking.
   */
  test('a file it cannot read from the index is UNKNOWN, not a smaller denominator', () => {
    const dir = scanRepo({ 'a.ts': OPAQUE });
    try {
      // ONE loose object, not the whole store: removing `.git/objects` makes
      // `git ls-files` itself fail, which is the OTHER blindness and already
      // has its own test. What has to be reachable here is a tree that lists
      // fine and whose content cannot be read.
      const blob = new TextDecoder()
        .decode(Bun.spawnSync(['git', 'rev-parse', ':a.ts'], { cwd: dir, stdout: 'pipe' }).stdout)
        .trim();
      rmSync(path.join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });
      const listed = Bun.spawnSync(['git', 'ls-files'], { cwd: dir, stdout: 'pipe' });
      expect(new TextDecoder().decode(listed.stdout)).toContain('a.ts');
      const r = capture(() => main(['--scan'], dir, ''));
      expect(r.out).toContain('THE SCAN IS INCOMPLETE');
      expect(r.out).not.toContain('PASS');
      expect(r.code).toBe(EXIT_UNKNOWN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * SC-918 triaged the whole tree rather than one landing, and these are the
 * values it asserted are not production data. Each is pinned in BOTH
 * directions: {@link looksSynthetic} must NOT admit it — otherwise the entry is
 * dead weight that reads as a decision — and {@link findInLine} must stay quiet
 * about it, which is the assertion that goes red if somebody deletes the line.
 */
describe('SC-918 · every asserted value is load-bearing', () => {
  const ASSERTED_BY_SC918 = [
    '0xcc9a0b7c43dc2a5f023bb9b738e45b0ef6b06e04',
    '0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9',
    '0xdef1c0ded9bec7f1a1670819833240f027b25eff',
    '0x3a23f943181408eac424116af7b7790c94cb97a5',
    '0x455e53cbb86018ac2b8092fdcd39d8444affc3f6',
    '0xf2b2c2a4e4eae02ba07decece8d831b11bd7a350',
    '0x742d35cc6634c0532925a3b844bc454e4438f44e',
    '0x742d35cc6634c0532925a3b844bc9e7595f0beb0',
    '0x7a3f91b2c4d5e6f708192a3b4c5d6e7f8091a2b3',
    '0x7a3f91b2c4d5e6f708192a3b4c5d6e7f8091a2b4',
    '0x1234567890abcdef1234567890abcdef12345678',
    '0x7f2c9a4b1d8e6f30a2c5b7e9d1f4a68c0b3e5d72',
    'f37aaae9-601c-46ab-968d-b01da1842f50',
  ] as const;

  test('each is in the list, and none of them is admitted by the structure test', () => {
    for (const value of ASSERTED_BY_SC918) {
      expect(ASSERTED_NOT_PRODUCTION.has(value)).toBe(true);
      expect(looksSynthetic(value)).toBe(false);
      expect(findInLine(`const x = '${value}';`)).toEqual([]);
    }
  });

  /**
   * The control, and it is the arm that matters: a one-character neighbour of
   * each asserted value is still reported. Without it, a `findInLine` that had
   * stopped reporting anything at all would pass every assertion above.
   */
  test('a one-character neighbour of each is still reported', () => {
    for (const value of ASSERTED_BY_SC918) {
      const last = value.slice(-1);
      const neighbour = value.slice(0, -1) + (last === '0' ? '1' : '0');
      if (looksSynthetic(neighbour)) continue;
      expect(findInLine(`const x = '${neighbour}';`).length).toBe(1);
    }
  });

  /**
   * The two values SC-918 could not prove synthetic were replaced rather than
   * asserted, and the replacements carry the ticket number in their leading
   * digits exactly as `5c331000-…` does — so they need no list entry at all.
   */
  test('the SC-918 replacements are admitted by structure, not by assertion', () => {
    for (const value of [
      '0x5c918000000000000000000000000000000000a1',
      '0x5c918000000000000000000000000000000000b2',
    ]) {
      expect(looksSynthetic(value)).toBe(true);
      expect(ASSERTED_NOT_PRODUCTION.has(value)).toBe(false);
    }
  });
});
