import { createHash } from 'node:crypto';
import type { InflowRateLimiter } from '@scani/rate-limiter';
import { type BillsIcsEvent, buildBillsIcs } from '../lib/bills-ics';

export interface BillCalendarRouteDeps {
  resolve: (rawToken: string) => Promise<string | null>;
  events: (userId: string, now: Date) => Promise<BillsIcsEvent[]>;
  /** Per token, on top of the global per-IP cap every route already has. */
  limiter: InflowRateLimiter;
  now?: () => Date;
}

const PREFIX = '/calendar/';
const SUFFIX = '.ics';
const NO_STORE = { 'cache-control': 'no-store' };

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...NO_STORE },
  });
}

/** The token as sent: a malformed escape is kept as written rather than refused early. */
function tokenFrom(pathname: string): { token: string; isIcs: boolean } {
  const file = pathname.slice(PREFIX.length);
  const isIcs = file.endsWith(SUFFIX);
  const raw = isIcs ? file.slice(0, -SUFFIX.length) : file;
  try {
    return { token: decodeURIComponent(raw), isIcs };
  } catch {
    return { token: raw, isIcs };
  }
}

/**
 * `GET /calendar/<token>.ics` (SC-1654): a user's upcoming bills for a calendar
 * app to subscribe to. Public by design and keyed only by the token, so every
 * miss is the same 404 and nothing is ever cached.
 */
// biome-ignore lint/suspicious/noExplicitAny: Elysia's app type is not exported in a form a route module can name; every registerXRoutes here takes `any`.
export function registerBillCalendarRoutes(app: any, deps: BillCalendarRouteDeps): void {
  const now = deps.now ?? (() => new Date());
  app.get(`${PREFIX}*`, async ({ request }: { request: Request }) => {
    const { token, isIcs } = tokenFrom(new URL(request.url).pathname);
    const key = createHash('sha256').update(token).digest('hex');
    const admission = await deps.limiter.tryConsumeKey(key);
    if (!admission.ok) {
      return new Response('Too many requests', {
        status: 429,
        headers: { 'retry-after': String(admission.retryAfterSec), ...NO_STORE },
      });
    }
    const owner = await deps.resolve(token);
    if (!owner || !isIcs) return notFound();
    const at = now();
    const body = buildBillsIcs({
      calendarName: 'Scani bills',
      now: at,
      events: await deps.events(owner, at),
    });
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/calendar; charset=utf-8',
        'content-disposition': 'inline; filename="scani-bills.ics"',
        ...NO_STORE,
      },
    });
  });
}
