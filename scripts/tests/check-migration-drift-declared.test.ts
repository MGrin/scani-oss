/**
 * SC-914. Tests for the guard that refuses an undeclared edit to an applied
 * migration.
 *
 * THE ADDITION ARM IS THE CONTROL AND IS TESTED FIRST-CLASS. A guard that
 * refused every migration touch would be switched off inside a week, and then
 * the ticket closes with nothing protecting anything. Several cases below are
 * a DISCRIMINATING PAIR: the same tag, the same declarations, the same file
 * bytes, differing only in `A` against `M`.
 *
 * NO MIGRATION IN THIS REPOSITORY IS TOUCHED BY THIS FILE. Editing one is the
 * defect under test, and doing it here would need a declaration of its own;
 * DELETING one — the SC-919 arm — would break every deploy and could not be
 * declared away at all. Every must-be-FOUND case is a scratch git repository
 * under the OS temp dir, or a synthetic declaration list handed to a pure
 * function.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { sha256 } from '../../packages/infra/db/src/migration-files.ts';
import {
  DRIFT_DECLARATIONS,
  type DriftDeclaration,
  sqlWithoutComments,
} from '../../packages/infra/db/src/migration-reconciliation.ts';
import {
  type ChangedMigration,
  declarationHolds,
  defaultBase,
  judge,
  MIGRATIONS_DIR,
  parseDiff,
  parseRenames,
  unknown,
  verdict,
} from '../check-migration-drift-declared.ts';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const SCRIPT = path.join(REPO_ROOT, 'scripts/check-migration-drift-declared.ts');

const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

const PROBE_TAG = '20260101000000_zz_probe_sc914';

/** An applied migration with a comment worth rewriting and SQL worth keeping. */
const APPLIED = [
  '-- SC-914 probe. This comment is the thing an edit rewrites.',
  'ALTER TABLE holdings ADD COLUMN probe text;',
  '',
].join('\n');

/** The same executable SQL, a different comment — the whole hazard. */
const COMMENT_EDITED = [
  '-- SC-914 probe. A synthetic example replaces what used to be here.',
  'ALTER TABLE holdings ADD COLUMN probe text;',
  '',
].join('\n');

/** The same comment, different executable SQL. */
const SQL_EDITED = [
  '-- SC-914 probe. This comment is the thing an edit rewrites.',
  'ALTER TABLE holdings ADD COLUMN probe integer;',
  '',
].join('\n');

function commentOnly(tag: string, ranAs: string): DriftDeclaration {
  return {
    kind: 'comment-only',
    tag,
    recorded: sha256(ranAs),
    sqlSha256: sha256(sqlWithoutComments(ranAs)),
    why: 'a synthetic declaration, written by this test',
  };
}

function sqlChanged(tag: string, ranAs: string, becomes: string): DriftDeclaration {
  return {
    kind: 'sql-changed',
    tag,
    recorded: sha256(ranAs),
    becomes: sha256(becomes),
    why: 'a synthetic declaration, written by this test',
  };
}

function changed(status: string, tag: string): ChangedMigration {
  return { status, tag, file: `${MIGRATIONS_DIR}/${tag}.sql` };
}

describe('parseDiff reads the migration files out of a --name-status diff', () => {
  test('it keeps `.sql` files in the folder and drops everything else', () => {
    const diff = [
      `M\t${MIGRATIONS_DIR}/0004_a.sql`,
      `A\t${MIGRATIONS_DIR}/20260101000000_b.sql`,
      `D\t${MIGRATIONS_DIR}/0005_c.sql`,
      // Derived from the folder by `migration-cli.ts journal`; no digest.
      `M\t${MIGRATIONS_DIR}/meta/_journal.json`,
      'M\tpackages/infra/db/src/migration-runner.ts',
      '',
    ].join('\n');
    expect(parseDiff(diff)).toEqual([
      { status: 'M', tag: '0004_a', file: `${MIGRATIONS_DIR}/0004_a.sql` },
      { status: 'A', tag: '20260101000000_b', file: `${MIGRATIONS_DIR}/20260101000000_b.sql` },
      { status: 'D', tag: '0005_c', file: `${MIGRATIONS_DIR}/0005_c.sql` },
    ]);
  });

  test('an empty diff parses to an empty list rather than one blank entry', () => {
    expect(parseDiff('')).toEqual([]);
    expect(parseDiff('\n')).toEqual([]);
  });
});

