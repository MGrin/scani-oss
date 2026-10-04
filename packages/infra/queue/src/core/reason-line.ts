const REASON_MAX_CHARS = 240;

/**
 * A failure reason as one line. Not its first line: an upstream error that
 * pretty-prints its body ends that line at `{`, and the message is below it.
 */
export function reasonLine(reason: string | null): string {
  const line = (reason ?? '').replace(/\s+/g, ' ').trim();
  if (line.length <= REASON_MAX_CHARS) return line;
  return `${line.slice(0, REASON_MAX_CHARS - 1).trimEnd()}…`;
}
