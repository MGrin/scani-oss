import { describe, expect, test } from 'bun:test';
import {
  earnsAReleaseNote,
  extractVersionSection,
  findShortfall,
  normaliseDescription,
  parseBulletDescriptions,
  parseSubject,
  RELEASE_NOTE_TYPES,
  type ReleasableCommit,
  releasableSibling,
} from '../check-release-notes';

/**
 * SC-573. The fixtures below are not written by hand: they are the real bytes
 * of the 0.16.0 release, taken from MGrin/scani-oss at two shas.
 *
 *   77021b26  the release commit release-please FIRST generated, parent
 *             aa5c9c63a. Force-pushed away on 2026-08-22T10:05:08Z and
 *             recoverable only from the pull request's timeline events, which
 *             is why the section is captured here rather than fetched.
 *   23e8c324  the same release after SC-572's repair, parent 6ab35c751.
 *
 * The first is the failure this check exists for. Four releasable commits were
 * on `main`; release-please's chronological walk stopped at v0.15.0's sha and
 * listed two of them. Nothing reported it.
 */

const BEFORE_REPAIR = `## [0.16.0](https://github.com/MGrin/scani-oss/compare/v0.15.0...v0.16.0) (2026-08-22)


### Features

* **holdings:** let a pot be named after it exists (SC-564) ([ea4f2b5](https://github.com/MGrin/scani-oss/commit/ea4f2b5f8beea86c582516446c1e6f93456d307d))


### Bug Fixes

* **holdings:** show the pot name in the desktop table too (SC-564) ([d21d588](https://github.com/MGrin/scani-oss/commit/d21d588979d2e0ba5382688c316578952b38575a))
`;

const AFTER_REPAIR = `## [0.16.0](https://github.com/MGrin/scani-oss/compare/v0.15.0...v0.16.0) (2026-08-22)


### Features

* **holdings:** let a pot be named after it exists (SC-564) ([ea4f2b5](https://github.com/MGrin/scani-oss/commit/ea4f2b5f8beea86c582516446c1e6f93456d307d))


### Bug Fixes

* **holdings:** reconcile hidden holdings in the user-wide pass (SC-502) ([42066e0](https://github.com/MGrin/scani-oss/commit/42066e08ca654853dbed477d994156f5bf20a582))
* **holdings:** send the balance whole, and say "&lt; 0.00000001" not "0" (SC-567) ([5a006ab](https://github.com/MGrin/scani-oss/commit/5a006abd19776d91fe4a12475810a8d64c5eddad))
* **holdings:** show the pot name in the desktop table too (SC-564) ([d21d588](https://github.com/MGrin/scani-oss/commit/d21d588979d2e0ba5382688c316578952b38575a))
* **holdings:** stop the balance editor destroying a dust balance (SC-567) ([5a006ab](https://github.com/MGrin/scani-oss/commit/5a006abd19776d91fe4a12475810a8d64c5eddad))
* **jobs:** stop telling a reader to check details that are not on the page (SC-554) ([5841793](https://github.com/MGrin/scani-oss/commit/5841793dacccfc2f6103499ecf265ce61f909e61))
* **self-host:** serve the nine security headers the nginx image never sent (SC-561) ([050fbc6](https://github.com/MGrin/scani-oss/commit/050fbc6304a5edec1660cd046877977783fe9010))
`;

/** `git log v0.15.0..<parent> --no-merges`, releasable subjects only. */
function releasable(subjects: [string, string][]): ReleasableCommit[] {
  return subjects.map(([sha, subject]) => {
    const parsed = parseSubject(subject);
    if (!parsed) throw new Error(`fixture subject does not parse: ${subject}`);
    return { sha, subject, description: parsed.description };
  });
}

/** v0.15.0..aa5c9c63a — what was on `main` when 0.16.0 was first proposed. */
const WINDOW_BEFORE_REPAIR = releasable([
  ['d21d58897', 'fix(holdings): show the pot name in the desktop table too (SC-564)'],
  ['ea4f2b5f8', 'feat(holdings): let a pot be named after it exists (SC-564)'],
  ['56b862869', 'fix(holdings): send the balance whole, and say "< 0.00000001" not "0" (SC-567)'],
  ['d49966604', 'fix(holdings): stop the balance editor destroying a dust balance (SC-567)'],
]);

