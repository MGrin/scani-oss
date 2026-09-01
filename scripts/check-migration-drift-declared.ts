#!/usr/bin/env bun
/**
 * SC-914. A migration file that has ALREADY RUN somewhere may not be edited on
 * a branch unless a `DRIFT_DECLARATIONS` entry covers it.
 *
 * ## The incident this exists for
 *
 * On 2026-09-01 two pull requests edited COMMENTS inside applied migrations.
 * `migration-files.ts` hashes each migration with `sha256(sql)` over the whole
 * file — comments included — and `migration-runner.ts` compares that against
 * `drizzle.__scani_migrations` and refuses the WHOLE `db:migrate` run when they
 * disagree. Production deploys were blocked for about an hour. Both pull
 * requests were reviewed for behaviour changes, correctly found to have none,
 * and merged: nothing in the repository said a comment counted, and nothing
 * checked.
 *
 * `migration-reconciliation.ts` made that RECOVERABLE. It does not make it
 * impossible — edit a comment, write no declaration, merge, and the deploy
 * still refuses. This is the half that makes the declaration mandatory, at the
 * moment it is still cheap to write.
 *
 * ## The rule, and the arm that is deliberately NOT the rule
 *
 * A migration that exists at the merge base and is MODIFIED by this branch
 * needs a declaration naming its tag. ADDING a migration never does, and that
 * arm is the control: a guard that fired on every migration touch would be
 * switched off inside a week, and then nothing protects anything. It is tested
 * explicitly for that reason.
 *
 * ## What it checks beyond the tag
 *
 * A declaration whose tag matches and whose CONTENT is a lie would pass a
 * tag-presence check and still leave the deploy refusing, because the runner
 * checks the content too. So the two hashes a declaration can be judged
 * against WITHOUT a database are judged here:
 *
 *   `comment-only` — `sqlSha256` is the digest of the non-comment SQL, which a
 *   comment edit cannot move. If the file in this tree no longer hashes to it,
 *   the edit changed executable SQL and the declaration is the wrong kind.
 *
 *   `sql-changed` — `becomes` pins the exact digest it was written against, so
 *   a SECOND edit to the same file stops matching and needs its own entry.
 *
 * `recorded` is deliberately NOT checked: it is what a DATABASE recorded, and
 * the base blob on a branch cut after the first edit merged is already the
 * edited text. Comparing them would refuse every correct branch.
 *
 * ## What it cannot see, stated rather than implied
 *
 *   - A DELETED or RENAMED migration. It breaks the runner just as hard and no
 *     declaration can fix it — `planReconciliation` rejects a tag with no file
 *     in the tree — so pointing the reader at `db:declare-drift` would be wrong
 *     advice. Out of scope on purpose, not by oversight.
 *   - Anything, when the base IS this tree. On a push to `main` the merge base
 *     is HEAD and the branch is empty by construction; the verdict line says so
 *     in words rather than printing a bare zero.
 *
 * Exit 0 clean, 1 refusing and naming every tag, 9 when it could not look.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from '../packages/infra/db/src/migration-files';
import {
  DRIFT_DECLARATIONS,
  type DriftDeclaration,
  sqlWithoutComments,
} from '../packages/infra/db/src/migration-reconciliation';
import { EXIT_OK, EXIT_REFUSED, EXIT_UNKNOWN, runGit } from './lib/check-verdict';

/** Repo-relative, because that is how `git diff --name-status` names it. */
export const MIGRATIONS_DIR = 'packages/infra/db/src/migrations';

export interface ChangedMigration {
  /** `A`, `M` or `D`. `--no-renames` is passed, so `R`/`C` cannot appear. */
  status: string;
  tag: string;
  file: string;
}

/**
 * The migration files in a `--name-status` diff, by tag.
 *
 * `meta/_journal.json` is skipped: it is derived from the folder by
 * `migration-cli.ts journal` and carries no digest anything compares.
 */
export function parseDiff(stdout: string): ChangedMigration[] {
  const out: ChangedMigration[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    const status = parts[0];
    const file = parts[1];
    if (status === undefined || file === undefined) continue;
    if (!file.startsWith(`${MIGRATIONS_DIR}/`)) continue;
    const rest = file.slice(MIGRATIONS_DIR.length + 1);
    if (rest.includes('/') || !rest.endsWith('.sql')) continue;
    out.push({ status: status.slice(0, 1), tag: rest.slice(0, -'.sql'.length), file });
  }
  return out;
}

