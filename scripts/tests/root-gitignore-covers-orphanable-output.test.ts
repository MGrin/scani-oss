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
