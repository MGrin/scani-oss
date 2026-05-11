import { formatNumber, formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getIntegrationStats } from '@/lib/clients/db/integrationStats';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const STATUS_VARIANT: Record<string, 'default' | 'destructive' | 'outline' | 'secondary'> = {
  enqueued: 'default',
  pending_enqueue: 'secondary',
  failed: 'destructive',
};

export default async function IntegrationsPage() {
  const fetchedAt = new Date().toISOString();
  const stats = await getIntegrationStats();
  if (!stats.ok) {
    return (
      <>
        <PageHeader title="Integrations" fetchedAt={fetchedAt} />
        <ErrorPanel service="App database" error={stats.error} />
      </>
    );
  }
  const {
    userIntegrationCredentials,
    institutions,
    integrationsByInstitution,
    topInstitutions,
    importStatus,
    recentFailedImports,
    stuckPending,
  } = stats.data;

  return (
    <>
      <PageHeader
        title="Integrations"
        description="Per-user credentials connecting Scani to exchanges, brokerages, and wallets."
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Credentials" value={formatNumber(userIntegrationCredentials)} />
        <StatCard label="Institutions" value={formatNumber(institutions)} />
        <StatCard
          label="Stuck pending"
          value={formatNumber(stuckPending)}
          sub="pending_enqueue > 5min"
        />
        <StatCard
          label="Failed imports"
          value={formatNumber(importStatus.find((s) => s.status === 'failed')?.count ?? 0)}
        />
      </div>

      <SectionCard
        title="Import-pipeline state"
        description="Distribution of user_integration_credentials.import_status."
        className="mt-6"
        flushBody
      >
        {importStatus.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {importStatus.map((r) => (
                <TableRow key={r.status}>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[r.status] ?? 'outline'}>{r.status}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.count)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">No import-status data.</div>
        )}
      </SectionCard>

      <SectionCard
        title="Recent failed imports"
        description="10 most recent credentials with import_status = failed."
        className="mt-6"
        flushBody
      >
        {recentFailedImports.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Institution</TableHead>
                  <TableHead>Retries</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead>Last error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentFailedImports.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.institution}</TableCell>
                    <TableCell className="tabular-nums">{r.retryCount}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(r.updatedAt)}
                    </TableCell>
                    <TableCell className="max-w-md truncate text-xs text-destructive">
                      {r.lastError ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">No failed imports.</div>
        )}
      </SectionCard>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SectionCard title="By institution" flushBody>
          {integrationsByInstitution.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Institution</TableHead>
                  <TableHead className="text-right">Credentials</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {integrationsByInstitution.map((r) => (
                  <TableRow key={r.institution}>
                    <TableCell>{r.institution}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(r.count)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-4 text-xs text-muted-foreground">No integrations.</div>
          )}
        </SectionCard>

        <SectionCard title="Top institutions by account count" flushBody>
          {topInstitutions.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Institution</TableHead>
                  <TableHead className="text-right">Accounts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topInstitutions.map((r) => (
                  <TableRow key={r.institution}>
                    <TableCell>{r.institution}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(r.accounts)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-4 text-xs text-muted-foreground">No accounts yet.</div>
          )}
        </SectionCard>
      </div>
    </>
  );
}
