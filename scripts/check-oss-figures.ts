#!/usr/bin/env bun
// Refuse a commit or a push that would carry a NEW, PRECISE DECIMAL FIGURE into
// MGrin/scani-oss without somebody saying out loud that it is synthetic.
//
// WHY THIS EXISTS (SC-887). A live account balance reached the public mirror
// inside a test fixture, twice caught by hand and by nothing else:
//
//   `secret-scan` looks for credentials, and a balance is not one. It matches
//   no pattern that check carries.
//
//   `oss-classify` answers *may this FILE be public*, not *may this VALUE be
//   public*. Every file in the leak was correctly `oss-eligible`.
//
//   `check-oss-internal-refs.ts` reads what is INSIDE a file that may travel,
//   which is the right axis — but every rule it carries reads ZERO against the
//   mirror, and this one cannot. Measured against `upstream/main` 2026-09-01:
//   858 figures in 176 files after the exclusions below, 2296 in 247 before
//   them. A rule of this shape added there would refuse 176 files on its first
//   run and be switched off inside a week.
//
//   Review does not catch it because a decimal in a fixture looks exactly like
//   a decimal in a fixture.
//
// THE MECHANISM, which is why it recurs and what the design has to answer. The
// instinct that produces it is a GOOD one: assert against a number a person
// would recognise. Reaching for a realistic value means reaching for a real
// one, and the nearest realistic value is in the ticket being worked from,
// because those tickets carry production measurements deliberately so their
// premises can be checked. Evidence-rich tickets are why the bugs get found and
// they are the supply line for this leak. Nothing here asks for vaguer tickets.
// It asks for one sentence at the moment the number is committed.
//
// WHY ADDED LINES AND NOT FILE CONTENT. That 176 is the whole argument. The
// stock is legitimate — a price formatter's test needs precise decimals, and so
// does a colour-space helper — and a guard that fires on the stock is a guard
// nobody runs. What is judgeable is the FLOW. Measured over the last 60 merges
// on the private `main`, added lines only:
//
//   2 fraction digits                     140 hits, 17 of 60 PRs (28%)
//   3+ fraction digits                     18 hits,  8 of 60 PRs (13%)
//   3+, ISO-8601 timestamps excluded        4 hits,  3 of 60 PRs ( 5%)
//
// Fourteen of those eighteen are the milliseconds field of a timestamp. Of the
// four that survive, two are the sanitised replacements in the very file the
// leak was in and two are a wallet balance — no false positive in 60 PRs.
//
// STATED LIMIT, AND IT IS HALF THE HAZARD: THIS CANNOT READ PROSE. The same
// leak named the live account in two docblocks, a test comment and both pull
// request descriptions, and no numeric pattern finds any of that. A guard that
// covered one half quietly would be trusted for both, so the refusal says so
// itself rather than leaving it in a ticket.
//
// `scripts/check-oss-prose.ts` reads the other half as of SC-909, and it does
// NOT close this limit — it narrows it. That check reports a SENTENCE carrying
// both a scope signal and a measurement, advisory and without an escape; a
// named credential, an account label and a person's name still travel past
// both of us. Neither check is a reason to skip reading your own diff.
//
// It is a seatbelt on the machine doing the work, not a gate on the repository:
// `--no-verify` skips it, and a fresh clone has no hooks until `bun install`
// sets `core.hooksPath`. Nothing here should be read as though it were a gate.
//
// Usage:
//   bun scripts/check-oss-figures.ts                    # staged additions
//   bun scripts/check-oss-figures.ts --stdin-commits    # additions in commits named on stdin
//   OSS_ALLOW_FIGURES=1 git commit ...                  # the escape

import { existsSync } from 'node:fs';
import { type BranchFacts, collectTreeMarkers } from './check-oss-bound-paths';
import { type RepoFacts, scanScope } from './check-oss-internal-refs';
import { EXIT_OK, EXIT_REFUSED, EXIT_UNKNOWN, type GitRun, runGit } from './lib/check-verdict';

/**
 * The guard could not verify itself. Its own code rather than a refusal,
 * because it says nothing about the content that was staged — and never
 * {@link EXIT_OK}, because an instrument that cannot demonstrate it still works
 * has not checked anything. Matches `check-oss-internal-refs.ts`.
 */
export const EXIT_SELF_TEST_FAILED = 10;

export { EXIT_OK, EXIT_REFUSED, EXIT_UNKNOWN };

