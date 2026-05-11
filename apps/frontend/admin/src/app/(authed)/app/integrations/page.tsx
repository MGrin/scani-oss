import { formatNumber } from '@scani/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getAppDbStats } from '@/lib/clients/appDb';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function IntegrationsPage() {
  const fetchedAt = new Date().toISOString();
  const stats = await getAppDbStats();
  if (!stats.ok) {
    return (
      <>
        <PageHeader title="Integrations" fetchedAt={fetchedAt} />
        <ErrorPanel service="App database" error={stats.error} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Per-user credentials connecting Scani to exchanges, brokerages, and wallets."
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label="Integration credentials"
          value={formatNumber(stats.data.userIntegrationCredentials)}
        />
        <StatCard label="Institutions" value={formatNumber(stats.data.institutions)} />
        <StatCard label="User wallets" value={formatNumber(stats.data.userWallets)} />
      </div>

      <SectionCard title="By institution" className="mt-6" flushBody>
        {stats.data.integrationsByInstitution.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Institution</TableHead>
                <TableHead className="text-right">Credentials</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.data.integrationsByInstitution.map((r) => (
                <TableRow key={r.institution}>
                  <TableCell>{r.institution}</TableCell>
                  <TableCell className="text-right font-mono">{r.count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">No integrations connected yet.</div>
        )}
      </SectionCard>

      <SectionCard title="Top institutions by account count" className="mt-6" flushBody>
        {stats.data.topInstitutions.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Institution</TableHead>
                <TableHead className="text-right">Accounts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.data.topInstitutions.map((r) => (
                <TableRow key={r.institution}>
                  <TableCell>{r.institution}</TableCell>
                  <TableCell className="text-right font-mono">{r.accounts}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">No accounts yet.</div>
        )}
      </SectionCard>

      <SectionCard title="Coming in Phase 2" className="mt-6">
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>
            Failed-import breakdown (status = <code className="font-mono">failed</code>).
          </li>
          <li>Pending-enqueue stragglers (older than the reconciler window).</li>
          <li>Retry-count distribution.</li>
          <li>Quarantined providers (circuit-breaker open).</li>
        </ul>
      </SectionCard>
    </>
  );
}
