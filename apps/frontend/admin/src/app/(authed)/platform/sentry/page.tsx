import { formatNumber, formatRelative } from '@scani/shared';
import { Card } from '@scani/ui/ui/card';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { type Status, StatusBadge } from '@/components/StatusBadge';
import { getSentryOverview } from '@/lib/clients/sentry';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function SentryPage() {
  const fetchedAt = new Date().toISOString();
  const overview = await getSentryOverview();
  if (!overview.ok) {
    return (
      <>
        <PageHeader title="Sentry" fetchedAt={fetchedAt} />
        <ErrorPanel service="Sentry" error={overview.error} />
      </>
    );
  }

  const totals = overview.data.reduce(
    (acc, p) => ({
      unresolved: acc.unresolved + p.unresolvedIssues,
      events7d: acc.events7d + p.events7d,
    }),
    { unresolved: 0, events7d: 0 }
  );

  return (
    <>
      <PageHeader
        title="Sentry"
        description={`${overview.data.length} project${overview.data.length === 1 ? '' : 's'} instrumented · error tracking + release health.`}
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Projects" value={overview.data.length} />
        <StatCard label="Unresolved issues" value={formatNumber(totals.unresolved)} />
        <StatCard label="Events (7d)" value={formatNumber(totals.events7d)} />
        <StatCard
          label="Projects with issues"
          value={overview.data.filter((p) => p.unresolvedIssues > 0).length}
        />
      </div>

      <SectionCard title="Per-project status" className="mt-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {overview.data.map((p) => {
            const status: Status =
              p.unresolvedIssues > 10 ? 'error' : p.unresolvedIssues > 0 ? 'warn' : 'ok';
            return (
              <a
                key={p.slug}
                href={p.dashboardUrl}
                target="_blank"
                rel="noreferrer"
                className="contents"
              >
                <Card className="p-4 transition-colors hover:border-primary/30 hover:bg-muted/40">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{p.slug}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.platform ?? 'unknown platform'}
                      </div>
                    </div>
                    <StatusBadge status={status} label={`${p.unresolvedIssues} open`} />
                  </div>
                  <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-xs">
                    <dt className="text-muted-foreground/70 text-[10px] uppercase tracking-wide self-center">
                      Events 7d
                    </dt>
                    <dd className="tabular-nums">{formatNumber(p.events7d)}</dd>
                    <dt className="text-muted-foreground/70 text-[10px] uppercase tracking-wide self-center">
                      Latest
                    </dt>
                    <dd className="text-muted-foreground">
                      {p.latestRelease
                        ? `${p.latestRelease.shortVersion} · ${formatRelative(p.latestRelease.dateCreated)}`
                        : '—'}
                    </dd>
                  </dl>
                </Card>
              </a>
            );
          })}
        </div>
      </SectionCard>
    </>
  );
}
