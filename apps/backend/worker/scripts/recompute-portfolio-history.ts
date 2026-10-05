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
// Enqueues one PORTFOLIO_HISTORY_BACKFILL per selected user with no price
// backfill (`tokenIds: []`), which the worker runs under its per-user lock.
// The window is per cohort: `trade-fees` and `stored-history` rewrite the full
// 400-day window, and `sweep-hidden` and `fee-rows` each user's whole history, back to their
// earliest ledger row, balance reading or stored day. Every
// `portfolio_value_daily` row in that window is recomputed for every selected
// user — against production that is a production data rewrite.
//
// Running it twice is safe: each cohort has one request id, which fixes each
// user's job id, and a user whose job completed or is still in flight is
// skipped.
//
// Lives here rather than at the repo root because it needs `@scani/domain`'s
// DI container and a queue client, which the worker already boots.
//

import 'reflect-metadata';
import { PortfolioValueDailyRepository } from '@scani/domain/repositories';
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
  'sweep-hidden': 'sc1546-sweep-hidden-ledger',
  'fee-rows': 'sc1561-fee-rows',
};

// A change to how the walk treats a ledger row moves every day after that
// row's first, so these cohorts rewrite each user's whole history.
const WHOLE_HISTORY: ReadonlySet<HistoryRecomputeCohort> = new Set(['sweep-hidden', 'fee-rows']);

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flagValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
// An argument the script does not read is refused, not ignored: `--user=<id>`
// or a mistyped `--apply` would otherwise run as if it were not there.
const VALUE_FLAGS = ['--user', '--cohort'];
const unknownArgs = args.filter(
  (arg, i) =>
    arg !== '--apply' && !VALUE_FLAGS.includes(arg) && !VALUE_FLAGS.includes(args[i - 1] ?? '')
);
if (unknownArgs.length > 0) {
  console.error(`unknown argument: ${unknownArgs.join(' ')}`);
  process.exit(1);
}
const userId = flagValue('--user');
// The planner reads an absent or empty id as no narrowing at all, so `--user`
// with nothing after it would recompute the whole cohort.
if (args.includes('--user') && (!userId || userId.startsWith('-'))) {
  console.error('--user needs a user id after it');
  process.exit(1);
}
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

const payloadFor = (id: string, lookbackDays = PORTFOLIO_HISTORY_LOOKBACK_DAYS) => ({
  userId: id,
  requestId,
  tokenIds: [],
  lookbackDays,
});

const since = new Date(Date.now() - PORTFOLIO_HISTORY_LOOKBACK_DAYS * 86_400_000);
const plan = await Container.get(PlanHistoryRecomputeUseCase).execute({
  cohort,
  jobIdFor: (id) => PORTFOLIO_HISTORY_BACKFILL.computeJobId(payloadFor(id)),
  since,
  userId,
});

// The job id is the user and the request id, so the window can be read after
// the plan, and only for the users about to be enqueued.
const lookbackByUser = new Map<string, number>();
if (WHOLE_HISTORY.has(cohort)) {
  const dailyRepository = Container.get(PortfolioValueDailyRepository);
  for (const id of plan.toEnqueue) {
    lookbackByUser.set(
      id,
      await dailyRepository.findHistoryLookbackDays(id, PORTFOLIO_HISTORY_LOOKBACK_DAYS)
    );
  }
}

console.log(apply ? '--- applying ---' : '--- dry run, nothing enqueued ---');
console.log(`cohort                               ${cohort} (request id ${requestId})`);
console.log(
  `users selected                       ${plan.completed.length + plan.inFlight.length + plan.toEnqueue.length}`
);
console.log(`  already recomputed (skipped)       ${plan.completed.length}`);
console.log(`  recompute in flight (skipped)      ${plan.inFlight.length}`);
console.log(`  would be enqueued                  ${plan.toEnqueue.length}`);
if (lookbackByUser.size > 0) {
  const days = [...lookbackByUser.values()];
  console.log(`lookback days                        ${Math.min(...days)}..${Math.max(...days)}`);
}

if (!apply) process.exit(0);

// `@scani/jobs` registers the mirror that writes the `user_jobs` row this
// script reads on its next run. Without it every enqueue succeeds and a re-run
// enqueues everyone again, so its absence refuses here rather than at the end.
Container.get(QueueClient).configure({ connection: databaseUrl });
assertQueueBindings(['enqueue-mirror']);

const enqueue = Container.get(BullMqEnqueueService);
let enqueued = 0;
for (const id of plan.toEnqueue) {
  await enqueue.add(PORTFOLIO_HISTORY_BACKFILL, payloadFor(id, lookbackByUser.get(id)));
  enqueued += 1;
  if (enqueued % 50 === 0) console.log(`  enqueued ${enqueued} of ${plan.toEnqueue.length}`);
}
console.log(`enqueued                             ${enqueued}`);

await Container.get(QueueClient).close();
process.exit(0);
