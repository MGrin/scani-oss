const DAY_MS = 86_400_000;

type Window = { kind: string; from?: Date; to?: Date };

/**
 * What a getReturns span records (SC-1776): the cache outcome, and which
 * request it was. A 3 s miss on production could not be traced to a window,
 * and the hero's `custom` windows change every day, so their length is kept.
 */
export function returnsSpanAttributes(
  o: { hit: boolean; shared?: boolean; stale?: boolean; versionMs: number },
  request: { scope: { kind: string; id?: string }; window: Window }
): Record<string, string | number> {
  const { window } = request;
  return {
    'returns.cache': o.stale ? 'stale' : o.shared ? 'shared' : o.hit ? 'hit' : 'miss',
    'returns.version_ms': o.versionMs,
    'returns.window': window.kind,
    ...(window.kind === 'custom' &&
      window.from &&
      window.to && {
        'returns.window_days': Math.round((window.to.getTime() - window.from.getTime()) / DAY_MS),
      }),
    'returns.scope': request.scope.kind,
  };
}
