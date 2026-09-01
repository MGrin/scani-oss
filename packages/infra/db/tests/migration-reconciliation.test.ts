import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../src/migration-files';
import {
  DRIFT_DECLARATIONS,
  type DriftDeclaration,
  planReconciliation,
  sqlWithoutComments,
} from '../src/migration-reconciliation';

/**
 * The safety property is one sentence — a recorded digest may be re-recorded
 * only when the migration's NON-COMMENT SQL is unchanged — and every test here
 * is about a way that sentence can be got wrong.
 *
 * The dangerous direction is a stripper that removes too much: two files with
 * genuinely different SQL that compare equal reconcile a real schema change
 * silently. Removing too little only refuses a legitimate comment edit, which
 * is loud. So the string, identifier and dollar-quote cases below assert what
 * SURVIVES, not what goes.
 */
const MIGRATIONS = path.join(import.meta.dir, '..', 'src', 'migrations');

describe('sqlWithoutComments', () => {
  test('drops line comments and collapses the whitespace they leave', () => {
    const before = '-- one\n-- two\n-- three\nSELECT 1;\n';
    const after = '-- a shorter note\nSELECT 1;\n';
    expect(sqlWithoutComments(before)).toBe('SELECT 1;');
    expect(sqlWithoutComments(after)).toBe(sqlWithoutComments(before));
  });

  test('drops a comment that trails real SQL on the same line', () => {
    expect(sqlWithoutComments('SELECT 1; -- why\nSELECT 2;')).toBe('SELECT 1; SELECT 2;');
  });

  test('drops nested block comments', () => {
    expect(sqlWithoutComments('SELECT /* a /* b */ c */ 1;')).toBe('SELECT 1;');
  });

  test('keeps the statement breakpoint, which splits the run', () => {
    // Not cosmetic: three migrations here carry their own COMMIT, so where the
    // statements divide decides what is in which transaction.
    const one = 'SELECT 1;\nSELECT 2;';
    const two = 'SELECT 1;\n--> statement-breakpoint\nSELECT 2;';
    expect(sqlWithoutComments(two)).toContain('--> statement-breakpoint');
    expect(sqlWithoutComments(one)).not.toBe(sqlWithoutComments(two));
  });

  test('a `--` inside a string literal is data, not a comment', () => {
    const kept = "INSERT INTO t VALUES ('a -- b', 1);";
    expect(sqlWithoutComments(kept)).toBe(kept);
    // The failure this guards: swallowing the rest of the line would hide the
    // difference between these two.
    expect(sqlWithoutComments(kept)).not.toBe(
      sqlWithoutComments("INSERT INTO t VALUES ('a -- b', 2);")
    );
  });

  test('a doubled quote does not end the literal', () => {
    const sql = "SELECT 'it''s -- fine', 1;";
    expect(sqlWithoutComments(sql)).toBe(sql);
  });

  test('an E-string escapes its closing quote with a backslash', () => {
    const sql = "SELECT E'a\\' -- still inside', 1;";
    expect(sqlWithoutComments(sql)).toBe(sql);
  });

  test('a `--` inside a quoted identifier survives', () => {
    const sql = 'SELECT "od -- d" FROM t;';
    expect(sqlWithoutComments(sql)).toBe(sql);
  });

  test('whitespace inside a literal is not collapsed', () => {
    expect(sqlWithoutComments("SELECT   'a   b';")).toBe("SELECT 'a   b';");
  });

  test('a dollar-quoted VALUE is data — its `--` is two characters', () => {
    const sql = 'INSERT INTO t VALUES ($tag$note -- here$tag$);';
    expect(sqlWithoutComments(sql)).toBe(sql);
  });

  test('a `DO $$ … $$` body is CODE, so comments inside it are comments', () => {
    const before =
      'DO $$\nBEGIN\n  -- ten of these were on Polygon\n  RAISE NOTICE $$x$$;\nEND $$;';
    const after =
      'DO $$\nBEGIN\n  -- a cluster of these were on Polygon\n  RAISE NOTICE $$x$$;\nEND $$;';
    expect(sqlWithoutComments(before)).toBe(sqlWithoutComments(after));
    // …and a real change inside the same body is still a change.
    expect(sqlWithoutComments(before)).not.toBe(
      sqlWithoutComments(before.replace('RAISE NOTICE', 'RAISE EXCEPTION'))
    );
  });

  test('`$1` is a parameter, not a dollar quote', () => {
    expect(sqlWithoutComments('SELECT $1, $2; -- x')).toBe('SELECT $1, $2;');
  });

  test('every migration in the tree parses to non-empty SQL', () => {
    // A stripper that silently ate a whole file would make every comparison
    // trivially equal, which is the worst failure available to it.
    const names = readdirSync(MIGRATIONS).filter((name) => name.endsWith('.sql'));
    expect(names.length).toBeGreaterThan(50);
    for (const name of names) {
      const stripped = sqlWithoutComments(readFileSync(path.join(MIGRATIONS, name), 'utf8'));
      expect({ name, empty: stripped.length === 0 }).toEqual({ name, empty: false });
      // A leaked comment looks like this and nothing else does: whitespace
      // outside literals is collapsed, so a newline followed by `--` can only
      // have come from a comment the parser walked past. A multi-line
      // dollar-quoted VALUE may legitimately carry newlines, which is why the
      // shape rather than the newline is what is asserted.
      expect({ name, leaked: /\n\s*--/.test(stripped) }).toEqual({ name, leaked: false });
    }
  });
});