function short(hash: string): string {
  return hash === '' ? '<empty>' : `${hash.slice(0, 12)}…`;
}

/**
 * `null` when this declaration covers the file as it stands, otherwise the
 * sentence explaining why it does not.
 */
export function declarationHolds(declaration: DriftDeclaration, currentSql: string): string | null {
  if (declaration.kind === 'comment-only') {
    const found = sha256(sqlWithoutComments(currentSql));
    if (found === declaration.sqlSha256) return null;
    return (
      `its \`sqlSha256\` describes non-comment SQL this tree does not have ` +
      `(declared ${short(declaration.sqlSha256)}, this tree hashes to ${short(found)}) — ` +
      'so this edit moves executable SQL, and a comment-only declaration cannot cover it'
    );
  }
  const found = sha256(currentSql);
  if (found === declaration.becomes) return null;
  return (
    `it was written against ${short(declaration.becomes)} and this tree has ${short(found)} — ` +
    'the file has been edited again since, so it needs its own entry'
  );
}

export type Finding =
  | { kind: 'undeclared'; tag: string }
  | { kind: 'stale'; tag: string; why: string };

/**
 * `sqlByTag` carries the file as it stands in the working tree, for the edited
 * tags only. A tag missing from it is a read that failed, which is blindness
 * and is reported as such by the caller rather than being judged here.
 */
export function judge(
  changed: readonly ChangedMigration[],
  sqlByTag: ReadonlyMap<string, string>,
  declarations: readonly DriftDeclaration[] = DRIFT_DECLARATIONS
): Finding[] {
  const findings: Finding[] = [];
  for (const entry of changed) {
    if (entry.status !== 'M') continue;
    const current = sqlByTag.get(entry.tag);
    if (current === undefined) continue;
    const covering = declarations.filter((declaration) => declaration.tag === entry.tag);
    if (covering.length === 0) {
      findings.push({ kind: 'undeclared', tag: entry.tag });
      continue;
    }
    const reasons = covering.map((declaration) => declarationHolds(declaration, current));
    if (reasons.some((reason) => reason === null)) continue;
    findings.push({ kind: 'stale', tag: entry.tag, why: reasons[0] ?? 'no declaration applied' });
  }
  return findings;
}

export interface VerdictInput {
  /** The ref the base was resolved from, for the reader. */
  base: string;
  baseSha: string;
  baseIsHead: boolean;
  changed: readonly ChangedMigration[];
  findings: readonly Finding[];
}

export interface Judgement {
  exit: number;
  /** The verdict line first, then any detail. */
  lines: string[];
}

/**
 * The DENOMINATOR is the count of migration files the diff carried, not a
 * count of declarations or of files on disk. A run that examined nothing must
 * not be able to print the same line as a run that examined everything
 * (`scripts/lib/check-verdict.ts`).
 */
function denominator(input: VerdictInput): string {
  const edited = input.changed.filter((c) => c.status === 'M').length;
  const added = input.changed.filter((c) => c.status === 'A').length;
  const other = input.changed.length - edited - added;
  const parts = [`${edited} edited`, `${added} added`];
  if (other > 0) parts.push(`${other} removed (out of scope)`);
  const base = input.baseIsHead
    ? `base ${short(input.baseSha)} IS this tree, so there is no branch to judge`
    : `base ${short(input.baseSha)} (${input.base})`;
  return `${input.changed.length} migration file(s) changed against the base (${parts.join(', ')}) · ${base}`;
}

