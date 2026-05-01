import { formatNumber, formatRelative } from '@scani/shared';
import { ErrorPanel } from '@/components/ErrorPanel';
import { MetricTile } from '@/components/MetricTile';
import { Section } from '@/components/Section';
import { getSentryOverview } from '@/lib/clients/sentry';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function SentryPage() {
  const overview = await getSentryOverview();
  if (!overview.ok) return <ErrorPanel service="Sentry" error={overview.error} />;

  const totals = overview.data.reduce(
    (acc, p) => ({
      unresolved: acc.unresolved + p.unresolvedIssues,
      events7d: acc.events7d + p.events7d,
    }),
    { unresolved: 0, events7d: 0 }
  );

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Sentry</h1>
      <p className="text-xs text-neutral-400 mb-6">
        {overview.data.length} project{overview.data.length === 1 ? '' : 's'} instrumented · error
        tracking + release health
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <MetricTile label="Projects" value={overview.data.length} />
        <MetricTile label="Unresolved issues" value={formatNumber(totals.unresolved)} />
        <MetricTile label="Events (7d)" value={formatNumber(totals.events7d)} />
        <MetricTile
          label="Projects with issues"
          value={overview.data.filter((p) => p.unresolvedIssues > 0).length}
        />
      </div>

      <Section title="Per-project status">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {overview.data.map((p) => {
            const tone = p.unresolvedIssues > 10 ? 'error' : p.unresolvedIssues > 0 ? 'warn' : 'ok';
            return (
              <a
                key={p.slug}
                href={p.dashboardUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4 hover:bg-neutral-900/70 transition-colors"
              >
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-sm font-semibold">{p.slug}</div>
                    <div className="text-xs text-neutral-400">
                      {p.platform ?? 'unknown platform'}
                    </div>
                  </div>
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full ${
                      tone === 'error'
                        ? 'bg-red-500'
                        : tone === 'warn'
                          ? 'bg-amber-400'
                          : 'bg-emerald-500'
                    }`}
                  />
                </div>
                <div className="space-y-1.5 text-xs">
                  <Row
                    label="Unresolved issues"
                    value={formatNumber(p.unresolvedIssues)}
                    emphasize={p.unresolvedIssues > 0}
                  />
                  <Row label="Events (7d)" value={formatNumber(p.events7d)} />
                  <Row
                    label="Latest release"
                    value={
                      p.latestRelease
                        ? `${p.latestRelease.shortVersion} · ${formatRelative(p.latestRelease.dateCreated)}`
                        : '—'
                    }
                  />
                </div>
              </a>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

function Row({
  label,
  value,
  emphasize = false,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-neutral-500">{label}</span>
      <span className={emphasize ? 'text-amber-300 font-medium' : 'text-neutral-200'}>{value}</span>
    </div>
  );
}
