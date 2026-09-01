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
 * ## The second rule: a migration that has RUN cannot be removed (SC-919)
 *
 * `D` was out of scope until SC-919, and it was the shape that most looked
 * clean. `--no-renames` is passed, so a RENAME arrives as `D` + `A` — and `A`
 * is the exempt arm — so renaming an applied migration read as *an addition,
 * which never needs a declaration*, plus a deletion nothing considered.
 *
 * The remedy differs from the edit arm's, which is why this could not simply
 * reuse it: no declaration can cover a removal. `planReconciliation` rejects a
 * tag with no file in the tree before any declaration is consulted, and
 * `migration-runner.ts` refuses earlier still with *applied migration(s)
 * missing from this tree*. Both refusals are correct and stay. So printing
 * `db:declare-drift` here would be WRONG ADVICE — there is no file to hash —
 * and this guard deliberately never prints it for a removal.
 *
 * A RENAME IS REPORTED AS A RENAME. Reporting it as an unrelated deletion plus
 * an addition is worse than nothing, because the fix is different: restore the
 * old name, and keep the new file only if it is genuinely wanted as a new
 * migration. A SECOND diff — the same range with `--find-renames` — supplies
 * that pairing. It is a second call rather than a flag change because
 * `--no-renames` is load-bearing for the `M` path: an `R` line carries THREE
 * tab-separated fields, and {@link parseDiff} reads the second as the file, so
 * rename detection on the primary diff would silently record the OLD path
 * under a status nothing handles.
 *
 * If that second diff cannot be read the removal is still REFUSED — a pairing
 * that could not be established changes the wording, never the verdict, and
 * the missing pairing is printed rather than assumed away.
 *
 * ## What it cannot see, stated rather than implied
 *
 *   - Whether a migration on the base branch has ACTUALLY run anywhere. It
 *     assumes it has, because the tree cannot know: `drizzle.__scani_migrations`
 *     is in a database this check never opens. That is the fail-closed
 *     direction — the alternative resolves toward clean on the case that
 *     blocks every deploy.
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

/**
 * Old tag -> new tag, from a `--find-renames --name-status` diff over the SAME
 * range. Only `R` lines are read, and only when both sides are migrations in
 * the folder: a migration renamed OUT of it has no new tag to name and is a
 * plain deletion as far as the reader is concerned.
 *
 * A rename line carries three tab-separated fields (`R100`, old, new). That is
 * exactly why this cannot be folded into {@link parseDiff}, which reads the
 * second field as the file.
 */
export function parseRenames(stdout: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [status, from, to] = line.split('\t');
    if (status === undefined || from === undefined || to === undefined) continue;
    if (!status.startsWith('R')) continue;
    const fromTag = tagOf(from);
    const toTag = tagOf(to);
    if (fromTag === null || toTag === null) continue;
    out.set(fromTag, toTag);
  }
  return out;
}

