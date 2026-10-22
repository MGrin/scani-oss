import { Container, Service } from 'typedi';
import { type ReturnsResponse, withoutPeriodSeries } from '../../lib/returns/response';
import type { ReturnWindowRequest } from '../../lib/returns/window';
import { ReturnsLastCompleteRepository } from '../../repositories/ReturnsLastCompleteRepository';
import { BenchmarkReturnService } from './BenchmarkReturnService';
import type { ReturnsScope } from './ReturnsScopeResolver';
import { ReturnsService } from './ReturnsService';
import { ReturnsSharedLoads } from './ReturnsSharedLoads';

const DAY_MS = 86_400_000;

// The windows Home offers: the period control's 1W-1Y, each ending now
// (`HOME_PERIODS` in the app), and the Returns tile's YTD.
const HOME_PERIOD_DAYS = [7, 30, 90, 180, 365] as const;

export interface ReturnsAnswer {
  returns: ReturnsResponse;
  benchmarks: Awaited<ReturnType<BenchmarkReturnService['over']>>;
}

/** SC-1694: the last eligible answer, shown "as of" `computedAt` while history rebuilds. */
export type LastComplete = ReturnsAnswer & { computedAt: string };

/**
 * A custom window is kept by its length: Home's periods end now, so the same
 * period asked a day later is a different window of the same length.
 */
export function lastCompleteWindowKey(window: ReturnWindowRequest): string {
  if (window.kind !== 'custom') return window.kind;
  return `custom:${Math.round((window.to.getTime() - window.from.getTime()) / DAY_MS)}d`;
}

@Service()
export class ReturnsLastCompleteService {
  private readonly repository = Container.get(ReturnsLastCompleteRepository);
  private readonly returns = Container.get(ReturnsService);
  private readonly benchmarks = Container.get(BenchmarkReturnService);

  async keep(
    userId: string,
    scope: ReturnsScope,
    window: ReturnWindowRequest,
    answer: ReturnsAnswer,
    options: { computedAt?: Date; force?: boolean } = {}
  ): Promise<void> {
    await this.repository.save(
      {
        userId,
        scopeKey: JSON.stringify(scope),
        windowKey: lastCompleteWindowKey(window),
        baseCurrencyId: answer.returns.baseCurrencyId,
        answer,
        computedAt: options.computedAt ?? new Date(),
      },
      { force: options.force }
    );
  }

  /** `null` when nothing was kept, or it was kept in another base currency. */
  async find(
    userId: string,
    scope: ReturnsScope,
    window: ReturnWindowRequest,
    baseCurrencyId: string
  ): Promise<LastComplete | null> {
    const row = await this.repository.find(
      userId,
      JSON.stringify(scope),
      lastCompleteWindowKey(window)
    );
    if (!row || row.baseCurrencyId !== baseCurrencyId) return null;
    return { ...(row.answer as ReturnsAnswer), computedAt: row.computedAt.toISOString() };
  }

  /**
   * Keep the answer for every window Home offers, from a rebuild that has just
   * finished (SC-1707). Kept only when a reader asked at an eligible moment,
   * the period on screen often had nothing to show while the next rebuild ran.
   * Returns the window keys it kept.
   */
  async refreshHome(
    userId: string,
    options: { now?: Date; ignoreRebuildJobId?: string } = {}
  ): Promise<string[]> {
    const now = options.now ?? new Date();
    const scope: ReturnsScope = { kind: 'user' };
    const windows: ReturnWindowRequest[] = [
      ...HOME_PERIOD_DAYS.map(
        (days): ReturnWindowRequest => ({
          kind: 'custom',
          from: new Date(now.getTime() - days * DAY_MS),
          to: now,
        })
      ),
      { kind: 'ytd' },
    ];
    const shared = new ReturnsSharedLoads();
    const kept: string[] = [];
    for (const window of windows) {
      const outcome = await this.returns.compute(
        { userId, scope, window, now, ignoreRebuildJobId: options.ignoreRebuildJobId },
        { shared }
      );
      if (outcome.status !== 'ok' || !outcome.returns.eligibility.eligible) continue;
      const { effectiveWindow, baseCurrencyId } = outcome.returns;
      const benchmarks = effectiveWindow
        ? await this.benchmarks.over(effectiveWindow, baseCurrencyId)
        : [];
      await this.keep(
        userId,
        scope,
        window,
        { returns: withoutPeriodSeries(outcome.returns), benchmarks },
        { computedAt: now, force: true }
      );
      kept.push(lastCompleteWindowKey(window));
    }
    return kept;
  }
}
