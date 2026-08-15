/**
 * Sliding time windows for history walks.
 *
 * Every venue that serves transaction history caps how wide a
 * `startTime`/`endTime` span it will answer, and rejects anything wider
 * rather than truncating: Bybit's execution list at 7 days and its
 * deposit/withdraw records at 30 (`retCode=131002`), Binance's capital
 * history at 90, MEXC's at 30 and 90, Wise's statements by day count. The
 * caller's range has nothing to do with any of those numbers, so a provider
 * that hands `[since, until]` straight to the endpoint works until someone
 * connects an account older than the cap and then fails on every single run.
 *
 * That is not hypothetical — it is SC-166. Bybit's deposit and withdrawal
 * walks were written without the split its own execution walk already had,
 * and the resulting import failed six identical times against a rejection
 * that could never succeed.
 *
 * Splitting the range is the same four lines in all of them, so it lives
 * here once. What is genuinely per-venue — which endpoint, which cap, how
 * the cursor advances inside a window — stays in the provider.
 */

export interface TimeWindow {
  start: Date;
  end: Date;
}

/**
 * Split `[since, until)` into consecutive windows no wider than `spanMs`.
 *
 * Yields nothing when the range is empty or inverted, so a caller whose
 * cursor has already caught up makes no requests at all. The last window is
 * clamped to `until` rather than overshooting it — asking a venue about the
 * future is how you get a rejection on a range that was otherwise fine.
 */
export function* slidingWindows(since: Date, until: Date, spanMs: number): Generator<TimeWindow> {
  if (!Number.isFinite(spanMs) || spanMs <= 0) {
    throw new Error(`slidingWindows: spanMs must be a positive number, got ${spanMs}`);
  }
  const endMs = until.getTime();
  let cursor = since.getTime();
  while (cursor < endMs) {
    const next = Math.min(cursor + spanMs, endMs);
    yield { start: new Date(cursor), end: new Date(next) };
    cursor = next;
  }
}
