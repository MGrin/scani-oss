/**
 * SC-658. A literal NUL byte in a tracked source file must not reach `main`.
 *
 * THE FAILURE THIS EXISTS FOR, measured 2026-08-27.
 *
 * A NUL reached a committed `.ts` file during SC-650 and every check in this
 * repo passed over it: biome (targeted and repo-wide), tsgo across the whole
 * monorepo, `bun test` on the file (17 pass — a NUL is a perfectly good
 * sentinel), `docs:check`, `deps:unused`, `deps:lint`, `ci:gen:check`,
 * `sync-dockerhub-readme --check`, `check-oss-bound-paths`, and the full
 * pre-commit hook. Re-measured on a planted probe before this was written; the
 * passes are real approvals rather than skips — biome printed `Checked 1 file`
 * and bun printed `Ran 1 test across 1 file`.
 *
 * Only git objected, in `Bin 0 -> 6170 bytes` on a `.ts` file and a `-` where
 * the numstat columns belong. Both read as noise.
 *
 * WHAT IT COSTS, AND WHY IT IS NOT COSMETIC.
 *
 * `grep -I` means "skip binary files", and a NUL makes a file binary. The
 * `secret-scan` job in `.github/workflows/ci.yml` runs `grep -EnrI`, so a
 * NUL-bearing file is not scanned for secrets at all — and the skip is silent,
 * indistinguishable from a clean result. Measured on GNU grep 3.11 in a Debian
 * container rather than inferred from a Mac: with `-I` rc=1 and no output;
 * without `-I` grep catches it (`binary file matches`, rc=0, enough for the
 * job's `if` to fire). It is the only such site in the repo.
 *
 * That was live. `scripts/repoint-ingested-transactions.ts` — which does not
 * travel to the mirror, so look for it in the private tree rather than here —
 * carried two literal NULs as composite-key separators. Grepped with the
 * workflow's own flags for a string that IS in it, the answer was NO, and with
 * `-a`, YES. 27KB of tracked source the secret scan could not read. It is fixed in the same commit as this
 * file, by writing the two-character escape instead — proven identical rather
 * than assumed: same string, same length, codepoint 0 at the same index.
 *
 * Git also stores such a file as binary, so its diff is unreadable and `blame`
 * is useless on it, permanently, for a property nobody chose.
 *
 * WHY THIS READS BYTES AND ASKS NO GIT COMMAND.
 *
 * The obvious implementation delegates the binary judgement to git, since git
 * is what prints `Bin`. It would have been blind to the exact file that started
 * this ticket. Three oracles disagree about one 27KB file with two NULs:
 *
 *     git ls-files --eol   ->  i/-text     (binary)
 *     git grep -lI         ->  LISTS IT    (text)
 *     GNU grep -I          ->  skips it    (binary)
 *
 * `git grep` inspects only the first 8000 bytes of a blob for a NUL — git's
 * FIRST_FEW_BYTES — while GNU grep inspects the whole buffer. Bisected on a
 * scratch repo: a NUL at byte 7999 is binary to `git grep -I` and one at byte
 * 8000 is text. The live file's NUL sat at byte 15669, squarely in that gap,
 * which is why a sweep using `git grep -lI` reported zero invisible source
 * files when there was one.
 *
 * So: never use one grep-family tool to measure another's blind spot. This
 * check reads every tracked blob as bytes and tests for 0x00 itself.
 *
 * WHAT THE RULE IS, AND WHY IT IS STATED THIS WAY ROUND.
 *
 * Every tracked file containing a NUL must have a known-binary extension. The
 * alternative — enumerate text extensions and look for binaries among them —
 * needs a list kept in step with the repo and is silent about every extension
 * nobody listed: a NUL in a `.sh`, a `.css`, a Dockerfile or an extensionless
 * file would pass. Enumerating the binary side covers the whole tree with a
 * four-entry allowlist, measured rather than guessed: 2700 tracked files at
 * HEAD, 96 NUL-bearing, 95 of them images across exactly these four
 * extensions. Adding a fifth is a deliberate one-line change with a visible
 * diff; a NUL in source is neither.
 *
 * IT DOES NOT REMOVE THE `-I` FROM THE SECRET SCAN, DELIBERATELY. Dropping the
 * flag would have that job read 95 image files looking for key shapes, and a
 * scan that false-positives is a scan people learn to ignore. `-I` is correct
 * GIVEN an invariant nobody was enforcing — that source files are text. This
 * enforces the invariant instead. The job separately prints what it scanned and
 * skipped, so a violation is loud rather than silent; that half covers the
 * paths this check does not think of.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * Measured, not guessed: every NUL-bearing file tracked at HEAD on 2026-08-27
 * had one of these four extensions, 95 of them across 2700 tracked files.
 */
