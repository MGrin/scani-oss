# @scani/queue

Async-coordination framework on top of BullMQ + Redis. Pure
infrastructure — no business knowledge of which jobs scani runs.

The framework gives consumers:

- **Abstract bases** for processors (`UserJobProcessor`,
  `ScheduledJobProcessor`) and the producer (`EnqueueService`)
- **Concrete `@Service()` impls** that wire BullMQ for them
  (`QueueClient`, `WorkerClient`, `JobScheduler`,
  `BullMqEnqueueService`, `RedisLifecyclePublisher`,
  `RedisResourceLock`)
- **Interfaces / Tokens** for plugging the domain in (`EnqueueMirror`,
  `LifecycleMirror`, `JobLock`)
- **A descriptor contract** (`UserJobDescriptor`,
  `ScheduledJobDescriptor`) — the consumer's per-job catalog (in
  `@scani/jobs`) speaks this shape, the framework dispatches against it

The "what jobs we have" lives in
[`@scani/jobs`](../../business/jobs/README.md). This package never
mentions `wallet-import` or `pricing` or any other scani-specific job.

## Public surface

| Export | Kind | Used by |
|---|---|---|
| `EnqueueService` (abstract) | contract | tests / alt impls |
| `BullMqEnqueueService` `@Service()` | producer | api routers, worker chain-enqueue |
| `QueueClient` `@Service()` | producer | both apps configure once at boot |
| `JobScheduler` `@Service()` | producer | worker boot — registers cron descriptors |
| `EnqueueMirror` interface + `ENQUEUE_MIRROR` token | extension point | domain provides impl |
| `UserJobProcessor<TPayload, TResult>` (abstract) | consumer | each user-initiated processor extends |
| `ScheduledJobProcessor` (abstract) | consumer | each cron processor extends |
| `WorkerClient` `@Service()` | consumer | worker boot — owns Worker + DLQ |
| `LifecycleMirror` interface + `LIFECYCLE_MIRROR` token | extension point | domain provides impl |
| `JobLock` (abstract) + `JOB_LOCK` token | extension point | domain provides PG-advisory impl |
| `LifecyclePublisher` (abstract) + `RedisLifecyclePublisher` `@Service()` | infra | wires Redis pub/sub for WS fan-out |
| `ResourceLock` (abstract) + `RedisResourceLock` `@Service()` | infra | per-resource SET-NX lock |
| `ResultTruncator` | infra | result-payload size cap (32KB default) |
| `UserJobDescriptor<TPayload, TResult>` | contract | per-job catalog speaks this shape |
| `ScheduledJobDescriptor` | contract | same, for cron jobs |
| `LifecycleEvent`, `EnqueuedJobMeta`, `ProcessorContext`, `JobEventPayload`, `JobLifecycleState`, `UserJobBase` | types | |
| `DEFAULT_QUEUE_NAME = 'scani-jobs'` / `DEFAULT_DLQ_NAME = 'scani-dlq'` | constants | overridable via `QueueClient.configure({ queueName })` |

## How a job flows through the framework

### Producer side (`apps/backend/api`)

1. A tRPC router resolves `Container.get(BullMqEnqueueService)`.
2. It calls `.add(WALLET_IMPORT, payload)`. `WALLET_IMPORT` is a
   `UserJobDescriptor` from `@scani/jobs` carrying the zod schema, the
   retry policy, the deterministic-jobId strategy, and the payload
   summarizer.
3. `BullMqEnqueueService` computes `jobId = descriptor.computeJobId(payload)`
   (so accidental double-clicks dedup natively in BullMQ).
4. If an `EnqueueMirror` is registered (the domain provides one in
   `@scani/jobs`), the framework calls `mirror.onEnqueued(meta)` to
   insert the durable mirror row before BullMQ.add, then catches any
   add failure and calls `mirror.onEnqueueFailed(...)` so the UI
   surfaces a hard fail rather than a phantom queued row.
5. The router returns the jobId to the client.

### Consumer side (`apps/backend/worker`)

1. Worker boot calls `Container.get(QueueClient).configure({ connection })`
   and `Container.get(WorkerClient).configure({ connection, concurrency })`.
2. Boot calls `Container.get(RedisLifecyclePublisher).configure(redis)`
   and `Container.get(RedisResourceLock).configure(redis)`.
3. Boot iterates every `@Service()`-registered processor class and calls
   `workerClient.register(processor)`. Each processor's `descriptor.name`
   becomes its dispatch key.
4. Boot calls
   `Container.get(JobScheduler).upsertAll(SCHEDULED_JOB_DESCRIPTORS)` —
   reconciles repeatable schedules (upserts wanted, deletes orphans).
5. Boot calls `await workerClient.start()` — this is the only place
   the BullMQ `Worker` instance comes into existence. After this point
   `register()` throws (BullMQ doesn't support hot-swap of the
   processor closure).
6. When BullMQ delivers a job, `WorkerClient` looks up the processor
   by `job.name` and calls `processor.process(job)`.
