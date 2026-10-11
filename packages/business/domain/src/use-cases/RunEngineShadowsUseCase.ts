import type { EngineShadowRunKind } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import type { ShadowRunSummary } from '../repositories/EngineShadowReportRepository';
import { BalanceShadowService } from '../services/foundation/BalanceShadowService';
import type { ShadowRunResult } from '../services/foundation/ShadowRunService';
import { ValueShadowService } from '../services/foundation/ValueShadowService';

/** The kinds that still run, in the order they run, whatever order they are asked for in. */
export const ENGINE_SHADOW_KINDS = [
  'balance',
  'value',
] as const satisfies readonly EngineShadowRunKind[];

type ShadowKind = (typeof ENGINE_SHADOW_KINDS)[number];

export interface EngineShadowRunResult {
  kind: ShadowKind;
  runId: string;
  summary: ShadowRunSummary;
}

export interface RunEngineShadowsInput {
  asOf: Date;
  /** Narrows every shadow to one user; their runs are then recorded with scope `user`. */
  userId?: string;
  /** Every kind when absent. */
  kinds?: ReadonlyArray<ShadowKind>;
  /** Awaited once a kind's run is recorded, before the next kind starts. A throw here ends the run. */
  onRecorded?: (run: EngineShadowRunResult) => void | Promise<void>;
}

/**
 * Runs the foundation shadows (D-10), each of which records its own run, a
 * failed one included. A kind that fails ends the run and its error is
 * rethrown.
 */
@Service()
export class RunEngineShadowsUseCase {
  private readonly balance = Container.get(BalanceShadowService);
  private readonly value = Container.get(ValueShadowService);

  async execute(input: RunEngineShadowsInput): Promise<EngineShadowRunResult[]> {
    const asked = input.kinds ?? ENGINE_SHADOW_KINDS;
    const runs: EngineShadowRunResult[] = [];
    for (const kind of ENGINE_SHADOW_KINDS.filter((k) => asked.includes(k))) {
      const run: EngineShadowRunResult = { kind, ...(await this.run(kind, input)) };
      runs.push(run);
      await input.onRecorded?.(run);
    }
    return runs;
  }

  private run(kind: ShadowKind, input: RunEngineShadowsInput): Promise<ShadowRunResult> {
    if (kind === 'value') return this.value.run({ asOf: input.asOf, userId: input.userId });
    return this.balance.run({ asOf: input.asOf, userId: input.userId });
  }
}