export const BINARY_EXTENSIONS: readonly string[] = ['.avif', '.ico', '.png', '.webp'];

/** A refusal, not a verdict: nothing established whether the tree is clean. */
export const COULD_NOT_LOOK = 2;

export interface NulFinding {
  path: string;
  /** How many NUL bytes, so "one stray" and "a binary blob" read differently. */
  count: number;
  /** Byte offset of the first, which locates it when no grep can. */
  firstAt: number;
}

export interface ScanResult {
  scanned: number;
  /** NUL-bearing files carrying a known-binary extension — expected, skipped. */
  allowed: number;
  /** NUL-bearing files that are not known binary assets. The defect. */
  findings: NulFinding[];
}

export function hasKnownBinaryExtension(path: string): boolean {
  return BINARY_EXTENSIONS.includes(extname(path).toLowerCase());
}

export function findNuls(path: string, bytes: Uint8Array): NulFinding | null {
  let count = 0;
  let firstAt = -1;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      if (firstAt === -1) firstAt = i;
      count++;
    }
  }
  return count === 0 ? null : { path, count, firstAt };
}

export function scanTree(paths: readonly string[], read: (path: string) => Uint8Array): ScanResult {
  let allowed = 0;
  const findings: NulFinding[] = [];
  for (const path of paths) {
    const finding = findNuls(path, read(path));
    if (finding === null) continue;
    if (hasKnownBinaryExtension(path)) allowed++;
    else findings.push(finding);
  }
  return { scanned: paths.length, allowed, findings };
}

/**
 * The message names what to DO. "NUL byte found" invites deleting the file,
 * which is the one wrong move — the file is almost always fine and needs
 * re-saving, and in the live case the byte was doing a real job that the escape
 * does identically.
 */
export function refusal(result: ScanResult): string {
  const plural = result.findings.length === 1 ? 'file' : 'files';
  const listed = result.findings
    .map(
      (f) =>
        `  ${f.path}\n` +
        `      ${f.count} NUL byte(s), first at byte ${f.firstAt}` +
        (f.firstAt >= 8000 ? '  <- past 8000, so `git grep -I` calls this file TEXT' : '')
    )
    .join('\n');

  return (
    `check-nul-bytes: FAILED · exit 1 · ${result.scanned} tracked files scanned · ` +
    `${result.allowed} binary assets skipped · ${result.findings.length} source ${plural} ` +
    `carry a literal NUL\n\n${listed}\n\n` +
    `WHAT THIS BREAKS. \`grep -I\` means "skip binary files" and a NUL makes a file\n` +
    `binary, so the \`secret-scan\` job in ci.yml does not scan this file at all — and\n` +
    `the skip is silent, indistinguishable from a clean result. Git also stores it as\n` +
    `binary, so its diff is unreadable and \`blame\` is useless on it, permanently.\n\n` +
    `WHAT TO DO — and DO NOT DELETE THE FILE. It is almost certainly fine and needs\n` +
    `re-saving, or the byte is doing a real job that an escape does identically.\n\n` +
    `  1. If the NUL is deliberate (a separator that cannot occur in the joined\n` +
    `     values is a good idiom), write the two-character escape \`\\x00\` instead of\n` +
    `     the literal byte. Identical at runtime — same string, same length, same\n` +
    `     codepoint — and the file stays text. That is what SC-658 did to\n` +
    `     scripts/repoint-ingested-transactions.ts.\n\n` +
    `  2. If it was an accident (SC-650: a constant meant to hold a space held\n` +
    `     \\x00, and every check in the repo passed), re-save the file without it.\n\n` +
    `  3. If it is genuinely a new kind of binary ASSET, add its extension to\n` +
    `     BINARY_EXTENSIONS in scripts/check-nul-bytes.ts. That is a deliberate\n` +
    `     one-line change with a visible diff, which is the point.\n\n` +
    `FINDING IT IS HARDER THAN IT LOOKS: an agent shell's \`grep\` bakes in \`-I\`, and\n` +
    `\`git grep -I\` only inspects the first 8000 bytes, so both can report nothing.\n` +
    `Read the bytes instead:\n\n` +
    `  python3 -c "d=open('<path>','rb').read(); i=d.find(b'\\x00'); ` +
    `print('line', d[:i].count(b'\\n')+1)"\n`
  );
}

