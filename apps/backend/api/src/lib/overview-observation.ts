import type { OverviewObserver } from '@scani/domain/services';

const PHASES = {
  portfolio: 'overview.portfolio_ms',
  details: 'overview.details_read_ms',
  presence: 'overview.presence_read_ms',
  compose: 'overview.compose_ms',
} as const;
const CACHE = new Set([
  'projection_hit',
  'request_reuse',
  'inflight_wait',
  'redis_hit',
  'live',
  'error',
]);
const LIVE_REASONS = new Set([
  'hidden_inclusive',
  'redis_miss',
  'redis_unavailable',
  'redis_error',
]);

/** One procedure owns this record; finalization excludes still-running Promise.all siblings. */
export class OverviewObservation {
  private readonly fields: Record<string, string | number> = { 'overview.cache': 'unknown' };
  private snapshot?: Readonly<Record<string, string | number>>;

  readonly observe: OverviewObserver = (observation) => {
    if (this.snapshot) return;
    if ('phase' in observation) {
      if (
        Object.hasOwn(PHASES, observation.phase) &&
        Number.isFinite(observation.durationMs) &&
        observation.durationMs >= 0
      ) {
        this.fields[PHASES[observation.phase]] = observation.durationMs;
      }
    } else if (CACHE.has(observation.cache)) {
      this.fields['overview.cache'] = observation.cache;
      delete this.fields['overview.live_reason'];
      if (
        observation.cache === 'live' &&
        observation.liveReason &&
        LIVE_REASONS.has(observation.liveReason)
      ) {
        this.fields['overview.live_reason'] = observation.liveReason;
      }
    }
  };

  finish(ok: boolean): Readonly<Record<string, string | number>> {
    this.snapshot ??= Object.freeze({
      'overview.schema': 1,
      'overview.completeness':
        ok &&
        this.fields['overview.cache'] !== 'unknown' &&
        Object.values(PHASES).every((key) => this.fields[key] !== undefined)
          ? 'complete'
          : 'partial',
      ...this.fields,
    });
    return this.snapshot;
  }
}