/**
 * A decimal literal with THREE OR MORE fraction digits.
 *
 * The lookbehind rejects a middle component of a dotted version — in `2.4.12`
 * neither `4` nor `12` may open a match — and the lookahead keeps a match from
 * ending inside a longer run of digits.
 *
 * THREE IS A CALIBRATION AND NOT A CLAIM THAT TWO IS SAFE. `6500.32` and
 * `172.85`, two of the three figures SC-887 names, have two fraction digits and
 * this pattern does not see them. Both are already public and mgrin ruled
 * retro-scrubbing out of scope twice; the table above is why the threshold is
 * not simply lowered to catch them. Read a green run as *no imprecise-looking
 * figure was added*, never as *no production figure was added*.
 */
const FIGURE = /(?<![\d.])\d+\.\d{3,}(?![\d])/g;

/**
 * ISO-8601 timestamps, removed from a line before figures are looked for.
 *
 * THE ONLY EXCLUSION, and it is the difference between a guard people keep and
 * one they turn off: 14 of the 18 added figures over 60 merges are the
 * milliseconds field of one of these. A timestamp carries no financial
 * quantity, and both spellings appear in this repository's fixtures — the
 * extended form throughout the domain tests, the basic form in a dump filename.
 *
 * The TIMESTAMP is removed, never the line. A fixture that dates a balance is
 * the commonest shape in these tests, so blanking the line would switch the
 * guard off for exactly the lines it exists to read.
 */
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\.\d+|\d{8}T\d{6}\.\d+/g;

/** Every figure on one line, in the order they appear. */
export function findFigures(line: string): string[] {
  return line.replace(TIMESTAMP, '').match(FIGURE) ?? [];
}

/**
 * Extensions whose figures are never financial and whose volume would drown the
 * signal. Measured against `upstream/main`: the logo alone carries 1046 path
 * coordinates and `bun.lock` 47 resolved versions — together 1093 of the 2296
 * sites in the tree, none of them a quantity anybody measured.
 *
 * Kept deliberately short. Every other extension is read, including `.md`,
 * because a figure quoted in documentation is exactly as public as one in a
 * fixture.
 */
const UNREAD_EXTENSIONS: readonly string[] = ['.svg', '.lock', '.css', '.map', '.snap'];

/** Whether a path's added lines are read at all. */
export function isScannable(path: string): boolean {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot <= slash) return true;
  return !UNREAD_EXTENSIONS.includes(path.slice(dot).toLowerCase());
}

export interface AddedLine {
  readonly path: string;
  /** 1-indexed in the file as it stands after the change, so it can be pasted after a colon. */
  readonly line: number;
  readonly text: string;
}

/**
 * The added lines of a unified diff produced with zero context.
 *
 * Zero context is load-bearing rather than an optimisation: with context, an
 * untouched neighbouring line arrives indistinguishable from an added one only
 * by its first character, and the figure this guard is about would be reported
 * against a commit that did not introduce it. A false accusation is how a guard
 * loses the benefit of the doubt on the true ones.
 */
export function addedLines(diff: string): AddedLine[] {
  const out: AddedLine[] = [];
  let path: string | null = null;
  let next = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      // `/dev/null` is a deletion; there is no post-image to number.
      path = target === '/dev/null' ? null : target.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      next = m ? Number(m[1]) : 0;
      continue;
    }
    if (raw.startsWith('+') && path !== null && next > 0) {
      out.push({ path, line: next, text: raw.slice(1) });
      next++;
    }
  }
  return out;
}

/**
 * EVERY RULE HERE READS ZERO ON A CLEAN BRANCH, which means a green run and a
 * pattern that has silently stopped matching produce identical output. That is
 * the exact failure this guard exists to prevent, sitting inside the guard.
 *
 * So each probe carries strings a figure MUST be found in and strings it must
 * NOT, and both are checked before anything is read. A green then means *the
 * guard looked and found nothing* rather than *something returned zero*, and
 * the count of probes exercised is printed beside the count of figures for the
 * same reason the denominator is (`scripts/lib/check-verdict.ts`).
 */
export interface Probe {
  readonly name: string;
  readonly mustFind: readonly string[];
  readonly mustNotFind: readonly string[];
}

/**
 * EVERY FIGURE HERE IS INVENTED, AND THE FIRST DRAFT OF THIS FILE GOT IT WRONG
 * IN THE MOST INSTRUCTIVE WAY AVAILABLE. It used the balance that actually
 * leaked, on the reasoning that a guard whose probe cannot name the value it
 * exists to catch is testing something else — which is a good argument and the
 * wrong conclusion here. That value is inert only BECAUSE it was scrubbed from
 * `upstream/main`; this file is published, so writing it back in is committing
 * the leak a second time, in the guard against it, permanently and by design.
 *
 * `98765.43210987` is a descending keyboard run and `0.7497719` is already
 * public in two mirror fixtures. Neither measures anything.
 *
 * Note how close the reasoning came: `check-oss-internal-refs.ts` splits every
 * probe across a `${}` boundary for exactly this reason and says so, and the
 * argument for departing from it was persuasive enough to be written down
 * before it was checked. What settles it is not judgement but the rule this
 * whole check is built on — a figure precise enough to be a measurement is one
 * you have to be able to assert you invented, and nobody can assert that about
 * a number copied out of a leak report.
 */
