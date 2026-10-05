import type { EngineShadowRunKind } from '@scani/db/schema';
import { Container, Service } from 'typedi';
import type { ShadowRunSummary } from '../repositories/EngineShadowReportRepository';
import { BalanceShadowService } from '../services/foundation/BalanceShadowService';
import { failureOf } from '../services/foundation/failure-message';
import { PriceShadowService } from '../services/foundation/PriceShadowService';
import type { ShadowRunResult } from '../services/foundation/ShadowRunService';

/**
 * The order the kinds run in, whatever order they are asked for in. Price
 * first: the live resolver it compares against reads the newest stored price
 * with no bound at `asOf`, so it runs as close to `asOf` as it can, before the
 * balance shadow's duration can carry it past the next hourly pricing write.
 */
export const ENGINE_SHADOW_KINDS: readonly EngineShadowRunKind[] = ['price', 'balance'];

/** How far before `asOf` the balance shadow also compares, in days of 24 hours. */
const SHADOW_PAST_OFFSETS_DAYS = [7, 30] as const;

/** The UTC days before `asOf`'s whose closes the price shadow also compares. */
const PRICE_PAST_DAYS = [1, 3, 7, 30, 365] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The last millisecond of the UTC day `days` before `asOf`'s. */
function dayCloseBefore(asOf: Date, days: number): Date {
  return new Date(
    Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate() - days, 23, 59, 59, 999)
  );
}

export interface EngineShadowRunResult {
  kind: EngineShadowRunKind;
  runId: string;
  summary: ShadowRunSummary;
}

export interface RunEngineShadowsInput {
  asOf: Date;
  /** Narrows both shadows to one user; their runs are then recorded with scope `user`. */
  userId?: string;
  /** Both when absent. */
  kinds?: ReadonlyArray<EngineShadowRunKind>;
  /**
   * Awaited once a kind's run is recorded, before the next kind starts, so a
   * caller hears of a completed run even when its sibling then fails. A throw
   * here is a failure of that kind, like the shadow's own.
   */
  onRecorded?: (run: EngineShadowRunResult) => void | Promise<void>;
}

/**
 * Runs the foundation shadows (D-10), each of which records its own run. A
 * kind that fails does not stop the other: its failure is rethrown once both
 * have run — as it is when one failed, and as an `AggregateError` of both, in
 * run order, when both did.
 */
@Service()
export class RunEngineShadowsUseCase {
  private readonly balance = Container.get(BalanceShadowService);
  private readonly price = Container.get(PriceShadowService);

  async execute(input: RunEngineShadowsInput): Promise<EngineShadowRunResult[]> {
    const asked = input.kinds ?? ENGINE_SHADOW_KINDS;
    const runs: EngineShadowRunResult[] = [];
    const failures: Array<{ kind: EngineShadowRunKind; err: unknown }> = [];

    for (const kind of ENGINE_SHADOW_KINDS.filter((k) => asked.includes(k))) {
      try {
        const run: EngineShadowRunResult = { kind, ...(await this.run(kind, input)) };
        runs.push(run);
        await input.onRecorded?.(run);
      } catch (err) {
        failures.push({ kind, err });
      }
    }

    const [first, ...rest] = failures;
    if (first === undefined) return runs;
    if (rest.length === 0) throw first.err;
    // A scheduled job's failure is recorded by its message alone, so the
    // message names each cause rather than only that there were two.
    throw new AggregateError(
      failures.map((f) => f.err),
      `the ${failures.map((f) => f.kind).join(' and ')} shadows failed: ` +
        failures.map((f) => `${f.kind}: ${failureOf(f.err)}`).join('; ')
    );
  }

  private run(kind: EngineShadowRunKind, input: RunEngineShadowsInput): Promise<ShadowRunResult> {
    if (kind === 'price') {
      return this.price.run({
        asOf: input.asOf,
        pastInstants: PRICE_PAST_DAYS.map((days) => dayCloseBefore(input.asOf, days)),
        userId: input.userId,
      });
    }
    return this.balance.run({
      asOf: input.asOf,
      pastInstants: SHADOW_PAST_OFFSETS_DAYS.map(
        (days) => new Date(input.asOf.getTime() - days * DAY_MS)
      ),
      userId: input.userId,
    });
  }
}
