export interface ClientErrorReport {
  readonly message: string;
  readonly stack?: string;
  readonly componentStack?: string;
  readonly route?: string;
  readonly userAgent?: string;
  readonly appVersion?: string;
  readonly level?: 'error' | 'warning';
}

export interface ClientErrorEvent {
  readonly message: string;
  readonly level: 'error' | 'warning';
  readonly tags: Record<string, string>;
  readonly extra: Record<string, string>;
  readonly userId: string | null;
}

/**
 * A browser error report as a Sentry event (SC-1333). The route tag is the path
 * alone, because a tag is for grouping and a query string would make every
 * report its own value. The query string is kept nowhere: it can carry a
 * token, and the path is what a reader needs (SC-1350). The title says
 * `[client]` because the event lands in the backend project, where it otherwise
 * reads as a server error (SC-1380).
 */
export function clientErrorEvent(
  report: ClientErrorReport,
  userId: string | null
): ClientErrorEvent {
  const tags: Record<string, string> = { source: 'client' };
  if (report.route) tags.route = report.route.split(/[?#]/)[0] as string;
  if (report.appVersion) tags.appVersion = report.appVersion;
  const extra: Record<string, string> = {};
  if (report.stack) extra.stack = report.stack;
  if (report.componentStack) extra.componentStack = report.componentStack;
  if (report.userAgent) extra.userAgent = report.userAgent;
  return {
    message: `[client] ${report.message}`,
    level: report.level ?? 'error',
    tags,
    extra,
    userId,
  };
}

/**
 * A route without its query string or fragment (SC-1350). The app sends the
 * path alone now; a tab loaded before that still sends `?…`, which can carry a
 * magic-link token, so the server strips it too.
 */
export function withoutQuery(route: string | undefined): string | undefined {
  return route?.split(/[?#]/, 1)[0];
}
