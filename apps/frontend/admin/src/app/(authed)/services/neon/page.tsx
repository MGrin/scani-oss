import { formatBytes, formatNumber, formatRelative } from '@scani/shared';
import { ErrorPanel } from '@/components/ErrorPanel';
import { MetricTile } from '@/components/MetricTile';
import { Section } from '@/components/Section';
import { getNeonProjects } from '@/lib/clients/neon';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function NeonPage() {
  const projects = await getNeonProjects();
  if (!projects.ok) return <ErrorPanel service="Neon" error={projects.error} />;

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Neon Postgres</h1>
      <p className="text-xs text-muted-foreground mb-6">
        Billing-period usage per project (resets on plan's billing-cycle boundary)
      </p>

      <div className="space-y-6">
        {projects.data.map((p) => (
          <div key={p.id}>
            <h2 className="text-sm font-semibold mb-3">
              {p.name}{' '}
              <span className="text-muted-foreground font-normal">
                · {p.platformId} · {p.regionId} · pg{p.pgVersion}
              </span>
            </h2>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              <MetricTile label="Plan" value={p.plan} />
              <MetricTile
                label="Compute hours (cycle)"
                value={p.computeHours.toFixed(2)}
                sub={`${formatNumber(p.cpuUsedSec)} CPU-s`}
              />
              <MetricTile
                label="Storage"
                value={formatBytes(p.syntheticStorageSize ?? p.storeBytes)}
              />
              <MetricTile label="Branches" value={p.branchCount} />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <MetricTile label="Data transfer (cycle)" value={formatBytes(p.dataTransferBytes)} />
              <MetricTile label="Written data (cycle)" value={formatBytes(p.writtenDataBytes)} />
              <MetricTile label="Created" value={formatRelative(p.createdAt)} />
            </div>
          </div>
        ))}
      </div>

      <Section title="Raw project ids">
        <ul className="text-xs text-muted-foreground font-mono space-y-1">
          {projects.data.map((p) => (
            <li key={p.id}>
              {p.id} — {p.name}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
