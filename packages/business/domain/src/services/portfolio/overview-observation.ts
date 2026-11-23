export type PortfolioCacheObservation = {
  cache: 'projection_hit' | 'request_reuse' | 'inflight_wait' | 'redis_hit' | 'live' | 'error';
  liveReason?: 'hidden_inclusive' | 'redis_miss' | 'redis_unavailable' | 'redis_error';
};

export type OverviewPhase = 'portfolio' | 'details' | 'presence' | 'compose';
export type OverviewObserver = (
  observation: PortfolioCacheObservation | { phase: OverviewPhase; durationMs: number }
) => void;

export function observeOverview<T extends Parameters<OverviewObserver>[0]>(
  observer: ((observation: T) => void) | undefined,
  observation: T
): void {
  try {
    observer?.(observation);
  } catch {
    // Telemetry cannot change financial results, cache fallbacks or original errors.
  }
}

export async function measureOverview<T>(
  phase: OverviewPhase,
  run: () => Promise<T>,
  observer?: OverviewObserver
): Promise<T> {
  if (!observer) return run();
  const start = performance.now();
  try {
    return await run();
  } finally {
    observeOverview(observer, { phase, durationMs: performance.now() - start });
  }
}
