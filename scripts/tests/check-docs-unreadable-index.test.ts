import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCheckDocs } from '../lib/run-check-docs';

/**
 * COULD NOT READ THE TREE IS NOT AN EMPTY TREE (SC-1234).
 *
 * `git ls-files` against an index file that does not exist exits 0 with no
 * output and no stderr. `check-docs.ts` took that as a tree with no files and
 * reported 43 inventory errors in 241ms — every router and package "missing",
 * none of them naming the cause.
 *
 * Both arms are needed. A missing index must refuse and say so; an index that
 * EXISTS and is empty is a real empty tree, which the scratch-index tests may
 * build on purpose, and must still be checked rather than refused.
 */
setDefaultTimeout(30_000);

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const dir = mkdtempSync(path.join(tmpdir(), 'check-docs-index-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function withIndex(index: string) {
  return runCheckDocs(REPO_ROOT, { env: { ...process.env, GIT_INDEX_FILE: index } });
}

describe('docs:check tells an unreadable tree from an empty one (SC-1234)', () => {
  test('a MISSING index -> COULD NOT READ, exit 2, naming the path and no invented finding', () => {
    const missing = path.join(dir, 'never-written');
    expect(existsSync(missing)).toBe(false);
    const { exitCode, output } = withIndex(missing);
    expect(output).toContain('COULD NOT READ the tree');
    expect(output).toContain(`MISSING: ${missing}`);
    expect(output).not.toContain('do not exist in source');
    expect(exitCode).toBe(2);
  });

  test('an EMPTY index that exists is a real empty tree: checked, never refused', () => {
    const empty = path.join(dir, 'empty');
    const made = Bun.spawnSync(['git', 'read-tree', '--empty'], {
      cwd: REPO_ROOT,
      env: { ...process.env, GIT_INDEX_FILE: empty },
    });
    expect(made.success).toBe(true);
    expect(existsSync(empty)).toBe(true);

    const { exitCode, output } = withIndex(empty);
    expect(output).not.toContain('COULD NOT READ');
    // 1 is "checked and found": the docs name files an empty tree does not
    // hold. 2 would be the refusal, which this tree must never get.
    expect(exitCode).toBe(1);
  });

  test('CONTROL: the real index is read as it always was', () => {
    const { exitCode, output } = runCheckDocs(REPO_ROOT);
    expect(output).not.toContain('COULD NOT READ');
    expect(exitCode).toBe(0);
  });
});
