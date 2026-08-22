import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * SC-528. CLAUDE.md's package list ran six workspaces short here and one short
 * in the mirror, under a heading claiming fifteen. Nothing noticed, because a
 * list nobody derives cannot disagree with anything.
 *
 * `docs:check` now derives it. These tests exist so that check has been SEEN to
 * fail — a guard nobody has watched go red is a guard nobody knows is wired up.
 *
 * They mutate the real CLAUDE.md and restore it in a `finally` around a single
 * synchronous spawn, so there is no window in which another test could observe
 * the mutated file. `afterEach` restores again in case an assertion throws
 * between the write and the run.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const CLAUDE_MD = path.join(REPO_ROOT, 'CLAUDE.md');
const ORIGINAL = readFileSync(CLAUDE_MD, 'utf8');

afterEach(() => {
  writeFileSync(CLAUDE_MD, ORIGINAL);
});

function runCheck(): { exitCode: number; output: string } {
  const run = Bun.spawnSync(['bun', 'scripts/check-docs.ts'], { cwd: REPO_ROOT });
  return { exitCode: run.exitCode, output: `${run.stdout.toString()}${run.stderr.toString()}` };
}

// Mutate, run, restore. The restore is in `finally` and not deferred to
// `afterEach` because the mutated file must not survive the one call that reads
// it, whatever the assertions below do.
function withDoc(doc: string): { exitCode: number; output: string } {
  writeFileSync(CLAUDE_MD, doc);
  try {
    return runCheck();
  } finally {
    writeFileSync(CLAUDE_MD, ORIGINAL);
  }
}

// A bullet that is certainly present, so a test removing it is removing
// something rather than matching nothing. Asserted before every use.
const A_REAL_BULLET = /^- `packages\/infra\/deadline`.*$/m;

describe('docs:check derives CLAUDE.md package list from the tree', () => {
  test('the committed tree is green — the baseline every assertion below needs', () => {
    const { exitCode, output } = runCheck();
    expect(output).toMatch(/all \d+ checks passed/);
    expect(exitCode).toBe(0);
  });

  test('deleting a package bullet goes red and names that package', () => {
    // Control: the thing being deleted exists. Without this the test would also
    // pass if the pattern were wrong and nothing had been removed.
    expect(ORIGINAL).toMatch(A_REAL_BULLET);

    const { exitCode, output } = withDoc(ORIGINAL.replace(A_REAL_BULLET, ''));

    expect(output).toContain('package-inventory');
    expect(output).toContain('packages/infra/deadline');
    expect(output).toContain('omits 1 workspace');
    expect(exitCode).toBe(1);
  });

  test('a bullet for a workspace that does not exist goes red and names it', () => {
    const doc = ORIGINAL.replace(
      A_REAL_BULLET,
      (line) => `${line}\n- \`packages/infra/retired-thing\` — deleted two releases ago.`
    );

    const { exitCode, output } = withDoc(doc);

    expect(output).toContain('packages/infra/retired-thing');
    expect(output).toContain('no longer exist');
    expect(exitCode).toBe(1);
  });

  test('a bullet filed under the wrong category heading goes red', () => {
    const doc = ORIGINAL.replace(
      A_REAL_BULLET,
      (line) => `${line}\n- \`packages/clients/providers\` — filed under infra by mistake.`
    );

    const { exitCode, output } = withDoc(doc);

    expect(output).toContain('wrong category heading');
    expect(output).toContain('packages/clients/providers');
    expect(exitCode).toBe(1);
  });

  // The count is OPTIONAL and neither repo carries one. This pair is what makes
  // that safe rather than a trap: re-adding a count is allowed, and a wrong one
  // is caught. Do not "simplify" this by banning the count — a ban is a rule
  // about style, and the reason the number was dropped is that it rots
  // silently, which verification also fixes.
  test('a heading count that disagrees with the tree goes red', () => {
    expect(ORIGINAL).toContain('**Packages:**');

    const { exitCode, output } = withDoc(ORIGINAL.replace('**Packages:**', '**Packages (15):**'));

    expect(output).toContain('heading claims 15 packages');
    expect(exitCode).toBe(1);
  });

  test('a heading count that agrees with the tree is accepted', () => {
    const real = ORIGINAL.match(/^- `packages\/[^/`]+\/[^/`]+`/gm)?.length ?? 0;
    expect(real).toBeGreaterThan(0);

    const { exitCode, output } = withDoc(
      ORIGINAL.replace('**Packages:**', `**Packages (${real}):**`)
    );

    expect(output).toMatch(/all \d+ checks passed/);
    expect(exitCode).toBe(0);
  });

  // KEEP THIS ONE. It is the test a future reader is most likely to delete as
  // redundant, and it is the only one asserting the check cannot go VACUOUS.
  //
  // If the bullet format is ever renamed out from under the pattern, the naive
  // behaviour is to report every workspace as undocumented — a wall of findings
  // that reads as a documentation problem and is a check that stopped working.
  // The blind state has to say so instead, and it must still be non-zero: a
  // check that could not read its input is never a pass.
  test('a reformatted list reports that the check could not read it, not 22 missing packages', () => {
    const doc = ORIGINAL.replace(/^- `packages\/([^/`]+)\/([^/`]+)`/gm, '* packages.$1.$2 —');

    const { exitCode, output } = withDoc(doc);

    expect(output).toContain('cannot read it');
    expect(output).not.toContain('omits');
    expect(exitCode).toBe(1);
  });
});
