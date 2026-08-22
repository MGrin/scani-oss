---
title: Why BullMQ + Postgres advisory locks
description: BullMQ handles the queue and retry semantics. Postgres advisory locks handle cron idempotency. Both now sit on the same Postgres.
sidebar:
  order: 8
---

## The decision

Every async job in Scani — scheduled (`pricing`, `wallet-balances`,
`portfolio-value-rollup`, `transfer-linking`, …) and user-initiated
(`screenshot-parse`, `exchange-import`, `wallet-import`, …) — runs
through one queue (`scani-jobs`) on **BullMQ over Postgres**,
consumed by `apps/backend/worker`. For *scheduled* jobs, each
processor wraps its work in a **Postgres advisory lock** so two
overlapping fires of the same job-name silently no-op rather than
racing.

:::note[The queue used to be on Redis]
BullMQ v6 added a Postgres backend and Scani moved onto it. The
decision on this page did not change — BullMQ for queue semantics,
advisory locks for cron idempotency — but the storage did, and the
"two systems" cost below is now smaller than it was. Redis is still
required for realtime pub/sub and the rate limiters; it just no
longer holds a job.
:::

## The alternatives we rejected

- **A cron container** that runs job scripts on schedule. Simple, but
  loses retry semantics, observability, and the ability to
  distribute load across multiple worker pods. Two replicas of the
  cron container would also race on the same minute.
- **Use BullMQ's built-in repeatable jobs without an advisory lock.**
  Closer, but `upsertJobScheduler` does not guarantee single-fire if
  multiple workers were started simultaneously. When this was
  decided the alternative lock was a Redis one, which had failure
  modes (split-brain on a Redis failover) an advisory lock against
  the *same* Postgres the job will write to does not share. That
  argument now also applies to the queue itself.
- **An advisory lock around all work, no queue.** Loses retry,
  visibility, DLQ — all the BullMQ tooling for the failure modes
  that actually happen.

## Why this combo

**BullMQ is right for the queue layer.** Retries with backoff, DLQ,
priority, delays, repeatable schedules, dashboards — they exist,
work, and aren't worth rebuilding. The api is the producer; the
worker is the consumer; everything goes through the `bullmq`
schema in the same Postgres as the application data. The retry
contract is enforced uniformly.

**Postgres advisory locks are right for the idempotency layer.** A
scheduled job (`pricing` at the top of every hour) might fire from
BullMQ's repeatable scheduler once. But if the worker pod was
restarted at the same instant, you could race two fires. An
advisory lock against the relevant Postgres row guarantees only one
runs to completion — and **shares the failure domain with the data
it's about to write**. If Postgres is down, both the lock attempt
and the work would fail; if the lock succeeds, the work can proceed.
A Redis-only lock could grant the lock while Postgres is unreachable,
leading to a half-completed run on a partial connection.

The advisory-lock helper is `apps/backend/worker/src/lib/cron-lock.ts`
— wrap a scheduled-job handler with it and overlapping fires of the
same job name silently no-op.

## What this design unlocks

- **One queue.** No per-job-type queues, no per-priority queues. One
  `scani-jobs` queue + one `scani-dlq`. Simpler ops.
- **One worker binary.** Every job processor lives in
  `apps/backend/worker/src/processors/`. Scale by adding worker
  pods.
- **Cron isn't a separate service.** Repeatable schedules live in
  `packages/business/jobs/src/scheduled-jobs/` as descriptors; the
  worker registers them with BullMQ at boot via `upsertJobScheduler`.
  No cron container, no cron config file.
- **Failure shares a domain with the data.** When work is about to
  hit Postgres, the lock is in Postgres — and, since the backend
  move, so is the queue. A worker cannot dequeue a job it will then
  be unable to write, because reaching the queue and reaching the
  data are now the same reachability question.
- **Operator tooling reuses the queue.** HMAC-gated job endpoints on
  the api can retry a failed job, replay a DLQ message, or kick off
  an out-of-schedule run — the same BullMQ that runs everything
  else.

## What the design costs

- **Postgres carries queue load as well as application load.** The
  queue and the data now contend for the same connection pool and
  the same instance. That is the trade for the single failure
  domain above; size the pool accordingly
  (`POSTGRES_POOL_MAX`). Redis is still required infrastructure —
  rate limiters and realtime pub/sub — so it is one fewer *failure
  domain*, not one fewer *service*.
- **The advisory-lock helper has to be applied per scheduled
  processor.** Not on by default — a contributor adding a new
  scheduled job has to remember. The
  [Adding a scheduled job](/contributing/adding-a-job/) guide
  documents the pattern.

## What this rules out

- A second queue framework (Bull v3, Bee Queue, custom Redis
  Streams, a bare `SELECT … FOR UPDATE SKIP LOCKED` table) for some
  subset of jobs. Everything goes through BullMQ.
- A separate cron service. Repeatable schedules live in code, are
  registered by the worker at boot, and run on the worker pod.
- "Singleton" job processors that assume only one worker pod exists.
  The advisory lock makes the assumption explicit and enforceable.

## See also

- [Engineering conventions](/contributing/conventions/)
- [Adding a scheduled job](/contributing/adding-a-job/)
- [Job catalogue](/reference/jobs/)
- [Glossary: BullMQ](/reference/glossary/#bullmq),
  [advisory lock](/reference/glossary/#advisory-lock)