describe('parseRenames reads the rename-aware diff, which parseDiff cannot', () => {
  test('an R line pairs old tag with new tag', () => {
    const diff = [
      `R100\t${MIGRATIONS_DIR}/0004_a.sql\t${MIGRATIONS_DIR}/0009_b.sql`,
      `M\t${MIGRATIONS_DIR}/0005_c.sql`,
      '',
    ].join('\n');
    expect([...parseRenames(diff)]).toEqual([['0004_a', '0009_b']]);
  });

  /**
   * The reason the rename diff is a SECOND call rather than a flag change on
   * the first. Fed to `parseDiff`, this same line yields the OLD path under
   * status `R` — a status nothing handles, so the deletion silently vanishes.
   */
  test('parseDiff would misread that same line, which is why they are separate', () => {
    const line = `R100\t${MIGRATIONS_DIR}/0004_a.sql\t${MIGRATIONS_DIR}/0009_b.sql`;
    expect(parseDiff(line)).toEqual([
      { status: 'R', tag: '0004_a', file: `${MIGRATIONS_DIR}/0004_a.sql` },
    ]);
  });

  test('a rename OUT of the migrations folder pairs nothing — it is a deletion', () => {
    const diff = `R100\t${MIGRATIONS_DIR}/0004_a.sql\tdocs/0004_a.sql`;
    expect([...parseRenames(diff)]).toEqual([]);
  });

  test('non-rename statuses and empty input pair nothing', () => {
    expect([...parseRenames(`M\t${MIGRATIONS_DIR}/0004_a.sql`)]).toEqual([]);
    expect([...parseRenames('')]).toEqual([]);
  });
});

