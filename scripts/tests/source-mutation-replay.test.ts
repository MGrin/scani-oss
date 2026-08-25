import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MUTATION_JOURNAL_GLOB,
  replayStrandedMutations,
  strandedMutationJournals,
  withMutatedSources,
} from '../lib/test-source-mutations';

/**
 * SC-601. Three tests under `scripts/tests/` rewrite TRACKED SOURCE and restore
 * it in a `finally`, which `SIGKILL` skips — leaving a legitimate filename with
 * the wrong contents, committable by `git add -A` and findable by no glob.
 *
 * The repair is only worth anything on the crash path, so that is what is
 * tested here: a real child process is killed with SIGKILL between the mutation
 * and the restore, the file is asserted to be left mutated, and the next
 * replay is asserted to put it back. A fix for a crash path exercised only on
 * the happy path has not been tested.
 *
 * Everything except the two guard tests at the bottom runs in a scratch tree
 * under TMPDIR — this file must not strand in the repository the artefact it
 * exists to remove.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');

const scratches: string[] = [];
function scratchRepo(body = 'const DOCS_APP = "apps/frontend/docs";\n'): {
  root: string;
  file: string;
  rel: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'sc601-'));
  scratches.push(root);
  const rel = 'src/thing.ts';
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  return { root, file, rel };
}

afterAll(() => {
  for (const root of scratches) rmSync(root, { recursive: true, force: true });
});

describe('a killed run leaves a journal, and the next run replays it', () => {
  test('CRASH PATH — SIGKILL strands the mutation; the next replay undoes it', async () => {
    const { root, file, rel } = scratchRepo('const DOCS_APP = "apps/frontend/docs";\n');
    const original = readFileSync(file, 'utf8');
    const mutated = original.replace('apps/frontend/docs', 'apps/frontend/docs-moved-away');
    const ready = path.join(root, 'ready');

    const driver = path.join(root, 'driver.ts');
    writeFileSync(
      driver,
      `import { withMutatedSources } from ${JSON.stringify(
        path.join(REPO_ROOT, 'scripts/lib/test-source-mutations.ts')
      )};\n` +
        `import { writeFileSync } from 'node:fs';\n` +
        `withMutatedSources(${JSON.stringify(root)}, { ${JSON.stringify(rel)}: ${JSON.stringify(
          mutated
        )} }, () => {\n` +
        `  writeFileSync(${JSON.stringify(ready)}, 'x');\n` +
        `  Bun.sleepSync(60_000);\n` +
        `});\n`
    );

    const child = Bun.spawn(['bun', driver], { cwd: root, stdout: 'pipe', stderr: 'pipe' });
    const deadline = Date.now() + 30_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(25);
    expect(existsSync(ready)).toBe(true);

    child.kill(9);
    await child.exited;

    // The bug, reproduced: `finally` did not run, so a TRACKED file is left
    // rewritten on disk. Asserted rather than assumed — without it the test
    // would also pass if the child had exited cleanly and restored the file,
    // and the replay below would then be proving nothing.
    expect(readFileSync(file, 'utf8')).toBe(mutated);
    expect(strandedMutationJournals(root)).toHaveLength(1);

    const restored = replayStrandedMutations(root);

    expect(restored).toEqual([rel]);
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(strandedMutationJournals(root)).toEqual([]);
  }, 60_000);

  test('the replay restores UNCOMMITTED bytes, which `git checkout --` would discard', () => {
    // The reason this is a journal and not a `git checkout`: what a killed run
    // destroyed is whatever was on disk, which may be work in progress.
    const { root, file, rel } = scratchRepo('committed\n');
    const uncommitted = 'committed\nplus an edit nobody has committed\n';
    writeFileSync(file, uncommitted);

    const journal = path.join(root, 'scripts/.source-mutation-journal-999.json');
    mkdirSync(path.dirname(journal), { recursive: true });
    writeFileSync(journal, JSON.stringify({ pid: 999, files: { [rel]: uncommitted } }));
    writeFileSync(file, 'what the test mutated it to\n');

    expect(replayStrandedMutations(root)).toEqual([rel]);
    expect(readFileSync(file, 'utf8')).toBe(uncommitted);
  });

  test('a file the killed run had DELETED is restored, not skipped', () => {
    // The journal is the pre-mutation state, so "not there" is a difference
    // from it like any other. This pins the branch that reads ENOENT as a
    // missing file rather than as nothing to do.
    const { root, file, rel } = scratchRepo('the original\n');
    const journal = path.join(root, 'scripts/.source-mutation-journal-888.json');
    mkdirSync(path.dirname(journal), { recursive: true });
    writeFileSync(journal, JSON.stringify({ pid: 888, files: { [rel]: 'the original\n' } }));
    rmSync(file, { force: true });
    expect(existsSync(file)).toBe(false);

    expect(replayStrandedMutations(root)).toEqual([rel]);
    expect(readFileSync(file, 'utf8')).toBe('the original\n');
  });

  test('MUST-BE-ABSENT CONTROL — a clean tree restores nothing and is not rewritten', () => {
    const { root, file } = scratchRepo();
    const before = readFileSync(file, 'utf8');

    expect(replayStrandedMutations(root)).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('the happy path restores and leaves no journal behind', () => {
    const { root, file, rel } = scratchRepo();
    const original = readFileSync(file, 'utf8');

    const seen = withMutatedSources(root, { [rel]: 'mutated\n' }, () => readFileSync(file, 'utf8'));

    expect(seen).toBe('mutated\n');
    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(strandedMutationJournals(root)).toEqual([]);
  });

  test('a throw inside the run still restores, and still clears the journal', () => {
    const { root, file, rel } = scratchRepo();
    const original = readFileSync(file, 'utf8');

    expect(() =>
      withMutatedSources(root, { [rel]: 'mutated\n' }, () => {
        throw new Error('the assertion failed');
      })
    ).toThrow('the assertion failed');

    expect(readFileSync(file, 'utf8')).toBe(original);
    expect(strandedMutationJournals(root)).toEqual([]);
  });

  test('an unreadable journal FAILS — it is never read as "nothing to repair"', () => {
    // A journal that cannot be parsed means tracked files are stranded and
    // nothing left knows which. Deleting it quietly would leave a damaged tree
    // that reads as clean, which is the failure this whole file is about.
    const { root } = scratchRepo();
    const journal = path.join(root, 'scripts/.source-mutation-journal-777.json');
    mkdirSync(path.dirname(journal), { recursive: true });
    writeFileSync(journal, '{"pid": 777, "files": {"src/thi');

    expect(() => replayStrandedMutations(root)).toThrow(/unreadable/);
  });
});

describe('the journal cannot itself become the artefact it removes', () => {
  test('git ignores the journal — and does not ignore ordinary source', () => {
    const ignored = Bun.spawnSync(
      ['git', 'check-ignore', '-q', 'scripts/.source-mutation-journal-1234.json'],
      { cwd: REPO_ROOT }
    );
    expect(ignored.exitCode).toBe(0);

    // MUST-BE-ABSENT CONTROL. A `.gitignore` line broad enough to swallow the
    // repository would pass the assertion above for the wrong reason.
    const notIgnored = Bun.spawnSync(['git', 'check-ignore', '-q', 'scripts/check-docs.ts'], {
      cwd: REPO_ROOT,
    });
    expect(notIgnored.exitCode).toBe(1);
  });

  test('the pre-commit guard refuses a commit while a journal exists', () => {
    const guard = () =>
      Bun.spawnSync(['bun', 'scripts/check-staged-test-fixtures.ts'], { cwd: REPO_ROOT });

    // Baseline: the tree is clean, so a refusal below is caused by what this
    // test writes rather than by whatever it inherited.
    expect(guard().exitCode).toBe(0);

    // An EMPTY file map on purpose: a journal naming real paths would have this
    // test's `--sweep` rewrite real source with content it invented.
    const journal = path.join(REPO_ROOT, `scripts/.source-mutation-journal-sc601probe.json`);
    writeFileSync(journal, JSON.stringify({ pid: 0, files: {} }));
    try {
      const refused = guard();
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr.toString()).toContain('left tracked source files rewritten');
      expect(refused.stderr.toString()).toContain(path.basename(journal));
    } finally {
      rmSync(journal, { force: true });
    }

    expect(guard().exitCode).toBe(0);
  });

  test('the glob the guard and the sweep share is the one .gitignore covers', () => {
    expect(MUTATION_JOURNAL_GLOB).toBe('scripts/.source-mutation-journal-*.json');
    expect(readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')).toContain(
      MUTATION_JOURNAL_GLOB
    );
  });
});
