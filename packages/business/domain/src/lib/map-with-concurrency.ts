/**
 * Map over `items` with at most `limit` calls in flight, preserving input
 * order in the result (SC-1306).
 *
 * This exists because the alternatives are both wrong for the caller it was
 * written for. A `for … await` loop pays one full round trip per item, which
 * is what made a 120-point benchmark chart cost 120 sequential conversions.
 * A bare `Promise.all` over the same list removes the ordering but not the
 * bound — 120 days times two benchmarks is 240 concurrent database round
 * trips, which is a different production incident.
 *
 * `limit` is a ceiling, never a batch size: a worker takes the next index the
 * moment its own item settles, so one slow item does not idle the rest.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (items.length === 0) return out;

  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };

  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, () => worker()));
  return out;
}