7. `UserJobProcessor.process()` runs zod validation against
   `descriptor.schema`, fires `LifecycleMirror.onLifecycle('active')` +
   publishes to Redis pub/sub, calls the subclass's `handle(data, ctx)`,
   then on success/failure fires the `'completed'` / `'failed'` events
   and re-throws any caught error **without wrapping** so BullMQ's
   `UnrecoverableError` keeps its `instanceof` identity.
8. `ScheduledJobProcessor.process()` is simpler — when
   `descriptor.lockName` is set, wraps `handle()` in
   `JobLock.withLock(lockName, ...)`. When the lock is held, returns
   silently (the next cron tick runs anyway).

### Lifecycle wire shape

`RedisLifecyclePublisher` formats its message to match
`@scani/realtime`'s `RealTimeUpdatesService` envelope verbatim, so the
WS server's psubscribe handler forwards it to the user's local WS
topic without special-casing jobs. Channel pattern: `rt:user:<userId>`.
Don't change the message shape without coordinating with `@scani/realtime`.

State → operationType mapping:

| `JobEventPayload.state` | `operationType` |
|---|---|
| `queued` | `create` |
| `active` / `progress` | `update` |
| `completed` | `sync` |
| `failed` | `delete` |

### DLQ + Sentry

`WorkerClient` owns DLQ pushes (generic infra) and exposes
`onTerminalFailure(hook)` for application policy (Sentry capture). DLQ
pushes only fire when `job.attemptsMade >= job.opts.attempts`
(BullMQ-exhausted retries). Sentry hooks skip
`UnrecoverableError`-typed causes — those are user-facing by-design
failures, surfaced via `/jobs`; paging Sentry for them buries real
bugs in noise.

## Adding a new async job

The framework doesn't change. Drop a new descriptor + processor:

1. **Define the descriptor** in `packages/business/jobs/src/user-jobs/<name>.ts`
   (or `scheduled-jobs/<name>.ts`) — payload type + zod schema + retry
   policy + jobId + summarizer.
2. **Add it to** `USER_JOB_DESCRIPTORS` (or
   `SCHEDULED_JOB_DESCRIPTORS`) in the corresponding
   `index.ts` registry.
3. **Write a processor class** in
   `apps/backend/worker/src/processors/<name>.ts`:
   ```ts
   @Service()
   export class FooProcessor extends UserJobProcessor<FooPayload, FooResult> {
     readonly descriptor = FOO;
     private readonly useCase = Container.get(FooUseCase);
     protected async handle(data: FooPayload): Promise<FooResult> {
       return this.useCase.execute(data);
     }
   }
   ```
4. **Add the class to the worker boot's** `resolveProcessors()` in
   `apps/backend/worker/src/index.ts`.
5. **Producer side** (api router): `Container.get(BullMqEnqueueService).add(FOO, payload)`.

That's it — no edits to `@scani/queue`.

## Why abstracts + concretes (not just concrete classes)

Tests stub the abstracts; the concrete impls are wired against BullMQ
+ Redis. Without the abstract layer, every test file would carry a
mock `bullmq` shim. The abstract+concrete split also documents the
extension surface — anything users would plug their own impl into
(JobLock, LifecycleMirror, EnqueueMirror) lives behind an interface.

## Error semantics

- **Validation failure**: `UserJobProcessor.process()` throws *before*
  any lifecycle event. BullMQ marks the job failed; no `active` /
  `completed` events fire. Justified: validation failures are bugs
  (sender + receiver disagree on the wire shape), not transient.
- **Handler success**: `'completed'` event fires with the truncated
  result payload; the result is also returned from `process()` so
  BullMQ's `removeOnComplete` cleanup honours it.
- **Handler throw**: `'failed'` event fires with the error message,
  then the error is **re-thrown without wrapping**. Critical for
  `UnrecoverableError` — BullMQ detects this via `instanceof` to
  short-circuit retries.
- **Lifecycle mirror throw**: swallowed and logged. The job continues.
  The mirror is for durable tracking; broken tracking shouldn't fail
  the work.
- **Publisher throw**: swallowed and logged. The WS event is
  best-effort; durable state is in BullMQ + the mirror table.
- **Scheduled job lock contention**: `ScheduledJobProcessor.process()`
  returns silently. The job is marked completed (no work was needed).
  The next cron tick runs anyway.

## Configuration

Both `QueueClient` and `WorkerClient` are explicitly configured at
boot rather than reading env. The framework has no opinion about Redis
endpoints or queue names — apps own that wiring.

## Why DLQ stays in the framework

The DLQ push (on `job.attemptsMade >= job.opts.attempts`) is generic
infra — every BullMQ deployment wants this so failures aren't lost
when `removeOnFail` lattice eventually truncates them. Application
policy (Sentry capture, paging) plugs in via `onTerminalFailure(hook)`
without polluting the framework with vendor-specific tags.

## Tests

`bun test --preload ./packages/business/domain/test-preload.ts packages/infra/queue --timeout 30000`

Stubbed-DI pattern throughout — no Redis or Postgres needed. The
abstract bases let tests inject capturing implementations of every
extension point.
