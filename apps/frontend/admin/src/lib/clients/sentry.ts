/**
 * Sentry org/project inspection.
 *
 * Uses the existing `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` env vars that
 * the deploy workflow already threads through Cloudflare Pages. The
 * token we run with today has org:read + project:read scope; the
 * `/stats_v2/` and `/releases/` endpoints both work with it.
 *
 * Read-only — no mutations from the admin UI. Resolve/mute actions
 * would go through an HMAC-proxied backend route in a later pass.
 */

import { cached } from '../cache';
import { getEnv } from '../env';
import { type Result, tryCatch } from '../result';

const BASE = 'https://sentry.io/api/0';

function auth(): { token: string; org: string } {
  const token = getEnv('SENTRY_AUTH_TOKEN');
  const org = getEnv('SENTRY_ORG');
  if (!token || !org) throw new Error('SENTRY_AUTH_TOKEN / SENTRY_ORG missing');
  return { token, org };
}

async function req<T>(path: string): Promise<T> {
  const { token } = auth();
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Sentry ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

/**
 * Slugs of the five projects the admin covers. Matches Terraform's
 * infra/terraform/sentry.tf — projects we don't have in Terraform
 * won't surface here. Kept as an ordered array (not derived from the
 * API) so the card grid renders in a deterministic layout.
 */
export const SENTRY_PROJECTS = [
  'scani-backend',
  'scani-worker',
  'scani-frontend',
  'scani-admin',
  'scani-landing',
] as const;

export type SentryProjectSlug = (typeof SENTRY_PROJECTS)[number];

export interface SentryProjectSummary {
  slug: SentryProjectSlug;
  platform: string | null;
  projectId: string;
  unresolvedIssues: number;
  events7d: number;
  latestRelease: { shortVersion: string; dateCreated: string } | null;
  dashboardUrl: string;
}

interface ProjectInfo {
  id: string;
  slug: string;
  platform: string | null;
}

async function fetchProjects(): Promise<ProjectInfo[]> {
  const { org } = auth();
  return req<ProjectInfo[]>(`/organizations/${org}/projects/`);
}

async function fetchUnresolvedCount(slug: string): Promise<number> {
  const { org } = auth();
  const issues = await req<Array<unknown>>(
    `/projects/${org}/${slug}/issues/?query=is:unresolved&limit=100`
  );
  return issues.length;
}

interface StatsResponse {
  groups: Array<{
    by: { project?: number | string };
    totals: Record<string, number>;
  }>;
}

async function fetchEvents7dByProject(): Promise<Map<string, number>> {
  const { org } = auth();
  const data = await req<StatsResponse>(
    `/organizations/${org}/stats_v2/?field=sum(quantity)&groupBy=project&groupBy=category&category=error&interval=1d&statsPeriod=7d`
  );
  const map = new Map<string, number>();
  for (const g of data.groups) {
    const pid = g.by.project;
    if (pid == null) continue;
    const total = Object.values(g.totals).reduce((a, b) => a + (Number(b) || 0), 0);
    map.set(String(pid), (map.get(String(pid)) ?? 0) + total);
  }
  return map;
}

interface ReleaseResponse {
  shortVersion?: string;
  version?: string;
  dateCreated: string;
}

async function fetchLatestRelease(
  projectId: string
): Promise<{ shortVersion: string; dateCreated: string } | null> {
  const { org } = auth();
  const releases = await req<ReleaseResponse[]>(
    `/organizations/${org}/releases/?per_page=1&project=${projectId}`
  ).catch(() => [] as ReleaseResponse[]);
  const r = releases[0];
  if (!r) return null;
  const label = (r.shortVersion ?? r.version ?? '').slice(0, 12);
  return { shortVersion: label, dateCreated: r.dateCreated };
}

/**
 * One call per card: per-project unresolved issue count + latest
 * release. Event volume for the last 7 days comes from a single
 * org-wide stats_v2 query we fan in to `SentryProjectSummary`.
 *
 * We intentionally fan out `fetchUnresolvedCount` + `fetchLatestRelease`
 * in parallel per project (5 × 2 = 10 HTTPs) rather than a single
 * bulk endpoint — Sentry's per-project endpoints give us exactly the
 * data shape we need without JSON re-massaging. The TTL takes care of
 * repeat cost.
 */
export async function getSentryOverview(): Promise<Result<SentryProjectSummary[]>> {
  return tryCatch(() =>
    cached('sentry:overview', 60, async () => {
      const { org } = auth();
      const [projects, events7d] = await Promise.all([fetchProjects(), fetchEvents7dByProject()]);
      const bySlug = new Map(projects.map((p) => [p.slug, p]));

      const rows = await Promise.all(
        SENTRY_PROJECTS.map(async (slug) => {
          const p = bySlug.get(slug);
          if (!p) {
            return {
              slug,
              platform: null,
              projectId: '',
              unresolvedIssues: 0,
              events7d: 0,
              latestRelease: null,
              dashboardUrl: `https://${org}.sentry.io/projects/${slug}/`,
            } satisfies SentryProjectSummary;
          }
          const [unresolvedIssues, latestRelease] = await Promise.all([
            fetchUnresolvedCount(slug).catch(() => 0),
            fetchLatestRelease(p.id).catch(() => null),
          ]);
          return {
            slug,
            platform: p.platform,
            projectId: p.id,
            unresolvedIssues,
            events7d: events7d.get(p.id) ?? 0,
            latestRelease,
            dashboardUrl: `https://${org}.sentry.io/projects/${slug}/`,
          } satisfies SentryProjectSummary;
        })
      );
      return rows;
    })
  );
}

export interface SentryOverviewSummary {
  /** Event count across all projects in the last 7 days. */
  events7d: number;
  /** Number of projects with at least one event in the last 7 days. */
  activeProjects: number;
  /** Total projects instrumented (from the project list endpoint). */
  totalProjects: number;
}

/**
 * Cheap Sentry rollup for the dashboard tile. Two subrequests total:
 * one project list (so we can count instrumentation coverage), one
 * org-wide stats_v2 query that groups by project. Skips the per-project
 * unresolved-issue + latest-release fan-out from `getSentryOverview`
 * because the Overview card doesn't render that level of detail — and
 * those calls were the single biggest contributor to the Worker
 * "too many subrequests" cap. Per-project drill-down still loads via
 * `getSentryOverview` on the dedicated /platform/sentry page.
 *
 * TTL is intentionally longer (5 min) than `sentry:overview` — totals
 * change slowly and the operator is rarely watching them tick.
 */
export async function getSentryOverviewSummary(): Promise<Result<SentryOverviewSummary>> {
  return tryCatch(() =>
    cached('sentry:overview-summary', 300, async () => {
      const [projects, events7dByProject] = await Promise.all([
        fetchProjects(),
        fetchEvents7dByProject(),
      ]);
      const events7d = Array.from(events7dByProject.values()).reduce((a, b) => a + b, 0);
      return {
        events7d,
        activeProjects: events7dByProject.size,
        totalProjects: projects.length,
      };
    })
  );
}