/** v0.15.0..6ab35c751 — the same window once three more fixes had landed. */
const WINDOW_AFTER_REPAIR = releasable([
  [
    '5841793da',
    'fix(jobs): stop telling a reader to check details that are not on the page (SC-554)',
  ],
  ['42066e08c', 'fix(holdings): reconcile hidden holdings in the user-wide pass (SC-502)'],
  [
    '050fbc630',
    'fix(self-host): serve the nine security headers the nginx image never sent (SC-561)',
  ],
  ['d21d58897', 'fix(holdings): show the pot name in the desktop table too (SC-564)'],
  ['ea4f2b5f8', 'feat(holdings): let a pot be named after it exists (SC-564)'],
  ['56b862869', 'fix(holdings): send the balance whole, and say "< 0.00000001" not "0" (SC-567)'],
  ['d49966604', 'fix(holdings): stop the balance editor destroying a dust balance (SC-567)'],
]);

function shortfallAgainst(section: string, commits: ReleasableCommit[]): string[] {
  const parsed = extractVersionSection(section, '0.16.0');
  expect(parsed).not.toBeNull();
  return findShortfall(commits, parseBulletDescriptions(parsed as string)).map(({ sha }) => sha);
}

describe('the 0.16.0 release, as it actually happened', () => {
  test('goes red on the state release-please first proposed', () => {
    expect(shortfallAgainst(BEFORE_REPAIR, WINDOW_BEFORE_REPAIR)).toEqual([
      '56b862869',
      'd49966604',
    ]);
  });

  test('goes green on the state SC-572 repaired it to', () => {
    expect(shortfallAgainst(AFTER_REPAIR, WINDOW_AFTER_REPAIR)).toEqual([]);
  });

  /**
   * The repair attributed both SC-567 fixes to `5a006ab`, the MERGE commit
   * that landed them, not to the branch commits `56b86286` and `d4996660`
   * the walk had missed. So matching a bullet to a commit by the sha in its
   * link — which is the first thing anyone reaches for, and is exact — would
   * report a two-commit shortfall on a release that is correct.
   *
   * That is why the comparison is on description text. Do not "improve" it
   * to a sha comparison without first checking what release-please linked.
   */
  test('a sha-keyed comparison would call the repaired release broken', () => {
    const linked = new Set(
      [...AFTER_REPAIR.matchAll(/\/commit\/([0-9a-f]+)\)/g)].map(([, sha]) =>
        (sha as string).slice(0, 9)
      )
    );
    const missingBySha = WINDOW_AFTER_REPAIR.filter(({ sha }) => !linked.has(sha)).map(
      ({ sha }) => sha
    );
    expect(missingBySha).toEqual(['56b862869', 'd49966604']);
  });
});

