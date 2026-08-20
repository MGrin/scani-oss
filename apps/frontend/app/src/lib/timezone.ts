/**
 * Timezone capture — the half of SC-226 that decides whether the feature
 * exists at all.
 *
 * `users.timezone` is nullable and the reminder job SKIPS a null rather than
 * defaulting to UTC, because "17:00 UTC" is 01:00 in Singapore. Nothing else
 * in the product writes that column: if this stops being called, the job
 * matches zero users forever and reports it as "nobody had payments due",
 * which is indistinguishable from working correctly.
 *
 * The browser is the only honest source. Nothing in the account, the payment
 * data or the request says where a person is, and an IP guess is wrong exactly
 * when someone travels — which is when a reminder landing at 04:00 is least
 * welcome. mgrin is based in Bali and travels often, so this is the ordinary
 * case here rather than an edge one.
 */

/** What this browser thinks its zone is, or null if it cannot say. */
export function browserTimezone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && zone.length > 0 ? zone : null;
  } catch {
    return null;
  }
}

/**
 * Whether to send a report.
 *
 * Sends when the zone is new OR has changed, and stays quiet when it matches —
 * the app reports on every load, and that is the difference between one write
 * on landing in a new country and one write per session per user forever. The
 * server repeats this check, so a client that reports anyway is merely
 * wasteful rather than wrong.
 */
export function shouldReportTimezone(
  browserZone: string | null,
  storedZone: string | null | undefined
): boolean {
  if (!browserZone) return false;
  return browserZone !== storedZone;
}
