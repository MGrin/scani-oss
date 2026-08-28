import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * SC-601. Three tests under `scripts/tests/` rewrite TRACKED SOURCE in place —
 * they mutate a file `docs:check` reads, run the check, assert on the finding
 * and restore in `finally`. `SIGKILL` skips `finally` exactly as it skips
 * `afterEach` (SC-596), so a killed gate leaves a tracked file mutated on disk,
 * where `git add -A` sweeps it into a commit nobody wrote a diff for. That is
 * worse than SC-596's stray fixture: an untracked corpse at least announces
 * itself as new, and a modified tracked file does not.
 *
 * SC-596's sweep cannot cover it. That one matches a NAME PATTERN, because its
 * corpses are files that should not exist. Here the corpse is a legitimate
 * filename with the wrong contents, so no glob can find it.
 *
 * A reverse-substitution sentinel — "if `check-docs.ts` says `docs-moved-away`,
 * put `docs` back" — covers two of the three sites and structurally cannot
 * cover the third: `check-docs-package-inventory.test.ts` writes a whole
 * rewritten CLAUDE.md whose mutations are DELETIONS and REFORMATTINGS, and a
 * deleted bullet leaves nothing to match on. Restoring from `HEAD` instead is
 * the wrong instrument for all three, because it discards a developer's real
 * uncommitted edits to the same file.
 *
 * So the pre-mutation bytes are journalled to disk BEFORE the first write, and
 * the journal is replayed at the start of the next run. A run repairs its
 * predecessors even when it is itself killed, which a `process.on('exit')`
 * handler cannot do. Restoration is exact rather than "whatever HEAD says", so
 * uncommitted work in the same file survives.
 *
 * The journal is gitignored, so the repair for one committable artefact cannot
 * introduce another. `scripts/check-staged-test-fixtures.ts` refuses a commit
 * while one exists, which closes the window between the kill and the next run —
 * the window where the bad commit actually happens.
 */

/** Gitignored, and matched by the sweep whatever pid wrote it. */
export const MUTATION_JOURNAL_GLOB = 'scripts/.source-mutation-journal-*.json';

/** Relative path → the file's content immediately before this run mutated it. */
type Journal = { pid: number; files: Record<string, string> };

function journalPath(repoRoot: string, pid: number): string {
  return path.join(repoRoot, `scripts/.source-mutation-journal-${pid}.json`);
}

function toRelative(repoRoot: string, file: string): string {
  return path.isAbsolute(file) ? path.relative(repoRoot, file) : file;
}

/**
 * Written under a temporary name and renamed, so a kill mid-write leaves either
 * no journal or a complete one. A half-written journal would be replayed as a
 * truncated file — the repair doing the damage it exists to prevent.
 */
