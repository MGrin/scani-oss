/**
 * How a feed's silence about a holding becomes a zero (A2 Task 14, R62). The
 * facts each mode carries are the provider's raw answer, rows the batch then
 * dropped included, because today's rules read that answer and not what
 * survived of it.
 *
 * `confirmed` is the exchange sync's (`HoldingsSyncHelper`): a provider that
 * returned no row at all zeroes nothing (SC-236).
 *
 * `immediate` is an integration import's: an absence zeroes on the first
 * answer, an empty one included. `reportedKeys` is every key the import named,
 * rows it skipped included, so an asset it reported at zero keeps its old
 * holding.
 *
 * In either mode a holding of the `confirmations` type zeroes only once it has
 * been missing from `statements` distinct statement days (SC-1451), on an
 * import as on the sync (A5 D-22, A2:1272). `statementAsOf` is the latest
 * instant any returned row was true at, and a zero is dated there (R60).
 */
export type AbsencePolicy =
  | {
      mode: 'confirmed';
      guardEmptySnapshot: true;
      confirmations: AbsenceConfirmations | null;
      providerRows: number;
      statementAsOf: Date;
    }
  | {
      mode: 'immediate';
      guardEmptySnapshot: false;
      confirmations: AbsenceConfirmations | null;
      reportedKeys: readonly string[];
      statementAsOf: Date;
    };

interface AbsenceConfirmations {
  typeCode: 'fiat';
  statements: number;
}

interface AbsenceCandidate {
  holdingId: string;
  /** What the reported keys name it by. Null is never reported. */
  key: string | null;
  typeCode: string;
  balance: string;
  absentFromStatements: readonly Date[] | null;
}

interface AbsenceDecision {
  zero: string[];
  /** Absences recorded short of confirmation: each holding's dates to write, and no zero. */
  tally: Map<string, Date[]>;
  /** Holdings whose recorded absences are cleared as they zero; each is in `zero`. */
  cleared: string[];
  /** Holdings whose absence could not be dated: neither tallied nor zeroed. */
  failed: Array<{ holdingId: string; error: string }>;
  guardTripped: boolean;
}

/**
 * The recorded absence dates plus this statement's, one per calendar day, so an
 * hourly re-read of one statement counts once. Today's `absentDates` verbatim:
 * an unreadable statement date throws once there is a recorded date to compare.
 */
function absentDates(prior: readonly Date[] | null, statementAsOf: Date): Date[] {
  const day = (d: Date) => new Date(d).toISOString().slice(0, 10);
  const dates = [...(prior ?? [])];
  if (!dates.some((d) => day(d) === day(statementAsOf))) dates.push(statementAsOf);
  return dates;
}

/** Which of `owned` the batch's silence zeroes or tallies. Pure: no clock, no I/O. */
export function confirmAbsences(input: {
  policy: AbsencePolicy;
  reportedKeys: ReadonlySet<string>;
  owned: readonly AbsenceCandidate[];
}): AbsenceDecision {
  const { policy, reportedKeys } = input;
  const decision: AbsenceDecision = {
    zero: [],
    tally: new Map(),
    cleared: [],
    failed: [],
    guardTripped: false,
  };
  if (policy.guardEmptySnapshot && policy.providerRows === 0) {
    decision.guardTripped = true;
    return decision;
  }
  const confirm =
    policy.confirmations !== null ? { ...policy.confirmations, asOf: policy.statementAsOf } : null;

  for (const holding of input.owned) {
    if (holding.key !== null && reportedKeys.has(holding.key)) continue;
    // Text, as today: a balance stored as '0.00' is zeroed again.
    if (holding.balance === '0') continue;
    if (confirm === null || holding.typeCode !== confirm.typeCode) {
      decision.zero.push(holding.holdingId);
      continue;
    }
    let dates: Date[];
    try {
      dates = absentDates(holding.absentFromStatements, confirm.asOf);
    } catch (error) {
      decision.failed.push({
        holdingId: holding.holdingId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (dates.length < confirm.statements) {
      decision.tally.set(holding.holdingId, dates);
      continue;
    }
    decision.cleared.push(holding.holdingId);
    decision.zero.push(holding.holdingId);
  }
  return decision;
}
