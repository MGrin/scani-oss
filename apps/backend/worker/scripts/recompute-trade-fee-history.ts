#!/usr/bin/env bun

//
// One-shot for SC-1142: re-roll the stored portfolio history of every user
// whose ledger carries a trade fee, now that fees reach cost basis.
//
//   bun scripts/recompute-trade-fee-history.ts                  # dry run, enqueues nothing
//   bun scripts/recompute-trade-fee-history.ts --user <uuid>    # dry run, one user
//   bun scripts/recompute-trade-fee-history.ts --apply          # enqueue
//
// Enqueues one PORTFOLIO_HISTORY_BACKFILL per selected user, over the full
// 400-day window and with no price backfill (`tokenIds: []`), which the worker
// runs under its per-user lock. Every `portfolio_value_daily` row in that
// window is recomputed for every selected user — against production that is a
// production data rewrite, and it is confirmed with mgrin before `--apply`.
//
// Running it twice is safe: one request id for the whole recompute fixes each
// user's job id, and a user whose job completed or is still in flight is
// skipped. See PlanTradeFeeRecomputeUseCase.
//
// Lives here rather than at the repo root because it needs `@scani/domain`'s
// DI container and a queue client, which the worker already boots.
//

import 'reflect-metadata';
import '@scani/domain/repositories';
import '@scani/domain/services';
import { PlanTradeFeeRecomputeUseCase } from '@scani/domain/use-cases';
import { PORTFOLIO_HISTORY_BACKFILL, PORTFOLIO_HISTORY_LOOKBACK_DAYS } from '@scani/jobs';
import { assertQueueBindings, BullMqEnqueueService, QueueClient } from '@scani/queue';
import { Container } from 'typedi';

const REQUEST_ID = 'sc1142-trade-fees';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const userIndex = args.indexOf('--user');
const userId = userIndex >= 0 ? args[userIndex + 1] : undefined;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const payloadFor = (id: string) => ({
  userId: id,
  requestId: REQUEST_ID,
  tokenIds: [],
  lookbackDays: PORTFOLIO_HISTORY_LOOKBACK_DAYS,
});

const plan = await Container.get(PlanTradeFeeRecomputeUseCase).execute({
  jobIdFor: (id) => PORTFOLIO_HISTORY_BACKFILL.computeJobId(payloadFor(id)),
  userId,
});

console.log(apply ? '--- applying ---' : '--- dry run, nothing enqueued ---');
console.log(
  `users with a trade fee               ${plan.completed.length + plan.inFlight.length + plan.toEnqueue.length}`
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