/** The migration tag a repo-relative path names, or `null` if it names none. */
function tagOf(file: string): string | null {
  if (!file.startsWith(`${MIGRATIONS_DIR}/`)) return null;
  const rest = file.slice(MIGRATIONS_DIR.length + 1);
  if (rest.includes('/') || !rest.endsWith('.sql')) return null;
  return rest.slice(0, -'.sql'.length);
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
  | { kind: 'stale'; tag: string; why: string }
  | { kind: 'deleted'; tag: string; file: string }
  | { kind: 'renamed'; tag: string; file: string; toTag: string };

/** The two findings a declaration can answer. The other two it cannot. */
export function isEditFinding(finding: Finding): boolean {
  return finding.kind === 'undeclared' || finding.kind === 'stale';
}

/**
 * `sqlByTag` carries the file as it stands in the working tree, for the edited
 * tags only. A tag missing from it is a read that failed, which is blindness
 * and is reported as such by the caller rather than being judged here.
 *
 * `renamedTo` pairs a deleted tag with the tag it became, from the rename-aware
 * diff. It only ever changes which SENTENCE a removal gets: a `D` with no
 * pairing is still a finding, so an empty map degrades the wording and never
 * the verdict.
 *
 * NO DECLARATION IS CONSULTED FOR A `D`, deliberately. One cannot cover it, and
 * looking would suggest one could.
 */
export function judge(
  changed: readonly ChangedMigration[],
  sqlByTag: ReadonlyMap<string, string>,
  declarations: readonly DriftDeclaration[] = DRIFT_DECLARATIONS,
  renamedTo: ReadonlyMap<string, string> = new Map()
): Finding[] {
  const findings: Finding[] = [];
  for (const entry of changed) {
    if (entry.status === 'D') {
      const toTag = renamedTo.get(entry.tag);
      findings.push(
        toTag === undefined
          ? { kind: 'deleted', tag: entry.tag, file: entry.file }
          : { kind: 'renamed', tag: entry.tag, file: entry.file, toTag }
      );
      continue;
    }
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
  /**
   * Why the rename-aware diff could not be read, when it could not. A removal
   * is refused either way; this is printed so a rename reported as a bare
   * deletion is a stated degradation rather than a silent one.
   */
  renamePairingUnavailable?: string;
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
  const deleted = input.changed.filter((c) => c.status === 'D').length;
  const other = input.changed.length - edited - added - deleted;
  const parts = [`${edited} edited`, `${added} added`, `${deleted} deleted`];
  // Nothing produces one today — `--no-renames` leaves only A/M/D — but a
  // status this build does not know must be counted rather than dropped, or
  // the denominator stops covering the population it claims to.
  if (other > 0) parts.push(`${other} of some other status`);
  const base = input.baseIsHead
    ? `base ${short(input.baseSha)} IS this tree, so there is no branch to judge`
    : `base ${short(input.baseSha)} (${input.base})`;
  return `${input.changed.length} migration file(s) changed against the base (${parts.join(', ')}) · ${base}`;
}

/**
 * THE TWO SECTIONS DO NOT SHARE A REMEDY, which is the whole reason SC-919 is
 * not a fifth `Finding` on the existing paragraph. `db:declare-drift` appears
 * in the edit section and NOWHERE in the removal section: a removal has no file
 * to hash, so following it would waste the reader's time at the exact moment
 * deploys are refusing.
 */
export function verdict(input: VerdictInput): Judgement {
  if (input.findings.length === 0) {
    return { exit: EXIT_OK, lines: [`migration-drift-declared: clean · ${denominator(input)}`] };
  }

  const edits = input.findings.filter(isEditFinding);
  const removals = input.findings.filter((f) => !isEditFinding(f));

  const clauses: string[] = [];
  if (edits.length > 0) {
    clauses.push(
      `${edits.length} edited migration(s) no drift declaration covers: ` +
        edits.map((f) => f.tag).join(', ')
    );
  }
  if (removals.length > 0) {
    clauses.push(
      `${removals.length} applied migration(s) deleted or renamed: ` +
        removals.map((f) => f.tag).join(', ')
    );
  }

  const lines = [
    `migration-drift-declared: REFUSED · exit ${EXIT_REFUSED} · ${clauses.join(' · ')} · ` +
      denominator(input),
  ];

  if (edits.length > 0) {
    lines.push(
      '',
      'Editing a migration that has already run — comments included — moves its sha256 away',
      'from what `drizzle.__scani_migrations` recorded, and `db:migrate` refuses the WHOLE run',
      'until a declaration says the edit is safe (SC-401, SC-914).',
      ''
    );
    for (const finding of edits) {
      if (finding.kind === 'undeclared') {
        lines.push(`  ${finding.tag} — no DRIFT_DECLARATIONS entry names this tag`);
      } else if (finding.kind === 'stale') {
        lines.push(
          `  ${finding.tag} — an entry names this tag and does not cover it: ${finding.why}`
        );
      }
      lines.push(`      cd packages/infra/db && bun run db:declare-drift ${finding.tag}`);
    }
    lines.push(
      '',
      'That prints the entry to paste into DRIFT_DECLARATIONS in',
      'packages/infra/db/src/migration-reconciliation.ts. Derive the hashes that way and',
      'no other: computed from the file you just edited they satisfy the runner and',
      'assert nothing.'
    );
  }

  if (removals.length > 0) {
    lines.push(
      '',
      'A migration that has run cannot be deleted or renamed — the database is the record of',
      'what ran, and this tree no longer contains it. `db:migrate` refuses the WHOLE run with',
      '`applied migration(s) missing from this tree`, and no declaration can cover it:',
      '`planReconciliation` rejects a tag with no file to re-record it against. So',
      '`db:declare-drift` is NOT the remedy here and this guard will not print one for it',
      '(SC-691, SC-919).',
      '',
      'Restore it:',
      ''
    );
    for (const finding of removals) {
      if (finding.kind === 'renamed') {
        lines.push(`  ${finding.tag} — renamed to ${finding.toTag}`);
        lines.push(`      git checkout ${input.baseSha} -- ${finding.file}`);
        lines.push(
          `      Keep ${finding.toTag} only if it is genuinely wanted as a NEW migration;`
        );
        lines.push('      it is then applied on top rather than replacing the old one.');
      } else if (finding.kind === 'deleted') {
        lines.push(`  ${finding.tag} — deleted`);
        lines.push(`      git checkout ${input.baseSha} -- ${finding.file}`);
      }
    }
    if (input.renamePairingUnavailable !== undefined) {
      lines.push(
        '',
        `Renames could not be paired (${input.renamePairingUnavailable}), so a rename above is`,
        'reported as a plain deletion. Restoring the old file is still the fix either way.'
      );
    }
  }

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

  // The SAME range again, with rename detection on, purely to pair a deletion
  // with what it became. It is skipped when nothing was deleted — there is
  // then nothing to pair, and running it would let an unrelated git failure
  // speak about a branch it has no finding on. A failure here degrades the
  // wording of a refusal that happens anyway; it never turns one into a pass.
  let renamedTo = new Map<string, string>();
  let renamePairingUnavailable: string | undefined;
  if (changed.some((entry) => entry.status === 'D')) {
    const renames = runGit(
      ['diff', '--find-renames', '--name-status', from, '--', MIGRATIONS_DIR],
      repo
    );
    if (renames.kind === 'failed') renamePairingUnavailable = renames.why;
    else renamedTo = parseRenames(renames.stdout);
  }

  return verdict({
    base,
    baseSha: from,
    baseIsHead: from === head.stdout.trim(),
    changed,
    findings: judge(changed, sqlByTag, DRIFT_DECLARATIONS, renamedTo),
    renamePairingUnavailable,
  });
}

if (import.meta.main) {
  const judgement = run(process.argv.slice(2), process.env);
  const write = judgement.exit === EXIT_OK ? console.log : console.error;
  for (const line of judgement.lines) write(line);
  process.exit(judgement.exit);
}
