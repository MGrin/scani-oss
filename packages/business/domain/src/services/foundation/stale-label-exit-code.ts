/** What the exit status reads of a stale-label report: a listing is one that did not apply. */
interface StaleLabelOutcome {
  apply: boolean;
  stale: readonly unknown[];
  failedUsers: readonly unknown[];
}

/**
 * The exit status of the operator's stale-label run for this report. A failed
 * user is 1 and takes precedence. An apply that left a label stale with no
 * user failed is 2: nothing went wrong and the ledger is not settled, which a
 * rehearsal's bar of none afterwards must not pass on a 0. A dry run or a
 * listing writes nothing, so its stale list is what it was asked for: 0.
 */
export function staleLabelExitCode(outcome: StaleLabelOutcome): 0 | 1 | 2 {
  if (outcome.failedUsers.length > 0) return 1;
  return outcome.apply && outcome.stale.length > 0 ? 2 : 0;
}
