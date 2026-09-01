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