const drift = (tag: string, recorded: string, found: string) => ({ tag, recorded, found });

describe('planReconciliation', () => {
  const declaration: DriftDeclaration = {
    kind: 'comment-only',
    tag: 'm',
    recorded: 'old-digest',
    sqlSha256: sha256('SELECT 1;'),
    why: 'test',
  };
  const sqlByTag = new Map([['m', 'SELECT 1;']]);

  test('reconciles when the recorded digest and the file’s SQL both match', () => {
    const plan = planReconciliation([drift('m', 'old-digest', 'new-digest')], sqlByTag, [
      declaration,
    ]);
    expect(plan.reconcile).toEqual([
      { tag: 'm', from: 'old-digest', to: 'new-digest', declaration },
    ]);
    expect(plan.refuse).toEqual([]);
  });

  test('a declaration for a different recorded digest is inert', () => {
    const plan = planReconciliation([drift('m', 'some-other-digest', 'new-digest')], sqlByTag, [
      declaration,
    ]);
    expect(plan.reconcile).toEqual([]);
    expect(plan.refuse).toHaveLength(1);
    // Inert, not rejected: it never described this database at all.
    expect(plan.rejected).toEqual([]);
  });

  test('refuses — and says why — when the file’s SQL is not the declared SQL', () => {
    const plan = planReconciliation(
      [drift('m', 'old-digest', 'new-digest')],
      new Map([['m', 'SELECT 2;']]),
      [declaration]
    );
    expect(plan.reconcile).toEqual([]);
    expect(plan.refuse).toHaveLength(1);
    expect(plan.rejected[0]?.because).toContain('SQL change, not a comment edit');
  });

  test('drift with no declaration is refused, untouched', () => {
    const plan = planReconciliation([drift('other', 'old-digest', 'new')], sqlByTag, [declaration]);
    expect(plan.refuse).toEqual([drift('other', 'old-digest', 'new')]);
  });

  test('a sql-changed declaration stops applying once the file moves again', () => {
    const override: DriftDeclaration = {
      kind: 'sql-changed',
      tag: 'm',
      recorded: 'old-digest',
      becomes: 'reviewed-digest',
      why: 'test',
    };
    expect(
      planReconciliation([drift('m', 'old-digest', 'reviewed-digest')], sqlByTag, [override])
        .reconcile
    ).toHaveLength(1);

    const moved = planReconciliation([drift('m', 'old-digest', 'a-later-digest')], sqlByTag, [
      override,
    ]);
    expect(moved.reconcile).toEqual([]);
    expect(moved.rejected[0]?.because).toContain('edited again since');
  });
});

describe('DRIFT_DECLARATIONS', () => {
  const byTag = new Map(
    readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => [name.slice(0, -4), readFileSync(path.join(MIGRATIONS, name), 'utf8')])
  );

  test('every declaration names a migration that is still in the tree', () => {
    for (const declaration of DRIFT_DECLARATIONS) {
      expect({ tag: declaration.tag, present: byTag.has(declaration.tag) }).toEqual({
        tag: declaration.tag,
        present: true,
      });
    }
  });

  test('every declaration still describes the file it is about', () => {
    // The check that catches rot rather than fraud: edit one of these
    // migrations again and its declaration stops matching, here, before it
    // reaches a database. It cannot prove the OLD file had this SQL — the old
    // text is not on the machine that runs the migration — and
    // `db:declare-drift` is where that half is established.
    for (const declaration of DRIFT_DECLARATIONS) {
      const sql = byTag.get(declaration.tag) ?? '';
      const found =
        declaration.kind === 'comment-only' ? sha256(sqlWithoutComments(sql)) : sha256(sql);
      const declared =
        declaration.kind === 'comment-only' ? declaration.sqlSha256 : declaration.becomes;
      expect({ tag: declaration.tag, digest: found }).toEqual({
        tag: declaration.tag,
        digest: declared,
      });
    }
  });

  test('no declaration re-records a digest the tree already agrees with', () => {
    // `recorded` is what a database holds for a migration that has drifted. If
    // it equalled the current file, the declaration would fire on a database
    // that is not drifted at all.
    for (const declaration of DRIFT_DECLARATIONS) {
      const current = sha256(byTag.get(declaration.tag) ?? '');
      expect({ tag: declaration.tag, sameAsTree: declaration.recorded === current }).toEqual({
        tag: declaration.tag,
        sameAsTree: false,
      });
    }
  });

  test('every declaration carries a reason, and every override an explicit one', () => {
    for (const declaration of DRIFT_DECLARATIONS) {
      expect({ tag: declaration.tag, why: declaration.why.length > 40 }).toEqual({
        tag: declaration.tag,
        why: true,
      });
    }
  });

  test('one tag holds at most one declaration per recorded digest', () => {
    const seen = new Set<string>();
    for (const declaration of DRIFT_DECLARATIONS) {
      const key = `${declaration.tag}@${declaration.recorded}`;
      expect({ key, duplicate: seen.has(key) }).toEqual({ key, duplicate: false });
      seen.add(key);
    }
  });
});
