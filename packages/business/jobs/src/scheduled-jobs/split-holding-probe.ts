import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Nightly integrity probe: finds upstream events recorded against more than
// one holding of the same (account, token), and escalates to Sentry.
//
// `holding_tx_dedup` is UNIQUE(holding_id, source, external_id) — per HOLDING.
// A position split across two rows can therefore carry the same event twice,
// once on each, and no constraint objects. Nothing detected this: each holding
// reconciles to its own synthesized opening anchor, so every per-holding
// consistency check passes while the money is counted twice. SC-239 sat in
// production for months on exactly that (24 Airwallex events, 44,340.05 USD)
// and was found by hand while working an unrelated ticket.
//
// Runs at 04:30, after the nightly chain (historical-price-backfill 03:00,
// forex 03:30, transfer-linking 03:45, portfolio-value-rollup 04:00) has
// finished writing — the probe audits the day's settled state rather than
// racing it. The advisory lock keeps two machines from double-firing the
// Sentry alert; the read itself is a single indexed aggregate.
export const SPLIT_HOLDING_PROBE_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.splitHoldingProbe,
  cron: '30 4 * * *',
  lockName: JOB_NAMES.splitHoldingProbe,
};
