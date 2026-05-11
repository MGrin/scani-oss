import { formatBytes, formatNumber, formatRelative } from '@scani/shared';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getNeonProjects } from '@/lib/clients/neon';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function NeonPage() {
  const fetchedAt = new Date().toISOString();
  const projects = await getNeonProjects();
  if (!projects.ok) {
    return (
      <>
        <PageHeader title="Neon Postgres" fetchedAt={fetchedAt} />
        <ErrorPanel service="Neon" error={projects.error} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Neon Postgres"
        description="Billing-period usage per project (resets on the plan's billing-cycle boundary)."
        fetchedAt={fetchedAt}
      />

      <div className="flex flex-col gap-6">
        {projects.data.map((p) => (
          <SectionCard
            key={p.id}
            title={p.name}
            description={
              <>
                {p.platformId} · {p.regionId} · pg{p.pgVersion}
              </>
            }
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Plan" value={p.plan} />
              <StatCard
                label="Compute hours"
                value={p.computeHours.toFixed(2)}
                sub={`${formatNumber(p.cpuUsedSec)} CPU-s`}
              />
              <StatCard
                label="Storage"
                value={formatBytes(p.syntheticStorageSize ?? p.storeBytes)}
              />
              <StatCard label="Branches" value={p.branchCount} />
              <StatCard label="Data transfer" value={formatBytes(p.dataTransferBytes)} />
              <StatCard label="Written" value={formatBytes(p.writtenDataBytes)} />
              <StatCard label="Created" value={formatRelative(p.createdAt)} />
              <StatCard
                label="Project id"
                value={<span className="font-mono text-sm">{p.id}</span>}
              />
            </div>
          </SectionCard>
        ))}
      </div>
    </>
  );
}
