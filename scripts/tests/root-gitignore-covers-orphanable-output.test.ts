import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// SC-577, and SC-569 before it. A per-directory `.gitignore` is a TRACKED
// FILE. Any checkout of this tree that does not contain that directory deletes
// it — and every artefact whose only ignore rule lived there stops being
// ignored, becoming an ordinary untracked file that the next `git add -A`
// takes. Measured at eleven files, one of them Terraform state.
//
// The root `.gitignore` is the one ignore file every checkout has, so these
// patterns live there. This test exists because that reasoning is invisible
// from the patterns themselves: a later tidy-up sees ten globs for tools this
// directory does not use and removes them, and nothing anywhere goes red.
//
// WHY EACH ONE IS A GLOB AND NOT A PATH, which is the part to argue with
// before changing it: a list of directories in a file shared with a public
// mirror is an inventory of what some other checkout of this tree contains.
// `**/.next/` names nothing and covers every app that ever adds one.
//
// This is a PRESENCE assertion on purpose. An absence guard — "no tracked file
// matches these" — is the more natural thing to write and it can go vacuous:
// it keeps passing after the patterns are gone, because then nothing matches
// them either. The shadowing question is real, and it was answered by asking
// git across both repositories rather than by asserting a zero here.
//
// (These are line comments rather than a docblock for a reason worth one
// sentence: a `**/` glob contains `*/`, which closes a block comment.)
const ROOT = join(import.meta.dir, '..', '..');
const IGNORES = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));

// Every pattern that a per-directory `.gitignore` in SOME checkout of this
// tree is, or was, the only carrier of. Adding a per-directory ignore file is
// fine; being the only place a rule lives is what this list prevents.
const MUST_BE_AT_THE_ROOT = [
  '**/.next/',
  '**/.vercel/',
  '**/.turbo/',
  '**/.wrangler/',
  '**/next-env.d.ts.bak',
  '**/public/version.json',
  '**/.terraform/',
  '**/*.tfstate',
  '**/*.tfstate.backup',
  '**/tfplan',
] as const;

const GLOB_PREFIX = '**/';

// The leaf a pattern matches, with the trailing `/` that merely says
// "directory" removed. What matters is whether an INTERIOR slash remains,
// because that is what turns a glob into a path.
function leafOf(pattern: string): string {
  return pattern.slice(GLOB_PREFIX.length).replace(/\/$/, '');
}

// SC-758. A SECOND reason a rule must be in the root `.gitignore` of every
// checkout, and it is not the orphaning above.
//
// These name agent scratch. Nothing in this repository creates them and no
// contributor here will meet one — which is what makes them read as debris,
// the same invisibility the header above describes arriving by another route.
// An untracked directory SURVIVES `git checkout`, so a session that continues
// on a branch of this tree brings its scratch with it, and a `.gitignore` that
// does not name the path lets the next `git add -A` take it.
//
// Measured 2026-08-28, one throwaway repo per copy of this file with identical
// contents and the ignore rules the only variable: both samples below were
// STAGEABLE under the copy lacking these lines. Control: `scani-test-fixture-*`
// was ignored under both, so that reading was the rule missing rather than the
// probe broken.
//
// WHY THIS ASKS GIT INSTEAD OF GREPPING THE FILE, which is what the list above
// does. `toContain` pins one SPELLING. An equivalent rewrite passes while
// asserting nothing, and a `!` negation added anywhere later un-ignores the
// path with the string it looks for still present. `git check-ignore` answers
// the question that is actually load-bearing — is a path of this shape
// uncommittable here — and it is the same question `git add` will ask.
//
// AND IT ASSERTS WHICH FILE ANSWERED, NOT JUST THE VERDICT. `.context/` was
// ignored for months by `.git/info/exclude`: untracked and per-clone, so every
// worktree of that one clone honoured it and a fresh clone did not (SC-681,
// SC-685). `check-ignore` is satisfied by either source, so a guard reading
// only the verdict goes green on the very mechanism this exists to replace.
const AGENT_SCRATCH = [
  {
    sample: '.tmp-thr_zz/scratch.md',
    why: 'per-thread worker scratch. The root `.gitignore` is the ONLY tracked file in this tree that names the pattern, so its reason lives entirely outside the repository and a reader who goes looking finds nothing.',
  },
  {
    sample: '.context/handoff.md',
    why: 'cross-agent notes and handoffs. It is documented as gitignored in as many words, which is what makes a checkout lacking the rule serve a FALSE promise rather than merely an absent one.',
  },
] as const;

// Tracked in every checkout that can run this test, and matched by no rule.
// Without it, a `check-ignore` that answered "ignored" to everything — or a
// parse that mapped every path to a source — would satisfy the assertions
// below while measuring nothing.
const NEVER_IGNORED_CONTROL = '.gitignore';

