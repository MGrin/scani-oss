/**
 * Reading a source tree as CODE rather than as text.
 *
 * Extracted from `rtl-logical-properties.test.ts` when a second scanner needed
 * it (SC-762). Not a tidy-up: the state machine below is the fix for a false
 * red that reached the gate, and the argument for it is longer than the code.
 * Two copies of it would have been two places for that argument to be lost,
 * and the copy that loses it is the one that gets "simplified" back to a
 * per-line test by somebody who has not met the failure.
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
 * it forbids, and the fix that ticket shipped left exactly such a sentence in
 * `BalanceGapList.tsx`. Rewording the comment clears the red and leaves the
 * trap armed for the next person, so the scanner is what changes.
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
