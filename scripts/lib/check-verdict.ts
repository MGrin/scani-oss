/**
 * A CHECK THAT COULD NOT RUN AND A CHECK THAT PASSED MUST NOT SHARE AN OUTPUT
 * OR AN EXIT CODE (SC-771, SC-779, SC-780).
 *
 * Stated once, here, because it was rediscovered five times as five separate
 * tickets — SC-190, SC-488, SC-640, SC-743, SC-775 — and each fix was correct
 * and local, so the sixth site had nothing to inherit. `gate-db` is the worked
 * example: it prints `PASS`, `FAILED` and `GATE UNVERIFIED`, three words rather
 * than two, and the third is not a louder failure. It says the run happened and
 * its result is not evidence about anything.
 *
 * The failure has three mechanisms and they need different remedies:
 *
 *   A SUBPROCESS whose failure converts to an empty success value. `git`
 *   exiting 128 hands back `''`, which splits to no paths, which reads as *the
 *   tree has nothing*. {@link GitRun} closes this at the type level — a caller
 *   cannot reach `stdout` without narrowing `kind`, so the compiler enumerates
 *   the consumers instead of a reviewer having to. Reading the status is not
 *   enough on its own: SC-775's helper returned `{ ok, stdout }` and three of
 *   its seven call sites simply did not read `ok`, and the three that did were
 *   the three whose failure was harmless.
 *
 *   A CODE PATH that legitimately examines nothing and falls through to the
 *   success exit. No type can catch this, because nothing went wrong — the
 *   population was empty. What catches it is a printed DENOMINATOR that covers
 *   the population, so a run that examined zero things cannot look like a run
 *   that examined all of them. A count of PATTERNS COMPILED is the trap:
 *   it is a real, specific number about a different question, and it makes the
 *   line look instrumented while saying nothing about whether a file was read.
 *
 *   A POPULATION EXAMINED ONLY IN PART, with the denominator already correct
 *   and the VERDICT WORD still `PASS`. This is the mechanism the remedy above
 *   does not reach, and it is the one that survives having applied it (SC-842).
 *   `check-oss-internal-refs.ts` printed
 *
 *       oss-internal-refs: PASS · 0 of 8 staged file(s) scanned, 8 binary
 *       skipped
 *
 *   over eight PNGs bound for the public mirror. Every number there is honest —
 *   the denominator covers the population, the skip is counted and named — and
 *   the line still opens with the word that means *looked, and clean*. A reader
 *   who checks the verdict rather than reconciling two integers is told the
 *   opposite of what happened, and checking the verdict is what a verdict is
 *   for.
 *
 *   So the denominator is necessary and not sufficient: **the word has to agree
 *   with it.** Where a check can examine part of its population, it needs a
 *   verdict for that too, and it must not be the one it prints for a complete
 *   run. Note the direction — this is not a failure, so it is not
 *   {@link EXIT_UNKNOWN} either. The check ran, and what it says is simply
 *   narrower than the reader assumes.
 *
 *   ONLY WHERE THE CHECK COULD NOT LOOK, never where it DECLINED to. An
 *   exclusion made on purpose and measured — `check-oss-figures.ts` not reading
 *   `.svg` or `.lock`, on the grounds that 1093 of 2296 figure sites in the
 *   tree are logo coordinates and resolved versions — is a decision about what
 *   is in scope, and a verdict is a statement about the scope it has. Widening
 *   the partial verdict to cover those would fire it on most ordinary commits,
 *   which is how the word stops meaning anything.
 *
 * {@link EXIT_UNKNOWN} is the shared number for the third verdict. It matches
 * `check-oss-bound-paths.ts` and `check-oss-internal-refs.ts`, which each
 * declared their own 9 before this file existed.
 */

/** The check ran and found nothing to complain about. */
export const EXIT_OK = 0;

/**
 * The check ran and is refusing. Distinct from {@link EXIT_UNKNOWN} on purpose:
 * a refusal is a claim about the tree, and an unknown is a claim about the
 * check.
 */
export const EXIT_REFUSED = 1;

/**
 * The check could not run, so its silence is not evidence. Never 0 — an exit
 * code cannot tell "everything passed" from "nothing was examined", which is
 * the whole failure this file is about.
 */
export const EXIT_UNKNOWN = 9;

/**
 * A git invocation that either RAN or did not — never a string a caller can use
 * without deciding which.
 *
 * `why` is a sentence, not a code: it carries git's own first line of stderr,
 * because a check that says *could not run* and cannot say why sends its reader
 * to look at the tree, which is the one place the answer is not.
 */
