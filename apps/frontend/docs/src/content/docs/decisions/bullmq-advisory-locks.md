---
title: Why BullMQ + Postgres advisory locks
description: BullMQ handles the queue and retry semantics. Postgres advisory locks handle cron idempotency. Two specialised tools, one job each.
sidebar:
  order: 8
---

## The decision

Every async job in Scani — scheduled (`pricing`, `wallet-balances`,
`portfolio-value-rollup`, `transfer-linking`, …) and user-initiated
(`screenshot-parse`, `exchange-import`, `wallet-import`, …) — runs
through one queue (`scani-jobs`) on **BullMQ over Redis**, consumed by
`apps/backend/worker`. For *scheduled* jobs, each processor wraps
its work in a **Postgres advisory lock** so two overlapping fires of
the same job-name silently no-op rather than racing.

## The alternatives we rejected

- **A cron container** that runs job scripts on schedule. Simple, but
  loses retry semantics, observability, and the ability to
  distribute load across multiple worker pods. Two replicas of the
  cron container would also race on the same minute.
- **Use BullMQ's built-in repeatable jobs without an advisory lock.**
  Closer, but `upsertJobScheduler` does not guarantee single-fire if
  multiple workers were started simultaneously, and Redis-only locks
  have failure modes (split-brain on a Redis failover) that an
  advisory lock against the *same* Postgres the job will write to
  doesn't share.
- **An advisory lock around all work, no queue.** Loses retry,
  visibility, DLQ — all the BullMQ tooling for the failure modes
  that actually happen.

## Why this combo

**BullMQ is right for the queue layer.** Retries with backoff, DLQ,
priority, delays, repeatable schedules, dashboards — they exist,
work, and aren't worth rebuilding. The api is the producer; the
worker is the consumer; everything goes through Redis. The retry
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
  hit Postgres, the lock is in Postgres. No two-phase reasoning
  about Redis vs Postgres availability.
- **Operator tooling reuses the queue.** HMAC-gated job endpoints on
  the api can retry a failed job, replay a DLQ message, or kick off
  an out-of-schedule run — the same BullMQ that runs everything
  else.

## What the design costs

- **Two systems instead of one.** Redis for the queue, Postgres for
  the lock. Both are already required infrastructure (Redis powers
  BullMQ + rate-limiter; Postgres is the database) so the cost is
  primarily mental.
- **The advisory-lock helper has to be applied per scheduled
  processor.** Not on by default — a contributor adding a new
  scheduled job has to remember. The
  [Adding a scheduled job](/contributing/adding-a-job/) guide
  documents the pattern.

## What this rules out

- A second queue framework (Bull v3, Bee Queue, custom Redis
  Streams) for some subset of jobs. Everything goes through BullMQ.
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
