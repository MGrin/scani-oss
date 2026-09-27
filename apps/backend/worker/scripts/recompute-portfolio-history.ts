#!/usr/bin/env bun

//
// One-shot re-roll of stored portfolio history for one cohort of users, after
// a change to how a past day is valued. See PlanHistoryRecomputeUseCase for
// the cohorts.
//
//   bun scripts/recompute-portfolio-history.ts --cohort stored-history                 # dry run
//   bun scripts/recompute-portfolio-history.ts --cohort stored-history --user <uuid>   # dry run, one user
//   bun scripts/recompute-portfolio-history.ts --cohort stored-history --apply         # enqueue
//
// Enqueues one PORTFOLIO_HISTORY_BACKFILL per selected user, over the full
// 400-day window and with no price backfill (`tokenIds: []`), which the worker
// runs under its per-user lock. Every `portfolio_value_daily` row in that
// window is recomputed for every selected user — against production that is a
// production data rewrite.
//
// Running it twice is safe: each cohort has one request id, which fixes each
// user's job id, and a user whose job completed or is still in flight is
// skipped.
//
// Lives here rather than at the repo root because it needs `@scani/domain`'s
// DI container and a queue client, which the worker already boots.
//

import 'reflect-metadata';
import '@scani/domain/repositories';
import '@scani/domain/services';
import { type HistoryRecomputeCohort, PlanHistoryRecomputeUseCase } from '@scani/domain/use-cases';
import { PORTFOLIO_HISTORY_BACKFILL, PORTFOLIO_HISTORY_LOOKBACK_DAYS } from '@scani/jobs';
import { assertQueueBindings, BullMqEnqueueService, QueueClient } from '@scani/queue';
import { Container } from 'typedi';

// One request id per cohort, never reused across cohorts: a user completed
// under one must still be selected by the next.
const REQUEST_IDS: Record<HistoryRecomputeCohort, string> = {
  'trade-fees': 'sc1142-trade-fees',
  'stored-history': 'sc1323-evidence-absent',
};

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flagValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const userId = flagValue('--user');
const cohortArg = flagValue('--cohort');
if (!cohortArg || !(cohortArg in REQUEST_IDS)) {
  console.error(`--cohort is required: one of ${Object.keys(REQUEST_IDS).join(', ')}`);
  process.exit(1);
}
const cohort = cohortArg as HistoryRecomputeCohort;
const requestId = REQUEST_IDS[cohort];

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const payloadFor = (id: string) => ({
  userId: id,
  requestId,
  tokenIds: [],
  lookbackDays: PORTFOLIO_HISTORY_LOOKBACK_DAYS,
});

const since = new Date(Date.now() - PORTFOLIO_HISTORY_LOOKBACK_DAYS * 86_400_000);
const plan = await Container.get(PlanHistoryRecomputeUseCase).execute({
  cohort,
  jobIdFor: (id) => PORTFOLIO_HISTORY_BACKFILL.computeJobId(payloadFor(id)),
  since,
  userId,
});

console.log(apply ? '--- applying ---' : '--- dry run, nothing enqueued ---');
console.log(`cohort                               ${cohort} (request id ${requestId})`);
console.log(
  `users selected                       ${plan.completed.length + plan.inFlight.length + plan.toEnqueue.length}`
);
console.log(`  already recomputed (skipped)       ${plan.completed.length}`);
console.log(`  recompute in flight (skipped)      ${plan.inFlight.length}`);
console.log(`  would be enqueued                  ${plan.toEnqueue.length}`);

if (!apply) process.exit(0);

// `@scani/jobs` registers the mirror that writes the `user_jobs` row this
// script reads on its next run. Without it every enqueue succeeds and a re-run
// enqueues everyone again, so its absence refuses here rather than at the end.
Container.get(QueueClient).configure({ connection: databaseUrl });
assertQueueBindings(['enqueue-mirror']);

const enqueue = Container.get(BullMqEnqueueService);
let enqueued = 0;
for (const id of plan.toEnqueue) {
  await enqueue.add(PORTFOLIO_HISTORY_BACKFILL, payloadFor(id));
  enqueued += 1;
  if (enqueued % 50 === 0) console.log(`  enqueued ${enqueued} of ${plan.toEnqueue.length}`);
}
console.log(`enqueued                             ${enqueued}`);

await Container.get(QueueClient).close();
process.exit(0);
