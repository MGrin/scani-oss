/**
 * SC-638. A pull-request BODY is executable input to release-please, and a
 * malformed override in it silently deletes every changelog entry of that PR.
 *
 * THE FAILURE THIS EXISTS FOR, and it was caused by documenting the mechanism.
 *
 * `preprocessCommitMessage` splits a commit's pull-request body on
 * `BEGIN_COMMIT_OVERRIDE`, takes everything up to `END_COMMIT_OVERRIDE`, and
 * uses THAT as the commit message — for every commit of the pull request,
 * because `mergeCommitIterator` attaches the body to all of them.
 *
 * `MGrin/scani-oss#219` used the literal marker twice, in prose, explaining
 * what it does, with no closing marker anywhere. So the "override" became the
 * paragraph that happened to follow it, beginning with a backtick, and all
 * three commits of that PR — two branch commits and the merge — parsed to
 * nothing:
 *
 *     commit could not be parsed: fcb684e93 fix(oss): name both causes …
 *     error message: Error: unexpected token ' ' at 1:2, valid tokens [(, !, :]
 *
 * release-please then found no new releasable commits, logged
 * `PR #211 remained the same`, and reported SUCCESS having regenerated
 * nothing. Two further runs did the same. The dropped commits included an
 * ordinary `fix(oss): …`, so this is not a hazard peculiar to nested-commit
 * blocks — it eats anything.
 *
 * WHY A GUARD AND NOT A CONVENTION. `check-release-notes.ts` describes this
 * override as the recovery for a missing entry, so the marker appears in a
 * message a person is invited to quote into a pull request. The natural,
 * careful act — pasting the advice you are following — is the one that breaks
 * it.
 *
 * WHAT IT CHECKS. Not "does the body mention the marker": it replicates
 * release-please's extraction exactly and asks what release-please WOULD use
 * as the message. Empty is fine and is the normal case. Non-empty must be a
 * deliberate, well-formed override — closed with `END_COMMIT_OVERRIDE`, and
 * parsing as a conventional commit. That allows the legitimate recovery and
 * refuses the accidental mention, which are otherwise the same string.
 *
 * It imports `parseSubject` from `check-release-notes.ts` rather than the real
 * parser on purpose: the two are the release-time and authoring-time ends of
 * one defect, and this workflow installs no dependencies.
 *
 * WHERE IT APPLIES. Keyed on `release-please-config.json` being present, like
 * `check-pr-title.ts` — where release-please does not run there is no
 * changelog to damage, and this file reaches the private mirror through the
 * downward sync, where no pull-request body is ever read by a release tool.
 */

import { parseSubject } from './check-release-notes.ts';

/** Kept apart so the strings this file must never contain in prose are in one place. */
const BEGIN = 'BEGIN_COMMIT_OVERRIDE';
const END = 'END_COMMIT_OVERRIDE';

export interface OverrideReading {
  /** What release-please would use as the commit message. Empty means none. */
  message: string;
  closed: boolean;
}

/**
 * Exactly what `preprocessCommitMessage` does — `split(BEGIN)[1]`, then
 * `split(END)[0]`, then `trim()`. Deliberately not a tidier equivalent: the
 * question is what release-please will do, not what a reasonable parser would.
 */
export function readOverride(body: string): OverrideReading {
  const afterBegin = body.split(BEGIN)[1];
  if (afterBegin === undefined) return { message: '', closed: false };
  return { message: afterBegin.split(END)[0]?.trim() ?? '', closed: afterBegin.includes(END) };
}

export type Verdict =
  | { ok: true; reason: 'no-override' | 'well-formed' }
  | { ok: false; reason: 'unclosed' | 'not-conventional'; message: string };

export function judge(body: string): Verdict {
  const { message, closed } = readOverride(body);
  if (!message) return { ok: true, reason: 'no-override' };
  if (!closed) return { ok: false, reason: 'unclosed', message };
  if (!parseSubject(message.split('\n')[0] ?? '')) {
    return { ok: false, reason: 'not-conventional', message };
  }
  return { ok: true, reason: 'well-formed' };
}

function refusal(verdict: Extract<Verdict, { ok: false }>): string {
  const shown = verdict.message.split('\n').slice(0, 3).join('\n');
  const why =
    verdict.reason === 'unclosed'
      ? `This body opens ${BEGIN} and never closes it, so release-please takes\n` +
        `EVERYTHING after the marker as the commit message. Almost always this is a\n` +
        `mention of the marker in prose rather than a real override.`
      : `The text between the markers is not a conventional commit, so release-please\n` +
        `will parse it to nothing and this pull request will contribute NO changelog\n` +
        `entries at all.`;

  return (
    `check-pr-body: FAILED · exit 1 · this body would replace the commit message of ` +
    `EVERY\ncommit in this pull request\n\n` +
    `  what release-please would use as the message:\n` +
    `${shown
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n')}\n\n` +
    `${why}\n\n` +
    `The override is read from the pull-request BODY and attached to every commit of ` +
    `the\nPR, so a broken one deletes all of them — silently. release-please logs the ` +
    `parse\nerror at DEBUG level, reports success, and regenerates nothing (SC-638).\n\n` +
    `If you did NOT mean to write an override: describe the mechanism instead of ` +
    `spelling\nthe marker. A pull-request body is input to the release pipeline, not ` +
    `documentation.\n\n` +
    `If you DID: close the block with the end marker and make the text between them a\n` +
    `conventional commit message, subject line first.`
  );
}

if (import.meta.main) {
  const repoRoot = new URL('..', import.meta.url).pathname;
  if (!(await Bun.file(`${repoRoot}release-please-config.json`).exists())) {
    console.log(
      'check-pr-body: no release-please-config.json here, so no pull-request body is read ' +
        'by a release tool — rule does not apply.'
    );
    process.exit(0);
  }

  // An absent variable and an empty body are different things, and only one of
  // them is a body. `PR_BODY` is always set by the workflow, to '' for an empty
  // body; an unset variable means the workflow is wired wrong.
  if (process.env.PR_BODY === undefined) {
    console.error('check-pr-body: PR_BODY is not set — refusing rather than passing vacuously.');
    process.exit(2);
  }
  const body = process.env.PR_BODY;

  const verdict = judge(body);
  if (!verdict.ok) {
    console.error(refusal(verdict));
    process.exit(1);
  }

  // The denominator, so a pass says what it looked at. A body of 0 characters
  // cannot contain a marker, and that pass reads identically to a real one
  // unless the count is printed.
  console.log(
    `check-pr-body: ok — ${verdict.reason === 'well-formed' ? 'a well-formed commit-message override' : 'no commit-message override'} in ${body.length} characters of body.`
  );
}
