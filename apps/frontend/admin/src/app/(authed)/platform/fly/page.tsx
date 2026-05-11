import { formatRelative } from '@scani/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { type Status, StatusBadge } from '@/components/StatusBadge';
import { getFlyMachines, getFlyOverview } from '@/lib/clients/fly';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function FlyPage() {
  const fetchedAt = new Date().toISOString();
  const overview = await getFlyOverview();
  if (!overview.ok) {
    return (
      <>
        <PageHeader title="Fly.io" fetchedAt={fetchedAt} />
        <ErrorPanel service="Fly.io" error={overview.error} />
      </>
    );
  }

  const machineResults = await Promise.all(
    overview.data.apps.map(async (app) => ({
      app: app.name,
      machines: await getFlyMachines(app.name),
    }))
  );

  const totalMachines = machineResults.reduce(
    (acc, m) => acc + (m.machines.ok ? m.machines.data.length : 0),
    0
  );

  return (
    <>
      <PageHeader
        title="Fly.io"
        description={
          <>
            Org <span className="text-foreground">{overview.data.slug}</span> · role{' '}
            {overview.data.viewerRole ?? '—'}
          </>
        }
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Billing" value={overview.data.billingStatus ?? '—'} />
        <StatCard label="Apps" value={overview.data.apps.length} />
        <StatCard label="Machines" value={totalMachines} />
        <StatCard label="Role" value={overview.data.viewerRole ?? '—'} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4">
        {overview.data.apps.map((app) => {
          const machines = machineResults.find((m) => m.app === app.name)?.machines;
          const appStatus: Status =
            app.status === 'running' || app.status === 'deployed' ? 'ok' : 'warn';
          return (
            <SectionCard
              key={app.name}
              title={app.name}
              description={
                <>
                  {app.status} · deployed: {app.deployed ? 'yes' : 'no'}
                  {app.currentRelease
                    ? ` · v${app.currentRelease.version} (${formatRelative(app.currentRelease.createdAt)})`
                    : ''}
                </>
              }
              actions={<StatusBadge status={appStatus} label={app.status} />}
              flushBody
            >
              {machines?.ok ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>id</TableHead>
                        <TableHead>name</TableHead>
                        <TableHead>state</TableHead>
                        <TableHead>region</TableHead>
                        <TableHead>age</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {machines.data.map((m) => (
                        <TableRow key={m.id}>
                          <TableCell className="font-mono text-muted-foreground">{m.id}</TableCell>
                          <TableCell>{m.name}</TableCell>
                          <TableCell>{m.state}</TableCell>
                          <TableCell>{m.region}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatRelative(m.createdAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="p-4">
                  <ErrorPanel
                    service={`${app.name} machines`}
                    error={machines?.error ?? 'unknown'}
                  />
                </div>
              )}
            </SectionCard>
          );
        })}
      </div>
    </>
  );
}
