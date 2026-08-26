/**
 * SC-658. Tests for the NUL-byte guard.
 *
 * NOTHING NUL-BEARING IS TRACKED BY THIS SUITE, DELIBERATELY. Every fixture is
 * written at runtime into a scratch git repository under the OS temp dir. A
 * committed NUL fixture would be the defect under test, committed — git would
 * store it as binary, so the fixture's own diff would be unreadable and `blame`
 * useless on it. SC-609's reserved-prefix convention exists for fixtures whose
 * PATH is load-bearing because the tool reads the tree; this tool is run as a
 * subprocess against a scratch repo, so nothing pins these in place and
 * out-of-repo beats ignored-in-repo.
 *
 * THE CHECK PASSES ON THE TREE THAT SHIPS IT, so a suite that only ran it here
 * would prove nothing. Every must-be-FOUND case below is constructed.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BINARY_EXTENSIONS,
  COULD_NOT_LOOK,
  findNuls,
  hasKnownBinaryExtension,
  refusal,
  scanTree,
  verdict,
} from '../check-nul-bytes.ts';

const REPO_ROOT = new URL('../..', import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, 'scripts/check-nul-bytes.ts');

const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

/** Bytes with a NUL at a chosen offset. Never a literal in this file's source. */
function bytesWithNulAt(offset: number, tail = 'const K = 1;\n'): Uint8Array {
  const head = new TextEncoder().encode('a'.repeat(offset));
  const rest = new TextEncoder().encode(tail);
  const out = new Uint8Array(head.length + 1 + rest.length);
  out.set(head, 0);
  out[head.length] = 0;
  out.set(rest, head.length + 1);
  return out;
}

function git(cwd: string, ...args: string[]): void {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
}

function makeRepo(files: Record<string, Uint8Array | string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'nul-guard-'));
  scratches.push(dir);
  // `--initial-branch=main` is pinned rather than inherited: a runner whose
  // `init.defaultBranch` is `master` gave a bare repo an unborn HEAD and the
  // failure named the wrong missing thing entirely (SC-662, scani-oss#242).
  git(dir, 'init', '--quiet', '--initial-branch=main');
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'fixture');
  return dir;
}

interface Run {
  status: number | null;
  out: string;
}

