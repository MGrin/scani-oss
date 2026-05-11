import { formatNumber, formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ActionDialog } from '@/components/ActionDialog';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getWaitlistStats } from '@/lib/clients/db/waitlistStats';
import { writesEnabled } from '@/lib/writes';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function WaitlistPage() {
  const fetchedAt = new Date().toISOString();
  const stats = await getWaitlistStats();
  if (!stats.ok) {
    return (
      <>
        <PageHeader title="Waitlist" fetchedAt={fetchedAt} />
        <ErrorPanel service="Waitlist" error={stats.error} />
      </>
    );
  }
  const { total, converted, conversionRate, signups7d, signups30d, bySource, recent } = stats.data;
  const writes = writesEnabled();

  return (
    <>
      <PageHeader
        title="Waitlist"
        description="Beta-preview signups from the landing page (waitlist_signups)."
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total signups" value={formatNumber(total)} />
        <StatCard
          label="Converted"
          value={formatNumber(converted)}
          sub={`${(conversionRate * 100).toFixed(1)}% rate`}
        />
        <StatCard label="Last 7 days" value={formatNumber(signups7d)} />
        <StatCard label="Last 30 days" value={formatNumber(signups30d)} />
      </div>

      <SectionCard title="By source" className="mt-6" flushBody>
        {bySource.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Signups</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {bySource.map((r) => (
                <TableRow key={r.source}>
                  <TableCell className="font-mono">{r.source}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.count)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">No signups yet.</div>
        )}
      </SectionCard>

      <SectionCard
        title="Recent signups"
        description="Most recent 25 entries. Emails are masked at the local part."
        className="mt-6"
        flushBody
      >
        {recent.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Referrer</TableHead>
                  <TableHead>Signed up</TableHead>
                  <TableHead>Converted</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.emailMasked}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.source}</Badge>
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                      {r.referrer ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(r.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.convertedToAccountAt ? (
                        <Badge>{formatRelative(r.convertedToAccountAt)}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {r.convertedToAccountAt ? (
                        <span className="text-xs text-muted-foreground">already in</span>
                      ) : (
                        <ActionDialog
                          endpoint="/api/admin/waitlist/invite"
                          payload={{ signupId: r.id }}
                          label="Invite"
                          title={`Send magic-link invite?`}
                          description={
                            <>
                              Emails a one-shot magic-link to{' '}
                              <span className="font-mono">{r.emailMasked}</span> so they can sign in
                              and create an account. The link expires in 24 hours.
                            </>
                          }
                          confirmLabel="Send invite"
                          enabled={writes}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">No signups yet.</div>
        )}
      </SectionCard>
    </>
  );
}