export function verdict(result: ScanResult): string {
  return (
    `check-nul-bytes: PASS · exit 0 · ${result.scanned} tracked files scanned · ` +
    `${result.allowed} binary assets skipped · 0 source files carry a literal NUL`
  );
}

/** Tracked paths, NUL-delimited so a newline in a filename cannot split one. */
export function trackedPaths(cwd: string): string[] {
  const run = spawnSync('git', ['ls-files', '-z'], { cwd, encoding: 'buffer' });
  if (run.status !== 0) {
    throw new Error(
      `git ls-files failed (${run.status}): ${new TextDecoder().decode(run.stderr ?? new Uint8Array())}`
    );
  }
  return new TextDecoder()
    .decode(run.stdout ?? new Uint8Array())
    .split('\0')
    .filter(Boolean);
}

if (import.meta.main) {
  const cwd = process.cwd();
  let paths: string[];
  try {
    paths = trackedPaths(cwd);
  } catch (error) {
    console.error(
      `check-nul-bytes: exit ${COULD_NOT_LOOK} · NO CHECK MADE — could not list tracked ` +
        `files in ${cwd}:\n  ${error instanceof Error ? error.message : String(error)}\n\n` +
        `This is not a pass.`
    );
    process.exit(COULD_NOT_LOOK);
  }

  // A run that scanned nothing is a refusal. An exit code cannot tell "every
  // file is clean" from "there were no files", and this check's whole subject
  // is a skip that looks like a pass (SC-190).
  if (paths.length === 0) {
    console.error(
      `check-nul-bytes: exit ${COULD_NOT_LOOK} · NO CHECK MADE — git listed 0 tracked ` +
        `files in ${cwd}.\n\nThis is not a pass.`
    );
    process.exit(COULD_NOT_LOOK);
  }

  const unreadable: string[] = [];
  const result = scanTree(paths, (path) => {
    try {
      return new Uint8Array(readFileSync(`${cwd}/${path}`));
    } catch {
      unreadable.push(path);
      return new Uint8Array();
    }
  });

  if (unreadable.length > 0) {
    console.error(
      `check-nul-bytes: exit ${COULD_NOT_LOOK} · NO CHECK MADE — ${unreadable.length} of ` +
        `${paths.length} tracked file(s) could not be read:\n  ${unreadable.slice(0, 5).join('\n  ')}\n\n` +
        `This is not a pass. A file skipped because it could not be opened is exactly the\n` +
        `silent-skip failure this check exists for.`
    );
    process.exit(COULD_NOT_LOOK);
  }

  if (result.findings.length > 0) {
    console.error(refusal(result));
    process.exit(1);
  }

  console.log(verdict(result));
}