const PROBES: readonly Probe[] = [
  {
    name: 'the value that leaked',
    mustFind: ["await setBalance(h, '98765.43210987');", 'balance: 0.7497719'],
    mustNotFind: [],
  },
  {
    name: 'below the threshold',
    mustFind: [],
    mustNotFind: ["expect(total).toBe('6500.32');", 'const pct = 172.85;'],
  },
  {
    name: 'a dotted version is not a figure',
    mustFind: [],
    mustNotFind: ['bunx @biomejs/biome@2.4.12 check', 'node 22.14.0'],
  },
  {
    name: 'an ISO-8601 timestamp is not a figure',
    mustFind: [],
    mustNotFind: [
      "externalId: 'manual-edit:2026-08-03T09:00:00.000Z'",
      "'2026-08-03 09:00:00.000'",
      "expect('scani-20260829T060000.123Z.dump')",
    ],
  },
  {
    name: 'the timestamp is removed, not the line',
    mustFind: ["{ capturedAt: '2026-08-31T03:01:00.000Z', balance: '98765.43210987' }"],
    mustNotFind: [],
  },
  {
    name: 'an integer is not a figure',
    mustFind: [],
    mustNotFind: ['const CAP = 98765;', 'retries: 3'],
  },
];

export const PROBE_COUNT = PROBES.length;

/** Every probe that has stopped behaving as written, in the order declared. */
export function verifyProbes(probes: readonly Probe[]): string[] {
  const broken: string[] = [];
  for (const probe of probes) {
    for (const s of probe.mustFind) {
      if (findFigures(s).length === 0) broken.push(`${probe.name}: no longer finds "${s}"`);
    }
    for (const s of probe.mustNotFind) {
      if (findFigures(s).length > 0)
        broken.push(`${probe.name}: now finds a figure in "${s}", which it must not`);
    }
  }
  return broken;
}

export function selfTest(): string[] {
  return verifyProbes(PROBES);
}

/**
 * `ref` is the commit being JUDGED, and defaulting it to `HEAD` is what makes
 * the pre-push caller correct (SC-813, in the sibling). `git push upstream
 * branchB` while standing on private branchA would otherwise classify branchA,
 * read `private`, and SKIP — a silent pass on a mirror-bound push, which is
 * this check's own subject reproduced inside its caller.
 */
export function collectBranchFacts(cwd: string, ref: string): BranchFacts {
  const remotes = runGit(['remote'], cwd);
  const upstreamMainResolved =
    runGit(['rev-parse', '--verify', '--quiet', 'refs/remotes/upstream/main'], cwd).kind === 'ran';
  return {
    subject: ref,
    hasUpstreamRemote:
      remotes.kind === 'failed' ? null : remotes.stdout.trim().split('\n').includes('upstream'),
    upstreamMainResolved,
    upstreamIsAncestor:
      upstreamMainResolved &&
      runGit(['merge-base', '--is-ancestor', 'upstream/main', ref], cwd).kind === 'ran',
    originIsAncestor:
      runGit(['merge-base', '--is-ancestor', 'origin/main', ref], cwd).kind === 'ran',
    treeMarkers: collectTreeMarkers(ref),
  };
}

/** `--ref <sha>`, or `--ref=<sha>`; `HEAD` when the flag is absent. */
export function refArg(argv: readonly string[]): string {
  const i = argv.indexOf('--ref');
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1] as string;
  const inline = argv.find((a) => a.startsWith('--ref='));
  return inline === undefined ? 'HEAD' : inline.slice('--ref='.length);
}

/**
 * The population, as one diff or as a reason there is none.
 *
 * A git that FAILED is {@link EXIT_UNKNOWN}, never an empty diff. `git diff
 * --cached` legitimately returning nothing and `git diff` dying are not the
 * same fact and both arrive as `''`; only the first is a scan with nothing in
 * it (SC-775).
 */
function population(cwd: string, fromCommits: readonly string[] | null): GitRun {
  if (fromCommits === null) {
    return runGit(['diff', '--cached', '--unified=0', '--diff-filter=ACMR'], cwd);
  }
  const parts: string[] = [];
  for (const sha of fromCommits) {
    const r = runGit(
      ['diff-tree', '--no-commit-id', '-p', '--unified=0', '-r', '--diff-filter=ACMR', sha],
      cwd
    );
    if (r.kind === 'failed') return r;
    parts.push(r.stdout);
  }
  return { kind: 'ran', stdout: parts.join('\n') };
}