describe('the comparison itself', () => {
  /**
   * DO NOT SOFTEN THIS ONE. A release PR that release-please has only just
   * opened, or has half-written, has few bullets and many releasable commits,
   * and "0 bullets 30 seconds after a push is probably fine" is persuasive
   * every single time — including the time it is a release about to ship
   * without a data-loss fix. An empty notes section is a shortfall of N, and
   * the check has a separate BLIND exit for the states where it genuinely
   * could not look. Waiting is the operator's call to make from a red, not
   * this function's to make on their behalf.
   */
  test('an empty notes section is a shortfall of N, never a pass', () => {
    expect(findShortfall(WINDOW_BEFORE_REPAIR, [])).toHaveLength(4);
  });

  test('decodes the HTML escaping release-please applies to a description', () => {
    const bullets = parseBulletDescriptions(
      '* **holdings:** send the balance whole, and say "&lt; 0.00000001" not "0" (SC-567) ([5a006ab](https://x/commit/5a006ab))'
    );
    expect(
      findShortfall(
        releasable([
          [
            '56b862869',
            'fix(holdings): send the balance whole, and say "< 0.00000001" not "0" (SC-567)',
          ],
        ]),
        bullets
      )
    ).toEqual([]);
  });

  test('two commits with the same description need two bullets', () => {
    const twice = releasable([
      ['aaaaaaaaa', 'fix(x): the same words'],
      ['bbbbbbbbb', 'fix(x): the same words'],
    ]);
    expect(findShortfall(twice, ['the same words'])).toHaveLength(1);
    expect(findShortfall(twice, ['the same words', 'the same words'])).toHaveLength(0);
  });

  test('strips the bullet marker, the bolded scope and every trailing link', () => {
    expect(
      parseBulletDescriptions(
        '* **queue:** move BullMQ to Postgres ([#12](https://x/pull/12)) ([1c117c4](https://x/commit/1c117c4))'
      )
    ).toEqual(['move bullmq to postgres']);
  });

  /**
   * SC-621. The recovery for a missing entry is a hand-written bullet behind a
   * `BEGIN_COMMIT_OVERRIDE`, and the natural thing to write is this repo's
   * ticket suffix — which the commit subject may not carry. Measured on the
   * 0.18.0 repair: the bullet was plainly there, in a release PR of 20, and
   * this check went on reporting `1 of 20 ... have no entry`.
   */
  describe('a ticket suffix on one side only', () => {
    const commit = releasable([['aaaaaaaaa', 'fix(holdings): an untouched date field means now']]);

    // Through `parseBulletDescriptions`, because that is where a bullet comes
    // from in the run that reported the false shortfall.
    const bullets = (line: string) => parseBulletDescriptions(`* **holdings:** ${line}`);

    test('a bullet the check could not see before is matched now', () => {
      expect(
        findShortfall(commit, bullets('an untouched date field means now (SC-612)'))
      ).toHaveLength(0);
    });

    // The other direction: the commit carries it and the bullet does not.
    test('and the same when the suffix is on the commit instead', () => {
      const suffixed = releasable([
        ['aaaaaaaaa', 'fix(holdings): an untouched date field means now (SC-612)'],
      ]);
      expect(findShortfall(suffixed, ['an untouched date field means now'])).toHaveLength(0);
    });

    test('both suffixes, in either order, on either side', () => {
      expect(normaliseDescription('a thing (SC-612) (#207)')).toBe('a thing');
      expect(normaliseDescription('a thing (#207) (SC-612)')).toBe('a thing');
    });

    // Must-be-ABSENT: stripping a trailing suffix must not eat a mid-sentence
    // reference, nor make two genuinely different entries look alike.
    test('a reference that is not a trailing suffix survives', () => {
      expect(normaliseDescription('reopen the (SC-612) answers for a holding')).toBe(
        'reopen the (sc-612) answers for a holding'
      );
      expect(normaliseDescription('a thing (SC-612)')).not.toBe(
        normaliseDescription('another thing (SC-612)')
      );
    });

    // The shortfall it must STILL report — the strip is not a way to pass.
    test('a genuinely missing entry is still missing', () => {
      expect(findShortfall(commit, bullets('something else entirely (SC-612)'))).toHaveLength(1);
    });
  });
});

describe('which commits earn an entry', () => {
  /**
   * A copy of the visible half of the `conventional-changelog-conventionalcommits`
   * preset defaults, which apply because `release-please-config.json` sets no
   * `changelog-sections` key. Asserted here so that widening it is a decision
   * someone makes on purpose rather than a line edit — a type added without a
   * rendered changelog to justify it turns a missing entry into a blocked
   * release.
   */
  test('is the preset list, and changing it is deliberate', () => {
    expect([...RELEASE_NOTE_TYPES]).toEqual(['feat', 'feature', 'fix', 'perf', 'revert']);
  });

  test('includes the types this repo has actually published', () => {
    for (const subject of [
      'feat(holdings): let a pot be named after it exists (SC-564)',
      'fix(jobs): stop telling a reader to check details that are not on the page (SC-554)',
      'perf(token-prices): DISTINCT ON latest-price lookup to avoid full scans',
    ]) {
      expect(earnsAReleaseNote(parseSubject(subject) as never)).toBe(true);
    }
  });

  /**
   * The hidden half. These land on `main` in every release window and
   * release-please renders none of them, so expecting an entry for one would
   * block a release over a commit that was never going to be listed.
   */
  test('excludes the types release-please hides', () => {
    for (const subject of [
      'docs(release): two ways a fix goes missing from the notes (SC-572)',
      'test(e2e): amount is a decimal string on the wire (SC-567)',
      'chore(main): release 0.16.0',
      'refactor(db): fold the two repositories together',
      'ci: pin the checkout action',
    ]) {
      expect(earnsAReleaseNote(parseSubject(subject) as never)).toBe(false);
    }
  });

  test('a breaking change earns an entry whatever its type', () => {
    expect(earnsAReleaseNote(parseSubject('refactor!: drop the v2 dashboard') as never)).toBe(true);
    expect(earnsAReleaseNote(parseSubject('chore(api)!: remove the legacy route') as never)).toBe(
      true
    );
  });

  /**
   * SC-572's second cause. A plain-sentence subject is what release-please
   * logs `commit could not be parsed` for, at debug level, before carrying
   * on. `483e269c` is the real one, from this same window.
   */
  test('a plain sentence does not parse at all', () => {
    expect(
      parseSubject('The self-hosted SPA sends no security headers at all (SC-561)')
    ).toBeNull();
    expect(parseSubject('Merge pull request #170 from MGrin/oss/sc-567-dust-balance')).toBeNull();
  });
});

