/**
 * Drop a URL path's trailing slashes, leaving a bare `/` alone.
 *
 * Scanned rather than `.replace(/\/+$/, '')`. That pattern backtracks
 * quadratically on a run of slashes — the engine retries `\/+` from every one
 * of them, and each attempt walks to the end before `$` rejects it — and a
 * pathname comes straight from the address bar, so any link can hand it 80k
 * (js/polynomial-redos, SC-483).
 */
export function stripTrailingSlash(pathname: string): string {
  if (pathname.length <= 1) return pathname;
  let end = pathname.length;
  while (end > 0 && pathname[end - 1] === '/') end--;
  return pathname.slice(0, end);
}
