import { formatRelative } from '@scani/shared';
import { ErrorPanel } from '@/components/ErrorPanel';
import { MetricTile } from '@/components/MetricTile';
import { Section } from '@/components/Section';
import { getFlyMachines, getFlyOverview } from '@/lib/clients/fly';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function FlyPage() {
  const overview = await getFlyOverview();
  if (!overview.ok) return <ErrorPanel service="Fly.io" error={overview.error} />;

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
    <div>
      <h1 className="text-xl font-semibold mb-1">Fly.io</h1>
      <p className="text-xs text-muted-foreground mb-6">
        Org <span className="text-foreground">{overview.data.slug}</span> · role{' '}
        {overview.data.viewerRole ?? '—'}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <MetricTile label="Billing status" value={overview.data.billingStatus ?? '—'} />
        <MetricTile label="Apps" value={overview.data.apps.length} />
        <MetricTile label="Machines" value={totalMachines} />
        <MetricTile label="Role" value={overview.data.viewerRole ?? '—'} />
      </div>

      <Section title="Apps">
        <div className="space-y-4">
          {overview.data.apps.map((app) => {
            const machines = machineResults.find((m) => m.app === app.name)?.machines;
            return (
              <div key={app.name} className="rounded-lg border border-border bg-card/40 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="text-sm font-semibold">{app.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {app.status} · deployed: {app.deployed ? 'yes' : 'no'}
                      {app.currentRelease
                        ? ` · v${app.currentRelease.version} (${formatRelative(
                            app.currentRelease.createdAt
                          )})`
                        : ''}
                    </div>
                  </div>
                </div>
                {machines?.ok ? (
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="text-left font-normal py-1">id</th>
                        <th className="text-left font-normal py-1">name</th>
                        <th className="text-left font-normal py-1">state</th>
                        <th className="text-left font-normal py-1">region</th>
                        <th className="text-left font-normal py-1">age</th>
                      </tr>
                    </thead>
                    <tbody>
                      {machines.data.map((m) => (
                        <tr key={m.id} className="border-t border-border/60">
                          <td className="py-1 font-mono text-muted-foreground">{m.id}</td>
                          <td className="py-1">{m.name}</td>
                          <td className="py-1">{m.state}</td>
                          <td className="py-1">{m.region}</td>
                          <td className="py-1 text-muted-foreground">
                            {formatRelative(m.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="text-xs text-red-300">machines: {machines?.error}</div>
                )}
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