export function verdict(input: VerdictInput): Judgement {
  if (input.findings.length === 0) {
    return { exit: EXIT_OK, lines: [`migration-drift-declared: clean · ${denominator(input)}`] };
  }

  const tags = input.findings.map((f) => f.tag);
  const lines = [
    `migration-drift-declared: REFUSED · exit ${EXIT_REFUSED} · ` +
      `${input.findings.length} edited migration(s) no drift declaration covers: ${tags.join(', ')} · ` +
      denominator(input),
    '',
    'Editing a migration that has already run — comments included — moves its sha256 away',
    'from what `drizzle.__scani_migrations` recorded, and `db:migrate` refuses the WHOLE run',
    'until a declaration says the edit is safe (SC-401, SC-914).',
    '',
  ];
  for (const finding of input.findings) {
    if (finding.kind === 'undeclared') {
      lines.push(`  ${finding.tag} — no DRIFT_DECLARATIONS entry names this tag`);
    } else {
      lines.push(
        `  ${finding.tag} — an entry names this tag and does not cover it: ${finding.why}`
      );
    }
    lines.push(`      cd packages/infra/db && bun run db:declare-drift ${finding.tag}`);
  }
  lines.push('');
  lines.push('That prints the entry to paste into DRIFT_DECLARATIONS in');
  lines.push('packages/infra/db/src/migration-reconciliation.ts. Derive the hashes that way and');
  lines.push('no other: computed from the file you just edited they satisfy the runner and');
  lines.push('assert nothing.');
  return { exit: EXIT_REFUSED, lines };
}

export function unknown(why: string): Judgement {
  return {
    exit: EXIT_UNKNOWN,
    lines: [
      `migration-drift-declared: UNKNOWN · exit ${EXIT_UNKNOWN} · ${why}`,
      '  NOTHING WAS COMPARED, so nothing here says this branch edits no migration.',
      '  This is not a pass.',
    ],
  };
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  return argv[at + 1];
}

/**
 * `origin/<base branch>` on a pull request, `origin/main` otherwise. There is
 * no fallback to a local `main`: a base that cannot be resolved is blindness,
 * and quietly comparing against a different ref is how a check reports clean
 * about a question nobody asked.
 */
export function defaultBase(env: Record<string, string | undefined>): string {
  const prBase = env.GITHUB_BASE_REF;
  return prBase !== undefined && prBase !== '' ? `origin/${prBase}` : 'origin/main';
}

export function run(argv: readonly string[], env: Record<string, string | undefined>): Judgement {
  const repo = path.resolve(argValue(argv, '--repo') ?? path.resolve(import.meta.dir, '..'));
  const base = argValue(argv, '--base') ?? defaultBase(env);

  const baseSha = runGit(['rev-parse', '--verify', `${base}^{commit}`], repo);
  if (baseSha.kind === 'failed')
    return unknown(`the base \`${base}\` could not be resolved: ${baseSha.why}`);

  const mergeBase = runGit(['merge-base', baseSha.stdout.trim(), 'HEAD'], repo);
  if (mergeBase.kind === 'failed') {
    return unknown(`no merge base between \`${base}\` and HEAD could be found: ${mergeBase.why}`);
  }
  const from = mergeBase.stdout.trim();

  const head = runGit(['rev-parse', '--verify', 'HEAD^{commit}'], repo);
  if (head.kind === 'failed') return unknown(`HEAD could not be resolved: ${head.why}`);

  // Against the WORKING TREE, not against HEAD: an uncommitted edit to an
  // applied migration is the same defect one commit earlier, and the pre-commit
  // caller sees it only this way.
  const diff = runGit(['diff', '--no-renames', '--name-status', from, '--', MIGRATIONS_DIR], repo);
  if (diff.kind === 'failed') return unknown(`the migration diff could not be read: ${diff.why}`);

  const changed = parseDiff(diff.stdout);
  const sqlByTag = new Map<string, string>();
  for (const entry of changed) {
    if (entry.status !== 'M') continue;
    try {
      sqlByTag.set(entry.tag, readFileSync(path.join(repo, entry.file), 'utf8'));
    } catch (e) {
      return unknown(`${entry.file} is modified and could not be read: ${(e as Error).message}`);
    }
  }

  return verdict({
    base,
    baseSha: from,
    baseIsHead: from === head.stdout.trim(),
    changed,
    findings: judge(changed, sqlByTag),
  });
}

if (import.meta.main) {
  const judgement = run(process.argv.slice(2), process.env);
  const write = judgement.exit === EXIT_OK ? console.log : console.error;
  for (const line of judgement.lines) write(line);
  process.exit(judgement.exit);
}