function runGuard(cwd: string): Run {
  // `process.execPath` rather than the string 'bun': a PATH without bun reports
  // a failed spawn, and Bun surfaces a failed chdir as ENOENT naming the
  // BINARY, which sends you hunting for the wrong missing thing (SC-664).
  const run = spawnSync(process.execPath, [SCRIPT], { cwd, encoding: 'utf8' });
  return { status: run.status, out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

describe('findNuls locates the byte no grep in this toolchain will show you', () => {
  test('reports the count and the offset of the first', () => {
    const finding = findNuls('a.ts', bytesWithNulAt(11));
    expect(finding).not.toBeNull();
    expect(finding?.firstAt).toBe(11);
    expect(finding?.count).toBe(1);
  });

  test('counts every NUL, not just the first', () => {
    const two = new Uint8Array([65, 0, 66, 0, 67]);
    expect(findNuls('a.ts', two)?.count).toBe(2);
  });

  test('a clean file is null rather than a zero-count finding', () => {
    expect(findNuls('a.ts', new TextEncoder().encode('const K = 1;\n'))).toBeNull();
  });

  test('an EMPTY file is clean, not a finding — a scan of nothing must not accuse', () => {
    expect(findNuls('empty.ts', new Uint8Array())).toBeNull();
  });
});

describe('the allowlist is the binary side, so no text-extension list can rot', () => {
  test.each([...BINARY_EXTENSIONS])('%s is a known binary asset', (ext) => {
    expect(hasKnownBinaryExtension(`img/logo${ext}`)).toBe(true);
  });

  test.each([
    '.ts',
    '.tsx',
    '.md',
    '.json',
    '.yml',
    '.sh',
    '.css',
    '.sql',
  ])('%s is not — including extensions no text-side list would have enumerated', (ext) => {
    expect(hasKnownBinaryExtension(`src/thing${ext}`)).toBe(false);
  });

  test('an extensionless tracked file is not allowlisted', () => {
    expect(hasKnownBinaryExtension('Dockerfile')).toBe(false);
    expect(hasKnownBinaryExtension('.gitattributes')).toBe(false);
  });

  test('the extension match is case-insensitive', () => {
    expect(hasKnownBinaryExtension('IMG/LOGO.PNG')).toBe(true);
  });
});

describe('scanTree separates the expected skip from the defect', () => {
  const read = (path: string): Uint8Array =>
    path.endsWith('clean.ts') ? new TextEncoder().encode('const K = 1;\n') : bytesWithNulAt(4);

  test('a NUL-bearing image is allowed and a NUL-bearing source file is not', () => {
    const result = scanTree(['img/a.png', 'src/bad.ts', 'src/clean.ts'], read);
    expect(result.scanned).toBe(3);
    expect(result.allowed).toBe(1);
    expect(result.findings.map((f) => f.path)).toEqual(['src/bad.ts']);
  });

  test('the denominator is the whole set, so a shrinking scan cannot read as clean', () => {
    expect(scanTree([], read).scanned).toBe(0);
  });
});

describe('the message names what to DO, because the obvious action is wrong', () => {
  const result = scanTree(['src/bad.ts'], () => bytesWithNulAt(4));

  test('it refuses deletion explicitly', () => {
    // "NUL byte found" invites deleting a file that almost certainly just needs
    // re-saving — and in the live case the byte was doing a real job.
    expect(refusal(result)).toContain('DO NOT DELETE THE FILE');
  });

  test('it names the escape, which is the fix in the deliberate case', () => {
    expect(refusal(result)).toContain('\\x00');
  });

  test('it names the allowlist, which is the fix in the genuine-asset case', () => {
    expect(refusal(result)).toContain('BINARY_EXTENSIONS');
  });

  test('it tells you how to FIND the byte, since the obvious tools are blind', () => {
    // An agent shell's grep bakes in -I and `git grep -I` reads 8000 bytes, so
    // a reader who reaches for either gets nothing and concludes the check lied.
    expect(refusal(result)).toContain('python3');
  });

  test('it carries the denominator, so "1 file" cannot read as "1 of 1"', () => {
    expect(refusal(result)).toContain('1 tracked files scanned');
  });

  test('a finding past byte 8000 says why git will disagree with the check', () => {
    const late = scanTree(['src/late.ts'], () => bytesWithNulAt(8000));
    expect(refusal(late)).toContain('git grep -I');
  });

  test('the passing verdict states what it examined, not just that it passed', () => {
    expect(verdict(scanTree(['a.ts'], () => new Uint8Array()))).toContain(
      '1 tracked files scanned'
    );
  });
});

describe('the guard fires on a real repository (must-be-FOUND)', () => {
  test('a NUL in a .ts file is refused, and the file is named', () => {
    const repo = makeRepo({
      'src/bad.ts': bytesWithNulAt(4),
      'src/good.ts': 'export const K = 1;\n',
    });
    const run = runGuard(repo);
    expect(run.status).toBe(1);
    expect(run.out).toContain('src/bad.ts');
    expect(run.out).toContain('FAILED');
  });

  test('a NUL-bearing .png in the SAME repo is NOT named (must-be-ABSENT)', () => {
    // Without this control, "it flags everything" and "it flags the right
    // thing" are the same passing test.
    const repo = makeRepo({
      'src/bad.ts': bytesWithNulAt(4),
      'img/logo.png': bytesWithNulAt(4),
    });
    const run = runGuard(repo);
    expect(run.status).toBe(1);
    expect(run.out).toContain('src/bad.ts');
    expect(run.out).not.toContain('img/logo.png');
    expect(run.out).toContain('1 binary assets skipped');
  });

  test('a NUL past byte 8000 is still caught — the case git grep calls TEXT', () => {
    // The regression test for the oracle trap. `git grep -I` inspects only the
    // first 8000 bytes, so a check delegating to it would pass this file. The
    // file that motivated this ticket had its NUL at byte 15669.
    const repo = makeRepo({ 'src/late.ts': bytesWithNulAt(15669) });

    const asGitSeesIt = spawnSync('git', ['grep', '-lI', 'const', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
    });
    // The precondition: assert git really is fooled, so this test cannot
    // quietly become a duplicate of the one above.
    expect(asGitSeesIt.stdout).toContain('src/late.ts');

    const run = runGuard(repo);
    expect(run.status).toBe(1);
    expect(run.out).toContain('src/late.ts');
  });

  test('a clean repository passes and says what it looked at', () => {
    const repo = makeRepo({ 'src/good.ts': 'export const K = 1;\n', 'img/a.png': 'not really\n' });
    const run = runGuard(repo);
    expect(run.status).toBe(0);
    expect(run.out).toContain('PASS');
    expect(run.out).toContain('2 tracked files scanned');
  });

  test('a repository with no tracked files REFUSES rather than passing', () => {
    // An exit code cannot tell "every file is clean" from "there were no
    // files", and a silent skip reading as a pass is this check's own subject.
    const dir = mkdtempSync(join(tmpdir(), 'nul-guard-empty-'));
    scratches.push(dir);
    git(dir, 'init', '--quiet', '--initial-branch=main');
    const run = runGuard(dir);
    expect(run.status).toBe(COULD_NOT_LOOK);
    expect(run.out).toContain('NO CHECK MADE');
    expect(run.out).not.toContain('PASS');
  });
});

describe('this repository is clean, over a denominator that proves it looked', () => {
  test('no tracked source file carries a literal NUL', () => {
    const run = runGuard(REPO_ROOT);
    expect(run.out).toContain('PASS');
    expect(run.status).toBe(0);
  });

  test('and the scan covered the whole tree, so a clean read is not an empty one', () => {
    const run = runGuard(REPO_ROOT);
    const scanned = Number(/(\d+) tracked files scanned/.exec(run.out)?.[1] ?? 0);
    const skipped = Number(/(\d+) binary assets skipped/.exec(run.out)?.[1] ?? 0);
    expect(scanned).toBeGreaterThan(2000);
    // NOT a calibrated count. This file travels to the mirror, whose tree is a
    // subset — 95 binary assets in the private repo, 32 upstream — so any
    // threshold tuned to one is green there and red here. It was `> 50`, which
    // passed privately and failed on the mirror, and only upstream-first
    // ordering caught it.
    //
    // What the assertion is actually for: `allowed > 0` proves the scan really
    // read bytes and found real NULs. If it ever reads 0, every file came back
    // empty and PASS is a verdict about a scan that saw nothing — which is the
    // silent-skip failure this whole check exists for, reproduced inside it.
    expect(skipped).toBeGreaterThan(0);
  });
});