describe('the rule: EDITING needs a declaration, ADDING never does', () => {
  const sql = new Map([[PROBE_TAG, COMMENT_EDITED]]);

  /**
   * The discriminating pair. Same tag, same bytes, no declaration anywhere —
   * only the status differs, so a guard that fired on both would pass this
   * file's other assertions and still be the wrong guard.
   */
  test('an EDITED migration with no declaration is refused', () => {
    expect(judge([changed('M', PROBE_TAG)], sql, [])).toEqual([
      { kind: 'undeclared', tag: PROBE_TAG },
    ]);
  });

  test('an ADDED migration with no declaration is fine — the control', () => {
    expect(judge([changed('A', PROBE_TAG)], sql, [])).toEqual([]);
  });

  /**
   * SC-919. This case asserted the OPPOSITE until 2026-09-02 — that a `D` is
   * out of scope — and the reasoning it carried was half right: no declaration
   * can cover a removal, so `db:declare-drift` really would be wrong advice.
   * What did not follow is that the guard should therefore say nothing. It has
   * a different remedy, not no remedy.
   */
  test('a DELETED migration is REFUSED, with no declaration consulted', () => {
    expect(judge([changed('D', PROBE_TAG)], sql, [])).toEqual([
      { kind: 'deleted', tag: PROBE_TAG, file: `${MIGRATIONS_DIR}/${PROBE_TAG}.sql` },
    ]);
  });

  test('a declaration naming the deleted tag does not rescue it', () => {
    // The declaration is well formed and covers the file it names. It still
    // cannot help: `planReconciliation` rejects a tag with no file in the tree
    // before any declaration is read, so a pass here would be a lie the reader
    // acts on.
    const findings = judge([changed('D', PROBE_TAG)], sql, [commentOnly(PROBE_TAG, APPLIED)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('deleted');
  });

  test('a rename is reported as a rename, not as an unrelated deletion', () => {
    const renamed = new Map([[PROBE_TAG, '0099_renamed']]);
    expect(
      judge([changed('D', PROBE_TAG), changed('A', '0099_renamed')], sql, [], renamed)
    ).toEqual([
      {
        kind: 'renamed',
        tag: PROBE_TAG,
        file: `${MIGRATIONS_DIR}/${PROBE_TAG}.sql`,
        toTag: '0099_renamed',
      },
    ]);
  });

  test('an unpaired deletion degrades to `deleted`, and is still a finding', () => {
    // The rename diff failing must not be able to turn a refusal into a pass.
    expect(judge([changed('D', PROBE_TAG)], sql, [], new Map())).toEqual([
      { kind: 'deleted', tag: PROBE_TAG, file: `${MIGRATIONS_DIR}/${PROBE_TAG}.sql` },
    ]);
  });

  test('an edit covered by a comment-only declaration passes', () => {
    expect(judge([changed('M', PROBE_TAG)], sql, [commentOnly(PROBE_TAG, APPLIED)])).toEqual([]);
  });

  test('a declaration for a DIFFERENT tag does not cover this one', () => {
    expect(
      judge([changed('M', PROBE_TAG)], sql, [commentOnly('0004_something_else', APPLIED)])
    ).toEqual([{ kind: 'undeclared', tag: PROBE_TAG }]);
  });

  test('a tag whose file could not be read is left to the caller, not judged', () => {
    // The caller reports that as UNKNOWN. Judging it here would turn a read
    // failure into a claim about the tree.
    expect(judge([changed('M', PROBE_TAG)], new Map(), [])).toEqual([]);
  });
});

describe('a declaration is judged on its contents, not only on its tag', () => {
  test('comment-only holds when the executable SQL did not move', () => {
    expect(declarationHolds(commentOnly(PROBE_TAG, APPLIED), COMMENT_EDITED)).toBeNull();
  });

  test('comment-only refuses when the executable SQL DID move', () => {
    const why = declarationHolds(commentOnly(PROBE_TAG, APPLIED), SQL_EDITED);
    expect(why).toBeString();
    expect(why as string).toContain('executable SQL');
  });

  test('a comment-only declaration that lies is a refusal, not a pass', () => {
    const sql = new Map([[PROBE_TAG, SQL_EDITED]]);
    const findings = judge([changed('M', PROBE_TAG)], sql, [commentOnly(PROBE_TAG, APPLIED)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('stale');
  });

  test('sql-changed holds only for the exact file it was written against', () => {
    const declaration = sqlChanged(PROBE_TAG, APPLIED, SQL_EDITED);
    expect(declarationHolds(declaration, SQL_EDITED)).toBeNull();
    const why = declarationHolds(declaration, COMMENT_EDITED);
    expect(why).toBeString();
    expect(why as string).toContain('edited again since');
  });

  test('the newer of two declarations for one tag is enough — one holding is enough', () => {
    const sql = new Map([[PROBE_TAG, SQL_EDITED]]);
    const declarations = [
      commentOnly(PROBE_TAG, APPLIED),
      sqlChanged(PROBE_TAG, APPLIED, SQL_EDITED),
    ];
    expect(judge([changed('M', PROBE_TAG)], sql, declarations)).toEqual([]);
  });
});

describe('the verdict line carries what the reader needs and nothing it cannot claim', () => {
  const base = { base: 'origin/main', baseSha: 'a'.repeat(40), baseIsHead: false };

  test('a clean run prints the denominator, so an empty run cannot look full', () => {
    const line = verdict({ ...base, changed: [changed('A', PROBE_TAG)], findings: [] }).lines[0];
    expect(line).toContain('clean');
    expect(line).toContain('1 migration file(s) changed');
    expect(line).toContain('0 edited, 1 added, 0 deleted');
  });

  test('a base that IS this tree says so rather than printing a bare zero', () => {
    const line = verdict({ ...base, baseIsHead: true, changed: [], findings: [] }).lines[0];
    expect(line).toContain('IS this tree, so there is no branch to judge');
  });

  test('a refusal names every tag and the exact command that fixes it', () => {
    const judgement = verdict({
      ...base,
      changed: [changed('M', PROBE_TAG), changed('M', '0004_other')],
      findings: [
        { kind: 'undeclared', tag: PROBE_TAG },
        { kind: 'stale', tag: '0004_other', why: 'because' },
      ],
    });
    expect(judgement.exit).toBe(1);
    expect(judgement.lines[0]).toContain(PROBE_TAG);
    expect(judgement.lines[0]).toContain('0004_other');
    const body = judgement.lines.join('\n');
    expect(body).toContain(`bun run db:declare-drift ${PROBE_TAG}`);
    expect(body).toContain('bun run db:declare-drift 0004_other');
  });

  test('blindness is exit 9 and says nothing was compared', () => {
    const judgement = unknown('git fell over');
    expect(judgement.exit).toBe(9);
    expect(judgement.lines.join('\n')).toContain('This is not a pass.');
  });

  /**
   * SC-919. THE POINT OF THE WHOLE TICKET IS THE ABSENCE HERE. `db:declare-drift`
   * is the remedy for an edit and cannot fix a removal — there is no file to
   * hash — so printing it would send the reader down a path that dead-ends
   * while deploys are refusing. This asserts it is NOT printed, which no
   * assertion about what IS printed can cover.
   */
  test('a removal is refused WITHOUT ever prescribing db:declare-drift', () => {
    const judgement = verdict({
      ...base,
      changed: [changed('D', PROBE_TAG)],
      findings: [{ kind: 'deleted', tag: PROBE_TAG, file: `${MIGRATIONS_DIR}/${PROBE_TAG}.sql` }],
    });
    expect(judgement.exit).toBe(1);
    expect(judgement.lines[0]).toContain('1 applied migration(s) deleted or renamed');
    expect(judgement.lines[0]).toContain(PROBE_TAG);
    const body = judgement.lines.join('\n');
    // It NAMES the command in order to rule it out — that is the point. What
    // it must never do is PRESCRIBE one, which is what the reader would run.
    expect(body).not.toContain('bun run db:declare-drift');
    expect(body).toContain('`db:declare-drift` is NOT the remedy here');
    expect(body).toContain('cannot be deleted or renamed');
    expect(body).toContain(`git checkout ${base.baseSha} -- ${MIGRATIONS_DIR}/${PROBE_TAG}.sql`);
  });

  test('a rename says what it became, and what to do with the new file', () => {
    const body = verdict({
      ...base,
      changed: [changed('D', PROBE_TAG), changed('A', '0099_renamed')],
      findings: [
        {
          kind: 'renamed',
          tag: PROBE_TAG,
          file: `${MIGRATIONS_DIR}/${PROBE_TAG}.sql`,
          toTag: '0099_renamed',
        },
      ],
    }).lines.join('\n');
    expect(body).toContain(`${PROBE_TAG} — renamed to 0099_renamed`);
    expect(body).toContain('genuinely wanted as a NEW migration');
    expect(body).not.toContain('bun run db:declare-drift');
  });

  /**
   * A branch can do both, and the two remedies must not be blended. The edit
   * section keeps its command; the removal section still must not acquire one.
   */
  test('an edit and a removal on one branch get their own sections', () => {
    const judgement = verdict({
      ...base,
      changed: [changed('M', '0004_other'), changed('D', PROBE_TAG)],
      findings: [
        { kind: 'undeclared', tag: '0004_other' },
        { kind: 'deleted', tag: PROBE_TAG, file: `${MIGRATIONS_DIR}/${PROBE_TAG}.sql` },
      ],
    });
    expect(judgement.lines[0]).toContain('1 edited migration(s) no drift declaration covers');
    expect(judgement.lines[0]).toContain('1 applied migration(s) deleted or renamed');
    const body = judgement.lines.join('\n');
    expect(body).toContain('bun run db:declare-drift 0004_other');
    expect(body).not.toContain(`bun run db:declare-drift ${PROBE_TAG}`);
  });

  test('an unavailable rename pairing is printed, not assumed away', () => {
    const body = verdict({
      ...base,
      changed: [changed('D', PROBE_TAG)],
      findings: [{ kind: 'deleted', tag: PROBE_TAG, file: `${MIGRATIONS_DIR}/${PROBE_TAG}.sql` }],
      renamePairingUnavailable: 'git diff exited 128',
    }).lines.join('\n');
    expect(body).toContain('Renames could not be paired (git diff exited 128)');
  });

  test('the denominator counts deletions rather than calling them out of scope', () => {
    const line = verdict({
      ...base,
      changed: [changed('D', PROBE_TAG)],
      findings: [{ kind: 'deleted', tag: PROBE_TAG, file: `${MIGRATIONS_DIR}/${PROBE_TAG}.sql` }],
    }).lines[0];
    expect(line).toContain('0 edited, 0 added, 1 deleted');
    expect(line).not.toContain('out of scope');
  });
});

describe('the base is resolved from the event, and never guessed', () => {
  test('a pull request compares against its own base branch', () => {
    expect(defaultBase({ GITHUB_BASE_REF: 'release-1.2' })).toBe('origin/release-1.2');
  });

  test('everything else compares against origin/main', () => {
    expect(defaultBase({})).toBe('origin/main');
    expect(defaultBase({ GITHUB_BASE_REF: '' })).toBe('origin/main');
  });
});

// ---------------------------------------------------------------------------
// End to end, against real git.
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): void {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr}`);
}

function write(dir: string, file: string, body: string): void {
  const target = path.join(dir, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body);
}

/** A repository whose `main` carries one applied migration. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'migration-drift-'));
  scratches.push(dir);
  // Pinned rather than inherited: a runner whose `init.defaultBranch` is
  // `master` leaves `main` unborn and the failure names the wrong thing.
  git(dir, 'init', '--quiet', '--initial-branch=main');
  write(dir, `${MIGRATIONS_DIR}/${PROBE_TAG}.sql`, APPLIED);
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'applied');
  git(dir, 'checkout', '--quiet', '-b', 'work');
  return dir;
}

interface Run {
  status: number | null;
  out: string;
}

function runGuard(repo: string, ...args: string[]): Run {
  // `process.execPath` rather than the string 'bun': a PATH without bun would
  // report the guard's absence as the guard's verdict.
  const run = spawnSync(process.execPath, [SCRIPT, '--repo', repo, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

describe('end to end, against a real repository', () => {
  test('editing an applied migration is REFUSED and the tag is named', () => {
    const repo = makeRepo();
    write(repo, `${MIGRATIONS_DIR}/${PROBE_TAG}.sql`, COMMENT_EDITED);
    const run = runGuard(repo, '--base', 'main');
    expect(run.status).toBe(1);
    expect(run.out).toContain('REFUSED');
    expect(run.out).toContain(PROBE_TAG);
    expect(run.out).toContain(`bun run db:declare-drift ${PROBE_TAG}`);
  });

  test('an uncommitted edit is refused too — the working tree is compared', () => {
    const repo = makeRepo();
    write(repo, `${MIGRATIONS_DIR}/${PROBE_TAG}.sql`, COMMENT_EDITED);
    // Deliberately NOT committed.
    expect(runGuard(repo, '--base', 'main').status).toBe(1);
  });

  test('ADDING a migration is clean — the control, end to end', () => {
    const repo = makeRepo();
    write(repo, `${MIGRATIONS_DIR}/20260202000000_zz_added_sc914.sql`, APPLIED);
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'add');
    const run = runGuard(repo, '--base', 'main');
    expect(run.status).toBe(0);
    expect(run.out).toContain('clean');
    expect(run.out).toContain('0 edited, 1 added');
  });

  test('a branch that touches no migration is clean, with a zero denominator', () => {
    const repo = makeRepo();
    write(repo, 'README.md', 'nothing to do with migrations\n');
    git(repo, 'add', '-A');
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'readme');
    const run = runGuard(repo, '--base', 'main');
    expect(run.status).toBe(0);
    expect(run.out).toContain('0 migration file(s) changed');
  });

  test('a base that cannot be resolved is exit 9, never a pass', () => {
    const repo = makeRepo();
    write(repo, `${MIGRATIONS_DIR}/${PROBE_TAG}.sql`, COMMENT_EDITED);
    const run = runGuard(repo, '--base', 'no-such-ref-sc914');
    expect(run.status).toBe(9);
    expect(run.out).toContain('This is not a pass.');
  });

  /**
   * SC-919, END TO END. The falsifier the ticket names, run against a scratch
   * repository rather than this one: `git rm` an applied migration and the
   * guard must refuse. Exit 0 here means the ticket is open again.
   *
   * The `A` control two cases above is what keeps this from being satisfied by
   * a guard that simply refuses everything.
   */
  test('DELETING an applied migration is REFUSED, and never told to declare drift', () => {
    const repo = makeRepo();
    git(repo, 'rm', '--quiet', `${MIGRATIONS_DIR}/${PROBE_TAG}.sql`);
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'delete');
    const run = runGuard(repo, '--base', 'main');
    expect(run.status).toBe(1);
    expect(run.out).toContain('REFUSED');
    expect(run.out).toContain('applied migration(s) deleted or renamed');
    expect(run.out).toContain(PROBE_TAG);
    expect(run.out).toContain('cannot be deleted or renamed');
    expect(run.out).toContain('`db:declare-drift` is NOT the remedy here');
    expect(run.out).not.toContain('bun run db:declare-drift');
  });

  test('an UNCOMMITTED deletion is refused too — the working tree is compared', () => {
    const repo = makeRepo();
    rmSync(path.join(repo, MIGRATIONS_DIR, `${PROBE_TAG}.sql`));
    const run = runGuard(repo, '--base', 'main');
    expect(run.status).toBe(1);
    expect(run.out).toContain('applied migration(s) deleted or renamed');
  });

  /**
   * The shape the ticket is really about. Under `--no-renames` this arrives as
   * `D` + `A`, and `A` is the exempt arm — so before SC-919 the most dangerous
   * change was the one that looked cleanest. The message has to name the NEW
   * tag, or the reader is told to restore a file they can see is still there
   * under another name.
   */
  test('RENAMING an applied migration is refused AS A RENAME, naming both tags', () => {
    const repo = makeRepo();
    const renamed = '20260303000000_zz_renamed_sc919';
    git(repo, 'mv', `${MIGRATIONS_DIR}/${PROBE_TAG}.sql`, `${MIGRATIONS_DIR}/${renamed}.sql`);
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'rename');
    const run = runGuard(repo, '--base', 'main');
    expect(run.status).toBe(1);
    expect(run.out).toContain(`${PROBE_TAG} — renamed to ${renamed}`);
    expect(run.out).toContain('genuinely wanted as a NEW migration');
    expect(run.out).not.toContain('bun run db:declare-drift');
    // The denominator still counts what the primary diff saw: one gone, one new.
    expect(run.out).toContain('0 edited, 1 added, 1 deleted');
  });

  /**
   * The discriminating pair, end to end and one command apart: delete refuses,
   * add passes, same repository, same guard, same invocation.
   */
  test('the pair: a deletion refuses where an addition of the same shape passes', () => {
    const deleting = makeRepo();
    git(deleting, 'rm', '--quiet', `${MIGRATIONS_DIR}/${PROBE_TAG}.sql`);
    const refused = runGuard(deleting, '--base', 'main');

    const adding = makeRepo();
    write(adding, `${MIGRATIONS_DIR}/20260404000000_zz_added_sc919.sql`, APPLIED);
    git(adding, 'add', '-A');
    const clean = runGuard(adding, '--base', 'main');

    expect([refused.status, clean.status]).toEqual([1, 0]);
    expect(clean.out).toContain('clean');
  });
});

/**
 * THE CHECK EXISTS IN BOTH PLACES, OR IT EXISTS IN NEITHER THAT MATTERS. The
 * hook is a seatbelt — bypassable with `--no-verify`, absent from a fresh
 * clone until `bun install` sets `core.hooksPath` — and a hurried merge skips
 * exactly it. These assertions are what stops the wiring being quietly
 * unpicked while the script and its tests stay green.
 */
describe('the guard is wired where it has to run', () => {
  const read = (p: string): string => readFileSync(path.join(REPO_ROOT, p), 'utf8');

  test('the package script exists, so every caller names one thing', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts['db:drift:check']).toContain('check-migration-drift-declared.ts');
  });

  test('CI runs it, on a checkout deep enough to resolve the base', () => {
    const workflow = Bun.YAML.parse(read('.github/workflows/ci.yml')) as {
      jobs?: Record<string, { steps?: Array<{ run?: string; with?: { 'fetch-depth'?: number } }> }>;
    };
    const job = workflow.jobs?.['validate-migrations'];
    expect(job).toBeDefined();
    const steps = job?.steps ?? [];
    expect(steps.some((s) => (s.run ?? '').includes('db:drift:check'))).toBe(true);
    // A depth-1 checkout has no `origin/main` and no merge base, so the check
    // would exit 9 on every run — loud, but permanently.
    expect(steps.some((s) => s.with?.['fetch-depth'] === 0)).toBe(true);
  });

  test('pre-commit runs it and REFUSES on any non-zero status', () => {
    const hook = read('.githooks/pre-commit');
    expect(hook).toContain('check-migration-drift-declared.ts');
    // `|| true` here would swallow exit 9 as well as exit 1 — the shape
    // `check-oss-prose.ts` uses deliberately and this must not.
    expect(hook).not.toContain('bun scripts/check-migration-drift-declared.ts || true');
    expect(hook).toContain('fail "an applied migration is edited, deleted or renamed');
  });

  /**
   * SC-919. THE TRIGGER HAD TO CHANGE TOO, AND THAT IS THE HALF NOTHING WOULD
   * HAVE CAUGHT. `staged_files` is `--diff-filter=ACMR` — deletions excluded by
   * design — so a commit that ONLY deletes a migration matched no path, the
   * guard never ran, and a correct refusal it would have printed was never
   * reached. A green script beside a trigger that cannot fire is exactly the
   * shape `scripts/lib/check-verdict.ts` is about.
   */
  test('pre-commit triggers on a DELETED migration, which staged_files excludes', () => {
    const hook = read('.githooks/pre-commit');
    expect(hook).toContain("--diff-filter=D -- 'packages/infra/db/src/migrations/*.sql'");
    expect(hook).toContain('[ -n "$migration_deleted" ]');
  });
});

/**
 * THE REAL DECLARATIONS, AGAINST THE REAL FILES. Every case above judges
 * synthetic declarations, so a green suite would survive a `DRIFT_DECLARATIONS`
 * list that covers nothing in this tree — and the guard would then refuse the
 * next legitimate branch for a reason nobody could act on.
 *
 * It is deliberately NOT derived from git history. A shallow clone has no
 * commit that modified a migration, so a history-derived population reads as
 * zero on exactly the checkout that cannot tell you so.
 */
describe('every declaration in this tree covers the file it names', () => {
  test('the population is not empty — the control', () => {
    expect(DRIFT_DECLARATIONS.length).toBeGreaterThan(0);
  });

  test('each declared tag has a migration file, and the declaration holds against it', () => {
    const offences: string[] = [];
    for (const declaration of DRIFT_DECLARATIONS) {
      const file = path.join(REPO_ROOT, MIGRATIONS_DIR, `${declaration.tag}.sql`);
      let sql: string;
      try {
        sql = readFileSync(file, 'utf8');
      } catch {
        offences.push(`${declaration.tag}: no such migration in this tree`);
        continue;
      }
      const why = declarationHolds(declaration, sql);
      if (why !== null) offences.push(`${declaration.tag}: ${why}`);
    }
    expect(offences).toEqual([]);
  });
});
