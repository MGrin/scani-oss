import { assertDemoOnlyDatabase, DemoDatasetSeeder, isDemoModeRequested } from '@scani/domain/demo';
import { DEMO_RESET_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:demo-reset');

/**
 * Rebuilds the demo dataset from scratch (SC-466).
 *
 * **Re-anchored to today on every run, not to the dataset's default.** The
 * committed anchor (`2027-03-04`) is what makes the dataset byte-identical for
 * the visual gate, and it is wrong for anything a stranger looks at: measured
 * on a running stack it prints "+47.1% vs 30d" over a month that moved 7.2%,
 * because the hero is a live valuation dated in the future against a chart
 * windowed off the browser's clock, and Money's Upcoming is empty because every
 * occurrence before the anchor is already settled. `--anchor today` gives
 * "+2.0%" and three bills. Determinism is per-anchor, so this run is still
 * reproducible — it just reproduces today rather than 2027 (SC-465).
 *
 * That re-anchoring, not staleness, is the reason this job exists at all: the
 * demo is read-only, so nothing a visitor does needs undoing. What needs
 * undoing is the calendar moving.
 *
 * Both guards below are re-checked here rather than trusted from boot. This
 * process deletes a user and everything cascading off them, and a scheduled job
 * is exactly the thing that outlives the reasoning that armed it.
 */
@Service()
export class DemoResetProcessor extends ScheduledJobProcessor {
  readonly descriptor = DEMO_RESET_SCHEDULE;

  protected async handle(): Promise<void> {
    if (!isDemoModeRequested(process.env)) {
      logger.warn({}, '⏭️  Demo reset skipped — SCANI_DEMO_MODE is not 1 on this worker');
      return;
    }
    await assertDemoOnlyDatabase();

    const anchorDate = new Date().toISOString().slice(0, 10);
    const start = Date.now();
    try {
      const summary = await Container.get(DemoDatasetSeeder).seed({ anchorDate });
      logger.info(
        { anchorDate: summary.anchorDate, counts: summary.counts, totalMs: Date.now() - start },
        '✅ Demo dataset reset'
      );
    } catch (error) {
      logger.error(
        { anchorDate, error: error instanceof Error ? error.message : String(error) },
        '❌ Demo dataset reset failed'
      );
      throw error;
    }
  }
}
