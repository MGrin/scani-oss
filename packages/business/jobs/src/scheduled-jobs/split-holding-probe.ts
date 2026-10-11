import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Nightly integrity probe: finds upstream events recorded against more than
// one holding of the same (account, token), and escalates to Sentry.
//
// `holding_tx_dedup` is UNIQUE(holding_id, source, external_id) — per HOLDING.
// A position split across two rows can therefore carry the same event twice,
// once on each, and no constraint objects. Nothing detected this: each holding
// reconciles to its own synthesized opening anchor, so every per-holding
// consistency check passes while the money is counted twice. SC-239 sat
// undetected for months on exactly that — an account's whole event history
// counted twice — and was found by hand while working an unrelated ticket.
//
// A step of the `nightly` group, after the rollup has finished writing
// (SC-1688) — the probe audits the day's settled state rather than
// racing it. The advisory lock keeps two machines from double-firing the
// Sentry alert; the read itself is a single indexed aggregate.
export const SPLIT_HOLDING_PROBE_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.splitHoldingProbe,
  lockName: JOB_NAMES.splitHoldingProbe,
};
