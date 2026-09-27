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
 * wasteful rather than wrong. The read-only demo refuses the write, so it
 * never reports (SC-1138).
 */
export function shouldReportTimezone(
  browserZone: string | null,
  storedZone: string | null | undefined,
  { readOnly = false }: { readOnly?: boolean } = {}
): boolean {
  if (readOnly || !browserZone) return false;
  return browserZone !== storedZone;
}
