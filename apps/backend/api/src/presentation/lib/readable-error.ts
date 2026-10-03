interface Issue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

function isIssue(value: unknown): value is Issue {
  const issue = value as { path?: unknown; message?: unknown };
  return Array.isArray(issue?.path) && typeof issue.message === 'string';
}

function issuesFrom(error: unknown): Issue[] | null {
  const fromCause = (error as { cause?: { issues?: unknown } })?.cause?.issues;
  if (Array.isArray(fromCause) && fromCause.length > 0 && fromCause.every(isIssue)) {
    return fromCause;
  }
  const message = (error as { message?: unknown })?.message;
  if (typeof message !== 'string' || !message.trimStart().startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    return Array.isArray(parsed) && parsed.length > 0 && parsed.every(isIssue) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The error to hand Sentry for a failure on `path` (SC-1492). An input refusal
 * carries the zod issue list serialised as JSON for its message, and Sentry
 * titles an event by the message's first line — `[` — so every refusal on every
 * procedure read as one issue with no words in it. The original is kept as the
 * cause, which Sentry shows as a linked error with the full list.
 */
export function readableError<T>(error: T, path: string): T | Error {
  const issues = issuesFrom(error);
  if (!issues) return error;
  const [first, ...rest] = issues as [Issue, ...Issue[]];
  const where = first.path.length > 0 ? first.path.join('.') : '(input)';
  const more = rest.length > 0 ? ` (+${rest.length} more)` : '';
  const readable = new Error(`${path}: ${where} — ${first.message}${more}`, { cause: error });
  readable.name = 'TRPCInputError';
  return readable;
}