export type GitRun =
  | { readonly kind: 'ran'; readonly stdout: string }
  | { readonly kind: 'failed'; readonly why: string };

/**
 * Run git and report which of the two happened.
 *
 * `maxBuffer` is raised because the default truncates, and a truncated read is
 * this same defect wearing a success: `git ls-files` on a large tree would
 * return a SHORT list with status 0, and a short population reads as a clean
 * one. `check-oss-internal-refs.ts` already passed 64 MiB; its sibling passed
 * none.
 */
export function runGit(args: readonly string[], cwd: string): GitRun {
  let proc: Bun.SyncSubprocess;
  try {
    proc = Bun.spawnSync(['git', ...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // `Bun.spawnSync` THROWS when the binary is not on PATH rather than
    // returning a failed subprocess, and an uncaught throw here is not merely
    // untidy: it exits 1, which in a guard means REFUSED — a claim about the
    // tree — when the truth is that nothing was examined. Measured by running
    // the guard with `PATH=/var/empty`.
    return { kind: 'failed', why: `git ${args[0]} could not be run: ${(e as Error).message}` };
  }

  if (!proc.success) {
    const said = new TextDecoder().decode(proc.stderr).trim().split('\n')[0] ?? '';
    // `signalCode` is `undefined` rather than `null` when nothing signalled,
    // so a `!== null` test reports every ordinary non-zero exit as "killed by
    // undefined". Caught by running the helper against a non-repository.
    const how = proc.signalCode ? `was killed by ${proc.signalCode}` : `exited ${proc.exitCode}`;
    return { kind: 'failed', why: `git ${args[0]} ${how}${said === '' ? '' : `: ${said}`}` };
  }

  return { kind: 'ran', stdout: new TextDecoder().decode(proc.stdout) };
}

/**
 * What a SKIP did not read (SC-972).
 *
 * A skipping content scanner is the {@link EXIT_UNKNOWN} family's least
 * alarming costume: `SKIPPED · exit 0` over a commit **not one line of which
 * was read**, printed identically whatever was staged. SC-835 fixed the
 * sibling that routes PATHS — its skip now leads with the diff and keeps the
 * repository sentence as the reason — and left the four that scan CONTENT
 * printing the repository sentence alone, because the missing half is not
 * something the shared classifier can supply: `scanScope` is handed
 * `BranchFacts`, and the population differs per check. Whole files for
 * `check-oss-internal-refs`, added lines for `check-oss-figures`,
 * `check-oss-data-shapes` and `check-oss-prose`.
 *
 * So the renderer is shared and the counting is not. This is the denominator
 * rule at the top of this file applied to the one verdict that has no
 * denominator at all: a run that examined zero things must not read like a run
 * that examined all of them, and on a skip the honest number is zero with the
 * population beside it.
 *
 * NOTHING HERE CAN REFUSE, and that is the same reasoning SC-835 gives. The
 * skip is a conclusion about the BRANCH, which is still readable; a diff that
 * could not be listed is not evidence against it. Every failure narrows the
 * sentence and leaves the verdict and the exit code where they were.
 */
export interface Unread {
  /** Paths in the population, whether or not this check would have read them. */
  readonly paths: number;
  /**
   * Added lines this check would have read, for the checks that read a diff.
   *
   * `null` for a whole-file scanner, where the unit is the file and a line
   * count would be a number about a different question — the
   * patterns-compiled trap this file's header names.
   */
  readonly addedLines: number | null;
}

/**
 * The clause a content scanner's SKIP prints about the change it did not read.
 *
 * EVERY WAY OF NOT KNOWING READS DIFFERENTLY FROM A ZERO, for the reason
 * `routingClause` gives in `check-oss-bound-paths.ts`: `null` is *the change
 * could not be read*, a `paths` of 0 is *there was nothing staged*, and a
 * populated path set with no readable lines in it is a third thing again. A
 * check whose scope excluded every staged path and one with an empty index
 * printing alike is SC-808 and SC-865 rebuilt one verdict over.
 */
export function unreadClause(unread: Unread | null, noun: 'staged' | 'pushed'): string {
  if (unread === null) {
    return `the ${noun} change could not be read, so NOTHING WAS SCANNED — the absence of a reading, not a count of zero`;
  }
  if (unread.paths === 0) return `0 ${noun} path(s), so there was nothing to scan`;
  if (unread.addedLines === null) return `${unread.paths} ${noun} path(s) went UNSCANNED`;
  return `${unread.addedLines} added line(s) across ${unread.paths} ${noun} path(s) went UNSCANNED`;
}
