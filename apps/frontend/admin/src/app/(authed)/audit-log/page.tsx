import { formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { type AuditOutcome, getAuditLog } from '@/lib/clients/auditLog';
import { writesEnabled } from '@/lib/writes';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const OUTCOME_VARIANT: Record<AuditOutcome, 'default' | 'destructive' | 'outline' | 'secondary'> = {
  ok: 'default',
  error: 'destructive',
  denied: 'outline',
};

export default async function AuditLogPage() {
  const fetchedAt = new Date().toISOString();
  const result = await getAuditLog(200);
  const writes = writesEnabled();

  if (!result.ok) {
    return (
      <>
        <PageHeader title="Audit log" fetchedAt={fetchedAt} />
        <ErrorPanel service="Audit log" error={result.error} />
      </>
    );
  }

  const entries = result.data;
  const oks = entries.filter((e) => e.outcome === 'ok').length;
  const errors = entries.filter((e) => e.outcome === 'error').length;
  const denied = entries.filter((e) => e.outcome === 'denied').length;

  return (
    <>
      <PageHeader
        title="Audit log"
        description={
          <>
            Operator write actions, newest first. Backed by an Upstash list at{' '}
            <code className="font-mono text-xs">admin:audit</code>, capped at 500 entries. Writes
            are currently{' '}
            <Badge variant={writes ? 'default' : 'outline'} className="mx-0.5">
              {writes ? 'enabled' : 'disabled'}
            </Badge>{' '}
            via <code className="font-mono text-xs">ADMIN_WRITES_ENABLED</code>.
          </>
        }
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Entries shown" value={entries.length} />
        <StatCard label="OK" value={oks} />
        <StatCard label="Errors" value={errors} />
        <StatCard label="Denied (flag off)" value={denied} />
      </div>

      <SectionCard
        title="Entries"
        description="Each row records who did what, against what target, and the outcome. Sensitive payload fields are never written here."
        className="mt-6"
        flushBody
      >
        {entries.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e) => (
                  <TableRow key={`${e.ts}-${e.action}-${e.target ?? ''}`}>
                    <TableCell className="text-xs text-muted-foreground" title={e.ts}>
                      {formatRelative(e.ts)}
                    </TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">
                      {e.actor}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{e.action}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {e.target ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={OUTCOME_VARIANT[e.outcome]}>{e.outcome}</Badge>
                    </TableCell>
                    <TableCell className="max-w-md text-xs text-muted-foreground">
                      {e.detail ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">
            No audit entries yet. Trigger a write action to populate this log.
          </div>
        )}
      </SectionCard>
    </>
  );
}
