/**
 * That a baseline is a picture of the fixtures, and not of somebody's data
 * (SC-842).
 *
 * ## The blind spot this sits in
 *
 * `apps/e2e/visual/__screenshots__/` ships to the public mirror. Every guard
 * standing between this repository and that one reads TEXT — the path
 * classifier, the internal-reference scanner, the figure scanner, the secret
 * scan. A PNG is the outer edge of what all four can do: it carries no line
 * for a pattern to match, so it is skipped, and until SC-842 the skip was
 * reported under the word `PASS`. That word is fixed; the blindness is not
 * fixable, because a screenshot of an account name is a screenshot.
 *
 * So the checkable claim is not about the image. It is about the INPUT, and
 * the input is text: a baseline is a picture of one signed-in user's data at
 * capture time, and this repository declares exactly what that user is
 * supposed to hold. Asserting the declaration against what the session
 * actually holds — before a single pixel is captured — is a provenance claim,
 * and provenance is the only kind of claim available here.
 *
 * ## The hole it closes, which is not hypothetical
 *
 * `visual-setup.ts` reuses a stored session across runs, deliberately: the api
 * rate-limits sign-ins to 6 per IP per hour and three sessions is most of that
 * budget. The reuse test was `isSignedIn` — one request, asking only whether
 * the cookie still works. **A session that is signed in is not a session that
 * still holds what it was seeded with**, and on the reuse path the seed does
 * not run again, so nothing re-established what the next `--update` would
 * photograph. The account behind a stored session is whatever it has drifted
 * into since it was made.
 *
 * The neighbouring failure is on the record. `scripts/visual.ts` derives this
 * checkout's ports rather than defaulting to 5173/3011 because the fixtures'
 * defaults are the PRIMARY checkout's — so from a linked worktree the harness
 * "did not fail to find a stack, it found somebody else's, signed in against
 * it and seeded a portfolio into the database they were working in" (SC-495).
 * That was fixed by pinning the ports. Nothing yet asserts the CONTENT the
 * pinning is supposed to guarantee, and `PLAYWRIGHT_BASE_URL` and
 * `API_BASE_URL` are still honoured from the environment because an operator
 * driving several stacks has a reason.
 *
 * ## Why holdings, rather than accounts
 *
 * The observation is `holdings.getWithDetails` — the same request
 * `visual-setup.ts` already makes to decide whether a stored session is live,
 * so this costs no extra round trip and adds no new coupling. It is also the
 * better axis: every screen in `screens.ts` renders holdings or a total
 * derived from them, and home chooses between its onboarding panel and its
 * portfolio on the holdings count. An account with no holdings under it
 * changes no baseline, and this check correctly cannot see one.
 *
 * ## Why it throws rather than warning
 *
 * A run whose provenance cannot be established must produce no baseline, and
 * `globalSetup` throwing is what makes that true — the capture never starts.
 *
 * **The escape hatch is `VISUAL_FRESH=1`, and it already exists.** That forces
 * a new user and a new seed, which does not waive the check: it makes the
 * check pass by making the claim true. An escape hatch is a safety property
 * only while using it means asserting something you believe, and this one is
 * better than that — using it is the repair. There is deliberately no flag
 * that says "capture anyway".
 *
 * ## What it does not claim
 *
 * That the stack is the right one, that the renderer is the container, or that
 * a committed PNG was produced by this harness at all. It says that the
 * session this run is about to photograph holds what the fixtures declare and
 * nothing else. A hand-placed PNG is out of reach of every check in this
 * repository and is a review question.
 */

/** What a visual session is declared to hold, derived from the seed itself. */
export interface SessionContent {
  /** Account names, in no particular order. Compared as a set. */
  readonly accounts: readonly string[];
  /** How many holdings the seed creates in total. */
  readonly holdings: number;
}

/** What the api says the session actually holds. */
export interface ObservedContent {
  readonly accounts: readonly string[];
  readonly holdings: number;
}

export interface ProvenanceInput {
  /** The session name, for the message. */
  readonly session: string;
  readonly expected: SessionContent;
  readonly observed: ObservedContent;
}

function sorted(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

/**
 * The refusal these two readings earn, or `null` if the session is what it was
 * declared to be.
 *
 * Pure, and separated from the request that feeds it, so both arms are
 * reachable from a unit test on a machine with no stack and no Docker. A guard
 * whose firing path has never been executed is indistinguishable from one that
 * cannot fire — which is this whole file's subject, one level up.
 *
 * Set equality in BOTH directions. An account the declaration does not name is
 * as much a provenance failure as one it names and the session has lost: the
 * question is not *does this look roughly right* but *is this the seed*.
 */
export function provenanceFailure(input: ProvenanceInput): string | null {
  const { session, expected, observed } = input;
  const want = sorted(expected.accounts);
  const got = sorted(observed.accounts);

  const unexpected = got.filter((name) => !want.includes(name));
  const missing = want.filter((name) => !got.includes(name));
  const countWrong = observed.holdings !== expected.holdings;
  if (unexpected.length === 0 && missing.length === 0 && !countWrong) return null;

  const lines = [
    `the "${session}" visual session does not hold what the fixtures declare, so a ` +
      'baseline captured under it would be a picture of something this repository ' +
      'has not described.',
    '',
    `  declared  ${expected.holdings} holding(s) across ${want.length} account(s): ${want.join(', ') || '(none)'}`,
    `  found     ${observed.holdings} holding(s) across ${got.length} account(s): ${got.join(', ') || '(none)'}`,
  ];
  if (unexpected.length > 0) lines.push(`  NOT DECLARED: ${unexpected.join(', ')}`);
  if (missing.length > 0) lines.push(`  MISSING: ${missing.join(', ')}`);
  lines.push(
    '',
    '  These baselines ship to the public mirror and no text guard can read one, so',
    '  what a picture SHOWS is only ever as trustworthy as the fixture it was',
    '  rendered from (SC-842). Nothing has been captured.',
    '',
    '  The likely cause is a stored session that has drifted: it is reused across',
    '  runs for the api sign-in budget, and the seed does not run again on the reuse',
    '  path. Re-run with VISUAL_FRESH=1 to sign a new user in and reseed it.',
    '',
    '  If it still disagrees after that, the stack is not the one this checkout',
    '  publishes — check PLAYWRIGHT_BASE_URL and API_BASE_URL.'
  );
  return lines.join('\n');
}
