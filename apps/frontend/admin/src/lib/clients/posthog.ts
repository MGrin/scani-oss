/**
 * PostHog product-analytics inspection.
 *
 * Read-only. Authenticates with a PostHog *personal* API key
 * (`POSTHOG_API_KEY`, `phx_…`) — not the `phc_` project key, which only
 * ingests events and cannot read them back. `POSTHOG_PROJECT_ID` is the
 * numeric project id; `POSTHOG_HOST` defaults to the EU app host, the
 * same instance `infra/terraform/posthog.tf` provisions the dashboards on.
 *
 * Numbers cover a rolling 30-day window and mirror the insights defined
 * in posthog.tf so this page and the PostHog dashboards tell the same
 * story. Events queried (`$pageview`, `user_signed_up`, … ) match the
 * canonical names in `@scani/analytics`' `ANALYTICS_EVENTS`.
 */

import { cached } from '../cache';
import { getEnv } from '../env';
import { type Result, tryCatch } from '../result';

const DEFAULT_HOST = 'https://eu.posthog.com';
const WINDOW_DAYS = 30;

function auth(): { token: string; projectId: string; host: string } {
  const token = getEnv('POSTHOG_API_KEY');
  const projectId = getEnv('POSTHOG_PROJECT_ID');
  if (!token || !projectId) throw new Error('POSTHOG_API_KEY / POSTHOG_PROJECT_ID missing');
  return { token, projectId, host: getEnv('POSTHOG_HOST') ?? DEFAULT_HOST };
}

async function runQuery<T>(query: Record<string, unknown>): Promise<T> {
  const { token, projectId, host } = auth();
  const res = await fetch(`${host}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ query }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`PostHog query ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/** Run a HogQL statement and return the raw result rows (column-ordered). */
async function hogql(query: string): Promise<unknown[][]> {
  const data = await runQuery<{ results?: unknown[][] }>({ kind: 'HogQLQuery', query });
  return Array.isArray(data.results) ? data.results : [];
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

// One row of conversion counts for the five tracked product events.
const COUNTS_SQL = `
  SELECT
    countIf(event = '$pageview'),
    countIf(event = 'user_signed_up'),
    countIf(event = 'account_connected'),
    countIf(event = 'import_completed'),
    countIf(event = 'waitlist_joined')
  FROM events
  WHERE timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY
`;

const VISITORS_SQL = `
  SELECT uniq(person_id)
  FROM events
  WHERE event = '$pageview' AND timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY
`;

const BY_APP_SQL = `
  SELECT properties.app, count()
  FROM events
  WHERE event = '$pageview'
    AND timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY
    AND properties.app != ''
  GROUP BY properties.app
  ORDER BY count() DESC
`;

const TOP_PAGES_SQL = `
  SELECT properties.$pathname, count()
  FROM events
  WHERE event = '$pageview'
    AND timestamp >= now() - INTERVAL ${WINDOW_DAYS} DAY
    AND properties.$pathname != ''
  GROUP BY properties.$pathname
  ORDER BY count() DESC
  LIMIT 12
`;

// Per-person activation funnel — `results` is a flat array of step
// objects (each with a `count`). With a breakdown PostHog nests one
// array per breakdown value, so unwrap the first entry defensively.
function parseFunnel(raw: unknown): number[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const results = (raw as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const steps = Array.isArray(results[0]) ? (results[0] as unknown[]) : (results as unknown[]);
  const counts = steps.map((s) => num((s as { count?: unknown })?.count));
  return counts.length > 0 ? counts : null;
}

export interface PostHogAnalytics {
  windowDays: number;
  pageviews: number;
  visitors: number;
  signups: number;
  accountsConnected: number;
  imports: number;
  waitlist: number;
  byApp: Array<{ app: string; pageviews: number }>;
  topPages: Array<{ path: string; pageviews: number }>;
  /** Step counts for visit → signup → account → import; null if the query failed. */
  funnel: number[] | null;
  projectUrl: string;
}

/**
 * Full 30-day analytics rollup for the `/platform/posthog` page. Five
 * upstream queries fan out in parallel behind a single 5-minute cache
 * key — totals move slowly and the operator isn't watching them tick.
 * The funnel query degrades to `null` on failure so a single bad
 * response doesn't blank the whole page.
 */
export async function getPostHogAnalytics(): Promise<Result<PostHogAnalytics>> {
  return tryCatch(() =>
    cached('posthog:analytics', 300, async () => {
      const { projectId, host } = auth();
      const [counts, visitors, byApp, topPages, funnelRaw] = await Promise.all([
        hogql(COUNTS_SQL),
        hogql(VISITORS_SQL),
        hogql(BY_APP_SQL),
        hogql(TOP_PAGES_SQL),
        runQuery<{ results?: unknown }>({
          kind: 'FunnelsQuery',
          dateRange: { date_from: `-${WINDOW_DAYS}d` },
          series: [
            { kind: 'EventsNode', event: '$pageview' },
            { kind: 'EventsNode', event: 'user_signed_up' },
            { kind: 'EventsNode', event: 'account_connected' },
            { kind: 'EventsNode', event: 'import_completed' },
          ],
        }).catch(() => null),
      ]);

      const row = counts[0] ?? [];
      return {
        windowDays: WINDOW_DAYS,
        pageviews: num(row[0]),
        signups: num(row[1]),
        accountsConnected: num(row[2]),
        imports: num(row[3]),
        waitlist: num(row[4]),
        visitors: num(visitors[0]?.[0]),
        byApp: byApp.map((r) => ({ app: String(r[0] ?? 'unknown'), pageviews: num(r[1]) })),
        topPages: topPages.map((r) => ({ path: String(r[0] ?? '—'), pageviews: num(r[1]) })),
        funnel: parseFunnel(funnelRaw),
        projectUrl: `${host}/project/${projectId}`,
      } satisfies PostHogAnalytics;
    })
  );
}
