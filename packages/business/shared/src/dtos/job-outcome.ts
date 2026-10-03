/**
 * What a completed run actually produced, as two counts (SC-1527).
 *
 * BullMQ says "completed" when the worker returned without throwing, even if
 * every per-item outcome inside the result failed — a screenshot parse that
 * read none of its files, a manual create where every price fetch errored. The
 * job page read that off the full `result`; the jobs list never has the result
 * (SC-155) and badged the bare framework state, so one job read "Failed" on
 * its page and "Completed" in the list.
 *
 * The server reads these counts for every `jobs.listMine` row and the page
 * reads them off the result it already holds — through this one reader, so
 * the two surfaces cannot disagree about which runs failed.
 */

/** The jobs whose result carries per-item outcomes. Only these rows have
 *  their `result` read by the list query. */
export const OUTCOME_JOB_NAMES = [
  'screenshot-parse',
  'file-import',
  'manual-holdings-create',
] as const;

export interface JobOutcome {
  succeeded: number;
  failed: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function readJobOutcome(jobName: string, result: unknown): JobOutcome | null {
  const record = asRecord(result);
  if (!record) return null;

  if (jobName === 'screenshot-parse' || jobName === 'file-import') {
    const summary = asRecord(record.summary);
    if (!summary) return null;
    return { succeeded: count(summary.successCount), failed: count(summary.failureCount) };
  }

  if (jobName === 'manual-holdings-create') {
    if (!Array.isArray(record.holdings)) return null;
    const failed = record.holdings.filter((holding) => Boolean(asRecord(holding)?.error)).length;
    return { succeeded: record.holdings.length - failed, failed };
  }

  return null;
}

/** The state to show: a finished run that produced nothing and failed
 *  something is a failure, whatever the queue called it. */
export function outcomeState(state: string, outcome: JobOutcome | null | undefined): string {
  if (state !== 'completed' || !outcome) return state;
  return outcome.succeeded === 0 && outcome.failed > 0 ? 'failed' : state;
}