// One spawn for the whole file. `git check-ignore -v` prints
// `<source>:<line>:<pattern>\t<path>` per IGNORED path and nothing for the
// rest, so a path's absence from this map is the negative reading.
//
// Exit 0 means at least one path matched and exit 1 means none did; both are
// answers. ANYTHING ELSE IS THE PROBE FAILING AND MUST NOT READ AS "nothing is
// ignored" — `exitCode` is `null` when the subprocess was killed, which under
// load is a real outcome and would otherwise hand this file an empty map and
// three green tests (SC-694, SC-787).
function ignoreSources(paths: readonly string[]): Map<string, string> {
  const probe = Bun.spawnSync(['git', 'check-ignore', '-v', '--stdin'], {
    cwd: ROOT,
    stdin: Buffer.from(`${paths.join('\n')}\n`),
  });
  if (probe.exitCode !== 0 && probe.exitCode !== 1) {
    throw new Error(
      `git check-ignore did not answer (exitCode ${probe.exitCode}): ${probe.stderr.toString().trim()}`
    );
  }
  const sources = new Map<string, string>();
  for (const line of probe.stdout.toString().split('\n')) {
    const [source, path] = line.split('\t');
    if (source && path) sources.set(path, source);
  }
  return sources;
}

// Probed ONCE, but on first use rather than while the suite is being built.
//
// Called at `describe` scope, a throw in here aborts registration and the four
// tests below never exist: the run reports `1 error` and `12 pass / 0 fail`,
// exit 1 — measured 2026-08-28. Loud enough at the exit code, and the count
// drops by four with `0 fail` printed above it, which is the reading a human
// takes. A guard whose failure mode moves the test COUNT is worse than one
// that fails a test, because the count is what a green gets quoted by
// (SC-190). Lazily, the same breakage is three named failures and 16 tests.
let probed: Map<string, string> | undefined;
function ignoredSources(): Map<string, string> {
  if (!probed)
    probed = ignoreSources([...AGENT_SCRATCH.map((e) => e.sample), NEVER_IGNORED_CONTROL]);
  return probed;
}

describe('the root .gitignore is what makes agent scratch uncommittable', () => {
  // The must-be-FOUND half and the must-be-ABSENT half of one reading. Either
  // alone is satisfied by a broken probe: an empty map passes the absence, and
  // a map that ignores everything passes the presence.
  test('the probe discriminates: it ignores some of what it is asked and not all', () => {
    const sources = ignoredSources();
    expect(sources.size).toBeGreaterThan(0);
    expect(sources.has(NEVER_IGNORED_CONTROL)).toBe(false);
  });

  test.each([...AGENT_SCRATCH])('$sample is ignored, and by this file', (entry) => {
    // Named rather than asserted as a boolean, so a failure says which path
    // became committable and what — if anything — was still ignoring it.
    // Both halves in one assertion: matched at all, and matched HERE.
    const source = ignoredSources().get(entry.sample) ?? 'NOTHING — it is committable';
    expect(`${entry.sample} <- ${source}`).toMatch(/ <- \.gitignore:\d+:/);
  });

  test('every entry carries the reason it looks removable', () => {
    for (const entry of AGENT_SCRATCH) expect(entry.why.length).toBeGreaterThan(80);
  });
});

describe('the root .gitignore carries every rule a deleted directory would orphan', () => {
  test.each([...MUST_BE_AT_THE_ROOT])('%s is at the root', (pattern) => {
    expect(IGNORES).toContain(pattern);
  });

  // THE ONE WORTH KEEPING LONGEST. Terraform state carries resource
  // identifiers and, for several providers, credentials in plaintext — so of
  // everything above, this is the pattern whose absence costs the most, and
  // the assertions above would still pass if it were spelled as a path.
  test('the Terraform patterns are globs, so they cannot become an inventory', () => {
    const terraform = IGNORES.filter((p) => p.includes('tfstate') || p.includes('terraform'));
    expect(terraform.length).toBeGreaterThan(0);
    for (const pattern of terraform) {
      expect(pattern.startsWith(GLOB_PREFIX)).toBe(true);
      // A path would carry a directory name between the glob and the leaf.
      expect(leafOf(pattern)).not.toContain('/');
    }
  });

  test('every pattern in the list is a glob, not a path', () => {
    // `public/version.json` is the deliberate exception: the two-segment leaf
    // IS the framework convention being matched, not a location in this tree.
    // Anything else with an interior slash would be naming a directory.
    for (const pattern of MUST_BE_AT_THE_ROOT) {
      expect(pattern.startsWith(GLOB_PREFIX)).toBe(true);
      const leaf = leafOf(pattern);
      if (leaf !== 'public/version.json') expect(leaf).not.toContain('/');
    }
  });
});
