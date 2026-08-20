import { createComponentLogger } from '@scani/logging';
import { Container, type Token } from 'typedi';
import { JOB_HEARTBEAT_WRITER } from './consumer/job-heartbeat-writer';
import { JOB_LOCK } from './consumer/job-lock';
import { LIFECYCLE_MIRROR } from './consumer/lifecycle-mirror';
import { ENQUEUE_MIRROR } from './producer/enqueue-mirror';

const logger = createComponentLogger('queue:bindings');

/**
 * What a deployment can declare it requires (SC-298).
 *
 * ## The problem this exists for
 *
 * Four places in this package resolve an optional binding and swallow its
 * absence — `BullMqEnqueueService.tryGetMirror`,
 * `UserJobProcessor.tryGetMirror`, `ScheduledJobProcessor.tryGetLock` and
 * `tryGetHeartbeatWriter`. Each is `catch { return null }`, and each is
 * **correct**: a Tier-1 OSS deploy and the test suite legitimately have no
 * mirror, no lock and no heartbeat writer, and must not be forced to invent
 * one.
 *
 * The cost is that the same `null` also means *nobody imported
 * `@scani/jobs`*, and that is a defect. Registration there is a **decorator
 * side-effect** — `@Service({ id: ENQUEUE_MIRROR })` and friends — so it
 * happens only if the module is imported before anything resolves the
 * abstracts. Today that holds because two `CRITICAL:` comments and an import
 * ordering hold. On the managed deployment the failure is invisible: every
 * job runs with no `user_jobs` row, every scheduled job runs with no advisory
 * lock, and **nothing is logged at any level**.
 *
 * ## Why an opt-in assertion rather than a throw at the resolve site
 *
 * The framework cannot tell the two cases apart, and never will: whether
 * *this* deployment intends to mirror is knowledge only the app has. This
 * package is deliberately domain-free, so the declaration has to come from
 * the app and the framework's job is only to verify it.
 *
 * So the requirement is **opted into**, and the asymmetry is the point:
 *
 * - **OSS and the test suite call nothing and are unaffected** — no new env
 *   var, no new config, no new failure mode, no behaviour change. The default
 *   is exactly today's behaviour.
 * - The cost falls entirely on the deployment that has the requirement, which
 *   is the one place that knows it has one.
 *
 * It also moves the failure to the right moment. `CLAUDE.md` already states
 * this principle for the top-level-import rule — a lazy import "turns a boot
 * failure into a request-time failure, and moves a misconfiguration from the
 * log at startup to a user's screen an hour later". A missing mirror is that
 * same trade, and this puts it back at boot.
 *
 * And it replaces a comment with an executable line. Deleting
 * `import '@scani/jobs';` now fails boot with a message naming it, instead of
 * silently disabling every job record. A comment cannot do that, and in this
 * repo a comment is what failed last time (SC-272).
 */
export type QueueBinding = 'enqueue-mirror' | 'lifecycle-mirror' | 'job-lock' | 'heartbeat-writer';

const TOKENS: Record<QueueBinding, Token<unknown>> = {
  'enqueue-mirror': ENQUEUE_MIRROR,
  'lifecycle-mirror': LIFECYCLE_MIRROR,
  'job-lock': JOB_LOCK,
  'heartbeat-writer': JOB_HEARTBEAT_WRITER,
};

/** What each binding does, so the error says what breaks rather than what is absent. */
const CONSEQUENCE: Record<QueueBinding, string> = {
  'enqueue-mirror': 'no `user_jobs` row is written, so accepted jobs have no record',
  'lifecycle-mirror': 'job state transitions are never persisted',
  'job-lock': 'scheduled jobs run with no advisory lock, so overlapping fires race',
  'heartbeat-writer': 'job heartbeats are never recorded, so the stuck-job probe is blind',
};

export function isQueueBindingRegistered(binding: QueueBinding): boolean {
  try {
    Container.get(TOKENS[binding]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fail boot unless every named binding is registered.
 *
 * Call AFTER `import '@scani/jobs'` (or whatever registers the concretes) and
 * BEFORE serving traffic or starting a worker. Reports **all** missing
 * bindings at once — a deployment that lost the import is missing several,
 * and fixing them one boot at a time is three restarts to learn one fact.
 */
export function assertQueueBindings(required: readonly QueueBinding[]): void {
  const missing = required.filter((binding) => !isQueueBindingRegistered(binding));

  if (missing.length > 0) {
    const detail = missing.map((b) => `  - ${b}: ${CONSEQUENCE[b]}`).join('\n');
    throw new Error(
      `@scani/queue: required binding(s) not registered:\n${detail}\n\n` +
        'These are registered as a decorator side-effect, so the module that ' +
        'declares them must be imported before anything resolves them — in this repo that is ' +
        "`import '@scani/jobs';` at the top of the app's entrypoint. If this deployment " +
        'genuinely does not need them (OSS Tier 1, tests), do not call assertQueueBindings ' +
        'for them rather than registering a stub.'
    );
  }

  logger.info({ bindings: [...required] }, 'Queue bindings verified');
}