describe('reading the changelog', () => {
  test('finds the section for the version being released', () => {
    expect(extractVersionSection(`# Changelog\n\n${AFTER_REPAIR}`, '0.16.0')).toContain(
      'reconcile hidden holdings'
    );
  });

  /**
   * The blindness input. If the top section is some other version,
   * release-please has not written the new one yet and there is nothing to
   * compare — the caller exits 3 rather than differencing against the
   * PREVIOUS release's bullets, which would report every commit in the window
   * as missing and read as a spectacular defect.
   */
  test('refuses a top section that is not the version being released', () => {
    expect(extractVersionSection(`# Changelog\n\n${AFTER_REPAIR}`, '0.17.0')).toBeNull();
    expect(extractVersionSection('# Changelog\n\nNo release has been cut.', '0.16.0')).toBeNull();
  });
});

/**
 * SC-735. The subjects below are the real ones from `MGrin/scani-oss`, in the
 * v0.23.0..v0.23.1 window and in the v0.15.0..v0.16.0 one. They are what the
 * notice groups on, and the last case is the reason it only GROUPS.
 */
describe('grouping the unparseable by sibling coverage', () => {
  test('names the sibling that covers the work, rather than just answering yes', () => {
    // 26b209ba7 "Declare the e2e database target in CI" — a branch commit of
    // #281, merged with a merge commit, so its two siblings are in the window.
    expect(
      releasableSibling([
        "fix(e2e): resolve the stack's database instead of assuming `scani`",
        'fix(e2e): name the docker escape hatch, and document the vars it needs',
      ])
    ).toBe("fix(e2e): resolve the stack's database instead of assuming `scani`");
  });

  test('a squashed pull request has no siblings by construction', () => {
    // 8682f5147 and 5c8ec6dbe both landed as one commit each. There is nothing
    // for the caveat to point at, which is what puts them first in the notice.
    expect(releasableSibling([])).toBeNull();
  });

  test('a sibling that parses but earns no entry does not count as cover', () => {
    expect(
      releasableSibling(['docs(scripts): say when the duplication caveat cannot apply'])
    ).toBeNull();
    expect(releasableSibling(['chore(deps): bump release-please'])).toBeNull();
    expect(releasableSibling(['Collapse STRAY_BUILD onto one line to satisfy biome'])).toBeNull();
  });

  test('a releasable sibling is found among ones that are not — the control', () => {
    expect(
      releasableSibling([
        'chore(deps): bump release-please',
        'Collapse STRAY_BUILD onto one line to satisfy biome',
        'fix(guards): see a prescribed script written without run',
      ])
    ).toBe('fix(guards): see a prescribed script written without run');
  });

  test('THE LIMIT: a null here is not a claim that the work is uncovered', () => {
    // `483e269c` is the case this file's header cites as legitimately covered.
    // It is alone on its pull request, so the signal says null — while its real
    // cover, `050fbc63`, merged 49 minutes later on a DIFFERENT pull request.
    // A predicate keying on this would red on a correct changelog; the notice
    // therefore orders and never judges. If this expectation ever flips, the
    // notice's stated limit is wrong and its wording has to change with it.
    expect(releasableSibling([])).toBeNull();
    expect(
      releasableSibling([
        'fix(self-host): serve the nine security headers the nginx image never sent',
      ])
    ).not.toBeNull();
  });
});
