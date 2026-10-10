/**
 * When each provider last refused a request for rate (a 429 that survived its
 * retries), in this process (SC-1602). The worker runs the hourly pricing and
 * the quarter-hour run in one process, so the quarter-hour run can see either
 * one's refusal and step aside before the hourly run is starved.
 */
const lastRefusalAt = new Map<string, number>();

export function recordRefusal(provider: string, at: number = Date.now()): void {
  lastRefusalAt.set(provider, at);
}

export function lastRefusal(provider: string): number | undefined {
  return lastRefusalAt.get(provider);
}
