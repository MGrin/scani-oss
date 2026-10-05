import type { EngineShadowRunKind } from '@scani/db/schema';
import { ENGINE_SHADOW_KINDS, RunEngineShadowsUseCase } from '@scani/domain/use-cases';
import { ENGINE_SHADOW_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { type ProcessorContext, ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

/**
 * Where an attempt leaves the kinds it recorded, so a retry runs only the
 * rest. Saved with the job's id: should the list ever reach the scheduler's
 * template, a later night's job carries another id and reads it as nothing
 * done, rather than skipping a kind every night.
 */
const DONE_KEY = 'engineShadowKindsDone';

/**
 * Foundation A1's nightly shadow: every user, at the moment it fires. Each
 * run records itself, a failed one included; a completed one is logged as
 * soon as it is recorded. A failed attempt is retried (the scheduler's
 * default attempts), and a retry runs only the kinds no earlier attempt
 * COMPLETED, so a night records at most one completed run of each kind.
 *
 * A failed run is not skipped on retry, so a kind that fails every attempt
 * records one `failed` run per attempt. Those count against
 * `SHADOW_RUNS_KEPT` like any other, so a failure that repeats night after
 * night shortens the kept history to a third as many nights.
 */
@Service()
export class EngineShadowProcessor extends ScheduledJobProcessor {
  readonly descriptor = ENGINE_SHADOW_SCHEDULE;
  private readonly shadows = Container.get(RunEngineShadowsUseCase);
  private readonly logger = createComponentLogger('processor:engine-shadow');

  protected async handle(job: ProcessorContext['job']): Promise<void> {
    const done = doneKinds(job.data, job.id);
    const asOf = new Date();
    await this.shadows.execute({
      asOf,
      kinds: ENGINE_SHADOW_KINDS.filter((kind) => !done.includes(kind)),
      onRecorded: async (run) => {
        // A price run's byCategory sums every instant it compared; this is now's alone.
        const atAsOf = run.summary.byInstant?.[asOf.toISOString()];
        this.logger.info(
          {
            kind: run.kind,
            runId: run.runId,
            compared: run.summary.compared,
            matched: run.summary.matched,
            byCategory: run.summary.byCategory,
            ...(atAsOf === undefined ? {} : { byCategoryAtAsOf: atAsOf }),
          },
          'Engine shadow run recorded'
        );
        done.push(run.kind);
        await job.updateData({ ...job.data, [DONE_KEY]: { jobId: job.id, kinds: [...done] } });
      },
    });
  }
}

/**
 * Another job's list, or anything unreadable, counts as nothing done: a kind
 * run twice beats a kind skipped.
 */
function doneKinds(data: unknown, jobId: string | undefined): EngineShadowRunKind[] {
  const saved = (data as Record<string, unknown> | null | undefined)?.[DONE_KEY] as
    | { jobId?: unknown; kinds?: unknown }
    | null
    | undefined;
  if (jobId === undefined || saved?.jobId !== jobId) return [];
  const kinds = saved.kinds;
  if (!Array.isArray(kinds)) return [];
  const known: readonly unknown[] = ENGINE_SHADOW_KINDS;
  if (!kinds.every((kind) => known.includes(kind))) return [];
  return ENGINE_SHADOW_KINDS.filter((kind) => kinds.includes(kind));
}
