import { OperatorAlarmRepository } from '@scani/domain/repositories';
import {
  DEAD_LETTER_ALARM,
  DEAD_LETTER_MAX_AGE_MS,
  DEAD_LETTER_RENOTIFY_MS,
  DLQ_DEPTH_PROBE_SCHEDULE,
  FAILED_JOB_MAX_AGE_MS,
} from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { captureException } from '@scani/logging/sentry';
import { QueueClient, reasonLine, ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';
import { loadEnv } from '../config/env';

const logger = createComponentLogger('processor:dlq-depth-probe');

const DAY_MS = 24 * 60 * 60 * 1000;

/** What is said about a dead letter. Its payload is the failed job's data and is never read out. */
interface DeadLetter {
  id: string;
  name: string;
  reason: string;
  attempts: number;
  addedAtMs: number;
}

interface DeadLetterData {
  originalName?: unknown;
  failedReason?: unknown;
  attemptsMade?: unknown;
}

function describeDeadLetter(job: {
  id?: string;
  name: string;
  timestamp: number;
  data: unknown;
}): DeadLetter {
  const data = (job.data ?? {}) as DeadLetterData;
  const reason = typeof data.failedReason === 'string' ? data.failedReason : 'no reason recorded';
  return {
    id: String(job.id),
    name: typeof data.originalName === 'string' ? data.originalName : job.name,
    reason: reasonLine(reason),
    attempts: typeof data.attemptsMade === 'number' ? data.attemptsMade : 0,
    addedAtMs: job.timestamp,
  };
}

/**
 * Housekeeping must not cost the alert. BullMQ refuses to remove a row its
 * scheduler owns, and that throw ended this probe's first production run
 * before it had looked at a single dead letter: three attempts, then the probe
 * itself was dead-lettered (SC-1545). A row that will not go is named in the
 * run's summary line and left.
 */
async function removed(job: { remove: () => Promise<unknown> }): Promise<boolean> {
  try {
    await job.remove();
    return true;
  } catch {
    return false;
  }
}

/**
 * The dead-letter queue has no consumer, so this probe is the only thing that
 * ever looks at it (SC-1545). Each run:
 *
 *   1. removes entries older than `DEAD_LETTER_MAX_AGE_MS`. They were written
 *      with that age as a `removeOnFail`, which applies when a job FAILS, and
 *      a job nothing consumes never does — production held one for 35 days;
 *   2. removes `failed` rows on the main queue older than `FAILED_JOB_MAX_AGE_MS`;
 *   3. escalates each dead letter ONCE, on arrival, through the alarm ledger
 *      `stale-sync-probe` uses, and restates one still there a week later.
 *      One event per job name and arrival day, fingerprinted as such: the
 *      machine's `sentry watch` files a task per Sentry ISSUE it has not seen,
 *      and every event thrown from this one line would otherwise be one issue
 *      for ever — the first dead letter filed and no later one. The day bounds
 *      a flood to one issue per job, and a restatement lands on the issue the
 *      entry arrived under rather than opening a second;
 *   4. escalates the depth at `depthThreshold`, the flood alarm.
 *
 * Before (3) the probe spoke only at a depth of 50, so a failure that happens
 * once reached nobody.
 */
async function runDeadLetterProbe(
  depthThreshold: number,
  now: Date,
  deps: {
    captureException: (
      err: unknown,
      tags?: Record<string, string>,
      fingerprint?: readonly string[]
    ) => void;
  } = { captureException }
): Promise<void> {
  const queues = Container.get(QueueClient);
  const alarms = Container.get(OperatorAlarmRepository);
  const nowMs = now.getTime();

  const live: DeadLetter[] = [];
  const unremovable: string[] = [];
  let expired = 0;
  for (const job of await queues.deadLetter().getJobs(['waiting', 'delayed', 'active'])) {
    const letter = describeDeadLetter(job);
    if (nowMs - letter.addedAtMs <= DEAD_LETTER_MAX_AGE_MS) {
      live.push(letter);
      continue;
    }
    if (!(await removed(job))) {
      unremovable.push(letter.id);
      live.push(letter);
      continue;
    }
    expired += 1;
    logger.warn(
      {
        id: letter.id,
        name: letter.name,
        ageDays: Math.floor((nowMs - letter.addedAtMs) / DAY_MS),
      },
      'Dead letter expired and removed'
    );
  }

  let failedExpired = 0;
  for (const job of await queues.get().getJobs(['failed'])) {
    if (nowMs - (job.finishedOn ?? job.timestamp) <= FAILED_JOB_MAX_AGE_MS) continue;
    if (await removed(job)) failedExpired += 1;
    else unremovable.push(String(job.id));
  }

  const byId = new Map(live.map((letter) => [letter.id, letter]));
  const { entered, restated, cleared, suppressed } = await alarms.sync(
    DEAD_LETTER_ALARM,
    [...byId.keys()],
    { now, renotifyAfterMs: DEAD_LETTER_RENOTIFY_MS }
  );

  // Unconditional, every run: the trend stays graphable on the runs that say nothing.
  logger.info(
    {
      depth: live.length,
      threshold: depthThreshold,
      expired,
      failedExpired,
      unremovable,
      entered: entered.length,
      restated: restated.length,
      cleared: cleared.length,
      suppressed: suppressed.length,
    },
    'DLQ depth probed'
  );

  escalate('entered', entered);
  escalate('restated', restated);

  if (live.length >= depthThreshold) {
    logger.error(
      { depth: live.length, threshold: depthThreshold },
      '🚨 DLQ depth crossed alert threshold'
    );
    deps.captureException(
      new Error(
        `DLQ depth ${live.length} crossed alert threshold ${depthThreshold}. ` +
          'Inspect the dead-letter queue on the admin /jobs/dlq page and decide retry vs purge.'
      ),
      {
        component: 'worker',
        kind: 'dlq-depth-alert',
        depth: String(live.length),
        threshold: String(depthThreshold),
      }
    );
  }

  function escalate(transition: 'entered' | 'restated', ids: string[]): void {
    const groups = new Map<string, { fingerprint: string[]; fired: DeadLetter[] }>();
    for (const id of ids) {
      const letter = byId.get(id);
      if (!letter) continue;
      const fingerprint = [
        DEAD_LETTER_ALARM,
        letter.name,
        new Date(letter.addedAtMs).toISOString().slice(0, 10),
      ];
      const key = fingerprint.join('/');
      const group = groups.get(key) ?? { fingerprint, fired: [] };
      group.fired.push(letter);
      groups.set(key, group);
    }
    for (const { fingerprint, fired } of groups.values()) {
      const listed = fired
        .map((l) => `${l.name} after ${l.attempts} attempt(s): ${l.reason}`)
        .join(' | ');
      logger.error(
        {
          transition,
          count: fired.length,
          ids: fired.map((l) => l.id),
          names: fired.map((l) => l.name),
        },
        '🚨 Dead letters need triage'
      );
      deps.captureException(
        new Error(
          transition === 'entered'
            ? `${fired.length} job(s) dead-lettered: ${listed}. ` +
                'Triage on the admin /jobs/dlq page: replay it, remove it, or file the bug it shows.'
            : `${fired.length} dead letter(s) still untriaged: ${listed}. ` +
                `Each is removed ${DEAD_LETTER_MAX_AGE_MS / DAY_MS} days after it arrived.`
        ),
        {
          component: 'worker',
          kind: 'dead-letter-alert',
          count: String(fired.length),
          transition,
        },
        fingerprint
      );
    }
  }
}

/** Exported for unit tests — allows injecting a captureException stub. */
export const __test_runDeadLetterProbe = runDeadLetterProbe;

@Service()
export class DlqDepthProbeProcessor extends ScheduledJobProcessor {
  readonly descriptor = DLQ_DEPTH_PROBE_SCHEDULE;

  protected async handle(): Promise<void> {
    // Validated + parsed at boot — see apps/backend/worker/src/config/env.ts.
    await runDeadLetterProbe(loadEnv().DLQ_ALERT_THRESHOLD, new Date());
  }
}
