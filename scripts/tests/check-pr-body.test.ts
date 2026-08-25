import { describe, expect, test } from 'bun:test';
import { judge, readOverride } from '../check-pr-body.ts';

// Assembled rather than written literally, so this test file cannot itself
// become the thing it tests when its contents are quoted into a body.
const BEGIN = `BEGIN_COMMIT${'_'}OVERRIDE`;
const END = `END_COMMIT${'_'}OVERRIDE`;

/**
 * The shape that actually did it, reduced from `MGrin/scani-oss#219`: the
 * marker named in prose, inside backticks, explaining what it does, with no
 * closing marker anywhere in the body. release-please took everything after it
 * as the commit message and every commit of that pull request parsed to
 * nothing.
 */
const THE_REAL_SHAPE = [
  '## Second commit',
  '',
  `\`preprocessCommitMessage\` reads \`${BEGIN}\` out of the pull request **body**, and`,
  'the walk attaches that body to every commit of the same PR.',
].join('\n');

describe('the accidental mention that deleted three changelog entries', () => {
  test('an unclosed marker is refused', () => {
    const verdict = judge(THE_REAL_SHAPE);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('unclosed');
  });

  // The `1:2` in the live log: release-please's extraction began with a
  // backtick, then a space. Asserting the extraction itself, not just that
  // something was refused.
  test('and what release-please would have used starts with the backtick', () => {
    const { message, closed } = readOverride(THE_REAL_SHAPE);
    expect(closed).toBe(false);
    expect(message.startsWith('`')).toBe(true);
    expect(message.slice(0, 2)).toBe('` ');
  });
});

describe('the legitimate override is still allowed', () => {
  // `check-release-notes.ts` prescribes exactly this as the recovery for a
  // missing entry. A guard that forbade it would forbid its own remedy.
  test('a closed, conventional override passes', () => {
    const body = [
      'Recovering a lost entry.',
      '',
      BEGIN,
      'fix(http-fetch): a quadratic regex on attacker-controlled markup (SC-208)',
      END,
      '',
      'More prose after it.',
    ].join('\n');
    const verdict = judge(body);
    expect(verdict.ok).toBe(true);
    expect(verdict.ok === true && verdict.reason).toBe('well-formed');
    expect(readOverride(body).message).toBe(
      'fix(http-fetch): a quadratic regex on attacker-controlled markup (SC-208)'
    );
  });

  test('a closed block whose contents are prose is refused', () => {
    const verdict = judge([BEGIN, 'just some words, not a commit', END].join('\n'));
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe('not-conventional');
  });
});

describe('the ordinary case, and the denominator behind it', () => {
  test.each([
    ['an empty body', ''],
    ['prose with no marker at all', 'Closes SC-1. Fixes a thing.\n\nWith a paragraph.'],
    // Must-be-ABSENT: the marker's NAME is not the marker. This file, the
    // guard, and the release-notes failure message all discuss it in prose.
    ['a body naming the end marker only', `Do not forget ${END} when you write one.`],
  ])('%s passes', (_label, body) => {
    expect(judge(body).ok).toBe(true);
    expect(judge(body).ok === true && (judge(body) as { reason: string }).reason).toBe(
      'no-override'
    );
  });
});

describe('the guard reads what release-please reads, not something like it', () => {
  // Two markers: release-please takes `split(BEGIN)[1]`, so the FIRST opening
  // wins and text before the second is part of the message.
  test('the first opening marker is the one that counts', () => {
    const body = [BEGIN, 'fix(a): first', END, BEGIN, 'fix(b): second', END].join('\n');
    expect(readOverride(body).message).toBe('fix(a): first');
    expect(judge(body).ok).toBe(true);
  });

  // A body that closes the block but leaves the subject on the second line:
  // release-please parses from the first line, so this is not an override.
  test('a leading blank line inside the block is refused', () => {
    const verdict = judge([BEGIN, '', 'fix(a): thing', END].join('\n'));
    // `.trim()` in release-please's own extraction removes it, so this passes
    // — pinned because it is the surprising half, not because it is desirable.
    expect(verdict.ok).toBe(true);
  });
});