export function main(argv: readonly string[], cwd: string, stdin: string): number {
  const broken = selfTest();
  if (broken.length > 0) {
    for (const b of broken) console.error(`  ${b}`);
    console.error(
      `oss-figures: SELF-TEST FAILED · exit ${EXIT_SELF_TEST_FAILED} · ${broken.length} of ${PROBE_COUNT} probe(s) no longer behave as written — NOTHING WAS SCANNED`
    );
    return EXIT_SELF_TEST_FAILED;
  }

  const scope = scanScope(collectBranchFacts(cwd, refArg(argv)), {
    privateMarkerPresent: existsSync('.private-repo'),
  } satisfies RepoFacts);
  if (scope.kind === 'unknown') {
    console.error(`oss-figures: UNKNOWN · exit ${EXIT_UNKNOWN} · ${scope.why}`);
    return EXIT_UNKNOWN;
  }
  if (scope.kind === 'skip') {
    console.log(`oss-figures: SKIPPED · exit ${EXIT_OK} · ${scope.why}`);
    return EXIT_OK;
  }

  const commits = argv.includes('--stdin-commits')
    ? stdin
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    : null;

  const diff = population(cwd, commits);
  if (diff.kind === 'failed') {
    console.error(
      `oss-figures: UNKNOWN · exit ${EXIT_UNKNOWN} · could not read the ${commits === null ? 'staged' : 'pushed'} changes — ${diff.why} — NOTHING WAS SCANNED`
    );
    return EXIT_UNKNOWN;
  }

  const added = addedLines(diff.stdout);
  const read = added.filter((l) => isScannable(l.path));
  const unread = new Set(added.filter((l) => !isScannable(l.path)).map((l) => l.path));

  const found: { line: AddedLine; figure: string }[] = [];
  for (const line of read) {
    for (const figure of findFigures(line.text)) found.push({ line, figure });
  }

  // The denominator is printed on every outcome. `0 figure(s)` beside no count
  // at all is indistinguishable from a run that read nothing.
  const where =
    commits === null ? 'staged path(s)' : `path(s) in ${commits.length} pushed commit(s)`;
  const tail =
    `${PROBE_COUNT} probe(s) self-tested, ${read.length} added line(s) read across ` +
    `${new Set(read.map((l) => l.path)).size} ${where}` +
    (unread.size > 0 ? `, ${unread.size} path(s) not read (${UNREAD_EXTENSIONS.join(' ')})` : '');

  if (process.env.OSS_ALLOW_FIGURES === '1') {
    if (found.length === 0) {
      console.log(
        `oss-figures: ${VERDICT_OK} · exit ${EXIT_OK} · ${tail} · OSS_ALLOW_FIGURES=1 was set and admitted nothing`
      );
      return EXIT_OK;
    }
    for (const { line, figure } of found) console.log(`  ${line.path}:${line.line}  ${figure}`);
    console.log(
      `oss-figures: ${VERDICT_OK} · exit ${EXIT_OK} · ${tail} · OSS_ALLOW_FIGURES=1 admitted ${found.length} figure(s): you have asserted they are not drawn from production data`
    );
    return EXIT_OK;
  }

  if (found.length === 0) {
    console.log(`oss-figures: ${VERDICT_OK} · exit ${EXIT_OK} · ${tail}, 0 figure(s)`);
    return EXIT_OK;
  }

  for (const { line, figure } of found) console.error(`  ${line.path}:${line.line}  ${figure}`);
  console.error(
    `oss-figures: REFUSED · exit ${EXIT_REFUSED} · ${tail}, ${found.length} new figure(s) in ${new Set(found.map((f) => f.line.path)).size} file(s)`
  );
  console.error(
    '\n  These lines are bound for MGrin/scani-oss. Each figure above is precise\n' +
      '  enough to be a measurement rather than a round number, and this check\n' +
      '  cannot tell one somebody made up from one taken off a real account.\n' +
      '\n' +
      '  Replace anything drawn from production with a synthetic value. If they are\n' +
      '  already synthetic, re-run with OSS_ALLOW_FIGURES=1 — setting it is you\n' +
      '  asserting that none of them came from real data (SC-887).\n' +
      '\n' +
      '  WHAT THIS CANNOT SEE, and it was half of the leak that caused it: PROSE.\n' +
      '  The same change named a live account in two docblocks, a test comment and\n' +
      '  both pull request descriptions, and no numeric pattern finds any of that.\n' +
      '  Read the comments and the PR body yourself before you clear this.'
  );
  return EXIT_REFUSED;
}

const VERDICT_OK = 'PASS';

if (import.meta.main) {
  const stdin = process.argv.includes('--stdin-commits') ? await Bun.stdin.text() : '';
  process.exit(main(process.argv.slice(2), process.cwd(), stdin));
}
