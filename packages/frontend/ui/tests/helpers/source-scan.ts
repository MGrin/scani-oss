/**
 * Reading a source tree as CODE rather than as text.
 *
 * Three guards scan source files for class names that render fine and mean the
 * wrong thing in a right-to-left document, and until SC-773 each carried its
 * own copy of this machinery: the v3 guard, the cloud/admin guard, and the
 * animation-axis guard in this package. The copies were measured identical, so
 * nothing had drifted yet — but the state machine below is the fix for a false
 * red that reached the gate (SC-760), and three places for that argument to be
 * lost is three chances for the copy that loses it to be "simplified" back to a
 * per-line test by somebody who has not met the failure.
 *
 * IT LIVES IN `@scani/ui` BECAUSE THIS PACKAGE IS BELOW EVERY CONSUMER.
 * `apps/frontend/app` depends on `@scani/ui`; `@scani/ui` depends on nothing
 * above it. A helper in the app's test tree would have to be imported by this
 * package's own guard, which inverts the direction the workspace layout exists
 * to enforce. This location is also mirrored, which the app's is too — but
 * `apps/frontend/{cloud,admin}` are private-only, and a guard that must work in
 * both repos cannot import a module that exists in only one (SC-598).
 *
 * NOT EVERY SCANNER IN THIS REPO USES IT YET. Several guards still carry a
 * per-line `isComment` with the bug SC-760 fixed here, and `scripts/mutate.ts`
 * carries a fourth. SC-776 names them, dates the reading and carries the
 * falsifier — deliberately a POINTER and not a list, because a count asserted
 * in a comment goes stale the moment one of them is fixed, silently, since
 * nothing compiles prose. Converting them is a BEHAVIOUR change (a stateful
 * skipper skips strictly more lines, which makes a guard quieter) and so is
 * not part of SC-773, which is behaviour-neutral by construction.
 *
 * NOT a reason, though it was recorded as one: that `deps:unused` would report
 * a helper here with no upstream importer. It would not. Every workspace's knip
 * `project` is `src/**`, so `tests/**` is outside the scan entirely — measured
 * with a planted orphan under `tests/helpers/` (unreported) beside one under
 * `src/` (reported). Nothing mechanical polices this; the reason to keep one
 * copy is the argument above, not a check that would catch you.
 */

/**
 * Prose about a construct is not a use of it.
 *
 * THIS IS STATEFUL, AND THE FIRST CUT WAS NOT — which cost a false red on the
 * gate (SC-760). A per-line test catches `//`, ` *` and the OPENING line of a
 * `/*` or `{/*` block, and misses every CONTINUATION line of a JSX block
 * comment, because those begin with ordinary prose. The sentence
 *
 *     A number is written left-to-right in every locale
 *
 * is then read as code, and `left-to` matches the physical-inset pattern.
 *
 * **The self-match rate is HIGHEST in the files the scanner most needs to be
 * right about**, and that is the whole reason this is not an edge case: a rule
 * about a word cannot be explained without writing the word. An RTL guard has
 * to say "left" and "right"; SC-762's guard has to name the argument-less call
 * it forbids. Rewording the comment clears the red and leaves the trap armed
 * for the next person, so the scanner is what changes.
 *
 * `blockDepth` tracks `/* ... *\/` across lines. A line that both opens and
 * closes is a comment and does not open a block.
 */
export function commentSkipper(): (line: string) => boolean {
  let inBlock = false;
  return (line: string): boolean => {
    const trimmed = line.trimStart();
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      return true;
    }
    const startsComment =
      trimmed.startsWith('*') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*') ||
      trimmed.startsWith('{/*');
    if (!startsComment) return false;
    // Opens a block that this line does not close: everything until `*/` is prose.
    if (line.includes('/*') && !line.includes('*/')) inBlock = true;
    return true;
  };
}

/** A file to scan. Consumers may carry more fields; only these two are read. */
export interface ScanSource {
  path: string;
  name: string;
}

export interface Hit {
  file: string;
  line: number;
  text: string;
}

export async function scan(pattern: RegExp, files: readonly ScanSource[]): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const source of files) {
    const text = await Bun.file(source.path).text();
    // One skipper per FILE: block state must not leak across files, or an
    // unterminated comment in one would blind the scanner to the next.
    const isComment = commentSkipper();
    text.split('\n').forEach((line, index) => {
      if (isComment(line) || !pattern.test(line)) return;
      hits.push({ file: source.name, line: index + 1, text: line.trim() });
    });
  }
  return hits;
}

export const formatHits = (hits: readonly Hit[]): string[] =>
  hits.map((hit) => `${hit.file}:${hit.line} — ${hit.text}`);