function writeJournal(file: string, journal: Journal): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.writing`;
  writeFileSync(staging, JSON.stringify(journal));
  renameSync(staging, file);
}

/**
 * Mutate tracked source files, run something against the mutated tree, and put
 * the exact previous bytes back — journalling them first so a killed run is
 * repairable by the next one.
 *
 * `edits` maps a path (absolute, or relative to `repoRoot`) to its full new
 * content.
 *
 * **A VOID MUTATION IS REFUSED HERE (SC-787).** An arm that hands back content
 * identical to what is on disk runs against UNMUTATED source and returns the
 * baseline — and a baseline green from a mutation arm does not read as *the
 * instrument misfired*, it reads as **the guard cannot catch this bug**. That is
 * the likelier interpretation and the wrong one, and acting on it means widening
 * a guard that was fine. Measured on SC-746's arm B: `103 pass / 0 fail`, one
 * sentence from being reported as a gap, when the patch had simply never landed
 * because biome had reformatted the ternary it targeted.
 *
 * **Why the guard belongs at this frame and not at the call sites.** This
 * signature takes FULL NEW CONTENT, so it cannot no-op itself — which is exactly
 * what makes it look safe. The hazard is one frame up, in callers building that
 * content with `.replace()`, which returns the subject unchanged when the
 * pattern is absent, silently and with no error.
 * `scripts/tests/check-docs-package-inventory.test.ts` both calls this and
 * builds its content by replacement. A per-call-site `assert` would cover the
 * callers that exist today; this covers the ones written next year.
 *
 * **There is no opt-out because there is no legitimate case.** A mutation that
 * changes nothing tests nothing.
 *
 * **What this does NOT cover, stated so nobody reads it as more than it is.** It
 * catches a void arm, not a *wrong* one: content that differs from the original
 * but mutates something other than what the author meant still passes here. And
 * it only matters in one direction — a RED arm is self-verifying, because
 * something changed behaviour, so the patch necessarily landed. Only GREEN arms
 * need their landing asserted. That is most arms in this repo, and not all.
 *
 * The refusal is raised BEFORE the journal is written and before any file is
 * touched, so it leaves no artefacts: no mutated tracked file, no journal for
 * the next run to replay. A refusal that has to be cleaned up is one more thing
 * that can fail.
 */
export function withMutatedSources<T>(
  repoRoot: string,
  edits: Record<string, string>,
  run: () => T
): T {
  const originals: Record<string, string> = {};
  const unchanged: string[] = [];
  for (const [file, body] of Object.entries(edits)) {
    const rel = toRelative(repoRoot, file);
    originals[rel] = readFileSync(path.join(repoRoot, rel), 'utf8');
    if (body === originals[rel]) unchanged.push(rel);
  }

  if (unchanged.length > 0) {
    throw new Error(
      `withMutatedSources refused: the new content is byte-identical to what is ` +
        `already on disk for ${unchanged.join(', ')}. This arm would have run against ` +
        `unmutated source and returned the baseline, which reads as "the guard cannot ` +
        `catch this" rather than "the patch never landed" (SC-787). Check the string ` +
        `the edit is built from — \`.replace()\` returns the subject unchanged when the ` +
        `pattern is absent. Nothing was written and no journal was created.`
    );
  }

  // Before the first mutation, never after: the whole point is that a kill
  // between these two statements is survivable.
  const journal = journalPath(repoRoot, process.pid);
  writeJournal(journal, { pid: process.pid, files: originals });

  try {
    for (const [file, body] of Object.entries(edits)) {
      writeFileSync(path.join(repoRoot, toRelative(repoRoot, file)), body);
    }
    return run();
  } finally {
    for (const [rel, body] of Object.entries(originals)) {
      writeFileSync(path.join(repoRoot, rel), body);
    }
    rmSync(journal, { force: true });
  }
}

/**
 * Journals a killed run left behind, as repo-relative paths. Read from the
 * filesystem rather than from git: the journal is ignored, so `git ls-files`
 * cannot see it.
 */
export function strandedMutationJournals(repoRoot: string): string[] {
  return Array.from(
    new Bun.Glob(MUTATION_JOURNAL_GLOB).scanSync({ cwd: repoRoot, dot: true })
  ).sort();
}

function readJournal(repoRoot: string, rel: string): Journal {
  const abs = path.join(repoRoot, rel);
  try {
    return JSON.parse(readFileSync(abs, 'utf8')) as Journal;
  } catch (cause) {
    // Loud rather than skipped: an unreadable journal means one or more tracked
    // files are stranded and nothing left knows which. Deleting it quietly
    // would turn that into a tree nobody can tell is damaged.
    throw new Error(
      `${rel} is unreadable, so a killed run's source mutations cannot be undone. ` +
        `Check \`git status\` for a modified tracked file under scripts/ or packages/, ` +
        `restore it with \`git checkout --\`, then delete ${rel}.`,
      { cause }
    );
  }
}

/** The file's content, or `undefined` when it is not there. */
function readIfPresent(abs: string): string | undefined {
  try {
    return readFileSync(abs, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Put back every file a killed run left mutated, and delete the journal.
 * Returns the paths restored, so a caller can say so rather than repairing
 * silently. Safe to call when there is nothing to repair.
 */
export function replayStrandedMutations(repoRoot: string): string[] {
  const restored = new Set<string>();

  for (const rel of strandedMutationJournals(repoRoot)) {
    const journal = readJournal(repoRoot, rel);
    for (const [file, body] of Object.entries(journal.files ?? {})) {
      // Read and let ENOENT answer the question, rather than asking
      // `existsSync` first: the journal IS the pre-mutation state, so a missing
      // file is restored too — the run that removed it was the same one that
      // failed to put it back — and a check-then-use pair here is a race
      // CodeQL is right to flag (`js/file-system-race`).
      if (readIfPresent(path.join(repoRoot, file)) !== body) {
        writeFileSync(path.join(repoRoot, file), body);
        restored.add(file);
      }
    }
    rmSync(path.join(repoRoot, rel), { force: true });
  }

  return Array.from(restored).sort();
}
