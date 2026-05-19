import { formatNumber } from '@scani/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getPostHogAnalytics } from '@/lib/clients/posthog';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const FUNNEL_STEPS = ['Visited site', 'Signed up', 'Connected account', 'Completed import'];

function percent(part: number, whole: number): string {
  if (whole <= 0) return '—';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

export default async function PostHogPage() {
  const fetchedAt = new Date().toISOString();
  const analytics = await getPostHogAnalytics();

  if (!analytics.ok) {
    return (
      <>
        <PageHeader title="PostHog" fetchedAt={fetchedAt} />
        <ErrorPanel
          service="PostHog"
          error={analytics.error}
          hint="Set POSTHOG_API_KEY (a personal API key with query access) and POSTHOG_PROJECT_ID."
        />
      </>
    );
  }

  const a = analytics.data;
  const maxAppViews = a.byApp.reduce((m, r) => Math.max(m, r.pageviews), 0);
  const funnel = a.funnel;

  return (
    <>
      <PageHeader
        title="PostHog"
        description={`Product analytics · last ${a.windowDays} days.`}
        fetchedAt={fetchedAt}
        actions={
          <a
            href={a.projectUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Open in PostHog ↗
          </a>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Pageviews" value={formatNumber(a.pageviews)} />
        <StatCard label="Unique visitors" value={formatNumber(a.visitors)} />
        <StatCard label="Signups" value={formatNumber(a.signups)} />
        <StatCard label="Accounts connected" value={formatNumber(a.accountsConnected)} />
        <StatCard label="Imports completed" value={formatNumber(a.imports)} />
        <StatCard label="Waitlist joins" value={formatNumber(a.waitlist)} />
      </div>

      <SectionCard
        title="Activation funnel"
        description="Visit → signup → account connection → import, per person."
        className="mt-6"
      >
        {funnel && funnel.length > 0 ? (
          <ol className="space-y-3">
            {funnel.map((count, i) => {
              const ofStart = funnel[0] ?? 0;
              const width = ofStart > 0 ? (count / ofStart) * 100 : 0;
              return (
                <li key={FUNNEL_STEPS[i] ?? `step-${i}`}>
                  <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                    <span className="font-medium">{FUNNEL_STEPS[i] ?? `Step ${i + 1}`}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {formatNumber(count)}
                      {i > 0 ? ` · ${percent(count, ofStart)} of visitors` : null}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.max(width, 1)}%` }}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-xs text-muted-foreground">Funnel data unavailable.</p>
        )}
      </SectionCard>

      <SectionCard title="Pageviews by app" className="mt-6">
        {a.byApp.length > 0 ? (
          <ul className="space-y-3">
            {a.byApp.map((row) => (
              <li key={row.app}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                  <span className="font-medium">{row.app}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatNumber(row.pageviews)}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${maxAppViews > 0 ? Math.max((row.pageviews / maxAppViews) * 100, 1) : 0}%`,
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No pageviews recorded in the window.</p>
        )}
      </SectionCard>

      <SectionCard title="Top pages" className="mt-6" flushBody>
        {a.topPages.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Path</TableHead>
                  <TableHead className="text-right">Pageviews</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {a.topPages.map((row) => (
                  <TableRow key={row.path}>
                    <TableCell className="font-mono text-xs">{row.path}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.pageviews)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="p-4 text-xs text-muted-foreground">No pageviews recorded in the window.</p>
        )}
      </SectionCard>
    </>
  );
}
