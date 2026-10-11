const DAY_MS = 86_400_000;

export function closeDayNearMidnight(at: Date, toleranceMs = 0): string | null {
  const midnight = Math.round(at.getTime() / DAY_MS) * DAY_MS;
  return Math.abs(at.getTime() - midnight) <= toleranceMs
    ? new Date(midnight - DAY_MS).toISOString().slice(0, 10)
    : null;
}

export function tradingDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}
