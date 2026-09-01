import { InstitutionRepository, OperatorAlarmRepository } from '@scani/domain/repositories';
import { STALE_SYNC_ALARM, STALE_SYNC_PROBE_SCHEDULE, STALE_SYNC_RENOTIFY_MS } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { captureException } from '@scani/logging/sentry';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';
import { loadEnv } from '../config/env';

const logger = createComponentLogger('processor:stale-sync-probe');

/**
 * Escalate an integration that has stopped syncing — ONCE, on entering that
 * condition, not on every hourly probe that observes it (SC-870).
 *
 * The previous shape escalated whenever anything was broken, so a single
 * unresolved integration could account for the great majority of this
 * service's error volume — one event an hour, indefinitely, about something
 * already known. The cost is not that the stream is unpleasant to read. It is
 * that a low-frequency signal elsewhere — a job that fails once a day — becomes
 * unreadable behind it, and stays unread for as long as the loud condition
 * lasts. A persistent condition MANUFACTURES A HIDING PLACE, and resolving the
 * particular integration does not stop the next one from building another.
 *
 * `OperatorAlarmRepository` holds which conditions are already open. Three
 * things happen here and each has to, or the alarm is worse than it was:
 *
 *   1. **entry** escalates — the transition is the news;
 *   2. **recovery** clears the row and is LOGGED, not captured. A
 *      `captureException` on good news opens an issue nobody can resolve; the
 *      observable proof the alarm re-armed is the next break firing again;
 *   3. **a condition still true after `STALE_SYNC_RENOTIFY_MS`** is re-stated,
 *      because going permanently silent about something permanently broken is
 *      the opposite failure, and the quieter one.
 */
async function runStaleSyncProbe(
  thresholdHours: number,
  now: Date,
  deps: { captureException: (err: unknown, tags?: Record<string, string>) => void } = {
    captureException,
  }
): Promise<void> {
  const repo = Container.get(InstitutionRepository);
  const alarms = Container.get(OperatorAlarmRepository);
  const cutoff = new Date(now.getTime() - thresholdHours * 60 * 60 * 1000);

  const targets = await repo.findStaleSyncTargets(cutoff);
  const byCredential = new Map(targets.map((t) => [t.credentialId, t]));

  const { entered, restated, cleared, suppressed } = await alarms.sync(
    STALE_SYNC_ALARM,
    [...byCredential.keys()],
    { now, renotifyAfterMs: STALE_SYNC_RENOTIFY_MS }
  );

  // Unconditional, every run: this is the line the dashboards graph, and it is
  // what still says "three are broken" on every probe that now stays silent.
  // Suppressing the escalation is only safe while the trend remains observable
  // somewhere, and this is that somewhere.
  logger.info(
    {
      count: targets.length,
      thresholdHours,
      entered: entered.length,
      restated: restated.length,
      cleared: cleared.length,
      suppressed: suppressed.length,
    },
    'Stale-sync probed'
  );

  if (cleared.length > 0) {
    logger.info({ credentialIds: cleared }, '✅ Stale integrations recovered');
  }

  // Two escalations at most, and never one merged event: "this just broke" and
  // "this is still broken a week later" are different news, and a reader who
  // cannot tell them apart re-investigates a week-old condition as if it were
  // new. Each is its own Sentry issue for the same reason.
  escalate('entered', entered);
  escalate('restated', restated);

  function escalate(transition: 'entered' | 'restated', keys: string[]): void {
    if (keys.length === 0) return;
    const fired = keys.flatMap((id) => {
      const found = byCredential.get(id);
      return found ? [found] : [];
    });
    const names = fired.map((t) => `${t.institutionName}(${t.kind})`).join(', ');
    const err = new Error(
      transition === 'entered'
        ? `${fired.length} integration(s) not syncing past ${thresholdHours}h: ${names}. ` +
            'Check credentials/provider for each.'
        : `${fired.length} integration(s) still not syncing: ${names}. ` +
            'Open since the last report; resolve or disconnect.'
    );
    // Carry the credential and user ids into the log line. The row is what has
    // to be acted on, and naming only the institution does not identify it when
    // the institution is shared.
    logger.error(
      {
        transition,
        count: fired.length,
        names,
        stillOpen: suppressed.length,
        targets: fired.map((t) => ({
          credentialId: t.credentialId,
          userId: t.userId,
          institutionName: t.institutionName,
          kind: t.kind,
        })),
      },
      '🚨 Stale integrations detected'
    );
    deps.captureException(err, {
      component: 'worker',
      kind: 'stale-sync-alert',
      count: String(fired.length),
      transition,
    });
  }
}

/** Exported for unit tests — allows injecting a captureException stub. */
export const __test_runStaleSyncProbe = runStaleSyncProbe;

@Service()
export class StaleSyncProbeProcessor extends ScheduledJobProcessor {
  readonly descriptor = STALE_SYNC_PROBE_SCHEDULE;

  protected async handle(): Promise<void> {
    await runStaleSyncProbe(loadEnv().STALE_SYNC_THRESHOLD_HOURS, new Date());
  }
}
