import { formatNumber, formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getCloudStats } from '@/lib/clients/db/cloudStats';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function CloudPage() {
  const fetchedAt = new Date().toISOString();
  const stats = await getCloudStats();
  if (!stats.ok) {
    return (
      <>
        <PageHeader title="Cloud customers" fetchedAt={fetchedAt} />
        <ErrorPanel service="Cloud" error={stats.error} />
      </>
    );
  }
  const {
    users,
    apiKeys,
    apiKeysActive,
    apiKeysRevoked,
    byTier,
    byBillingStatus,
    recent,
    events24h,
  } = stats.data;

  return (
    <>
      <PageHeader
        title="Cloud customers"
        description="Tier 2/3 SaaS — cloud users, API keys, usage events."
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Cloud users" value={formatNumber(users)} />
        <StatCard
          label="API keys"
          value={formatNumber(apiKeys)}
          sub={`${formatNumber(apiKeysActive)} active · ${formatNumber(apiKeysRevoked)} revoked`}
        />
        <StatCard
          label="Events (24h)"
          value={formatNumber(events24h.total)}
          sub={events24h.errors > 0 ? `${formatNumber(events24h.errors)} errors` : 'no errors'}
        />
        <StatCard
          label="Error rate (24h)"
          value={
            events24h.total > 0
              ? `${((events24h.errors / events24h.total) * 100).toFixed(2)}%`
              : '—'
          }
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SectionCard title="Active keys by tier" flushBody>
          {byTier.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tier</TableHead>
                  <TableHead className="text-right">Keys</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byTier.map((r) => (
                  <TableRow key={r.tier}>
                    <TableCell className="font-mono">{r.tier}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(r.count)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-4 text-xs text-muted-foreground">No active keys.</div>
          )}
        </SectionCard>

        <SectionCard title="Keys by billing status" flushBody>
          {byBillingStatus.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Keys</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byBillingStatus.map((r) => (
                  <TableRow key={r.status}>
                    <TableCell>
                      <Badge
                        variant={
                          r.status === 'active'
                            ? 'default'
                            : r.status === 'past_due'
                              ? 'destructive'
                              : 'outline'
                        }
                      >
                        {r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(r.count)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-4 text-xs text-muted-foreground">No keys yet.</div>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Top routes (24h)"
        description="Most-called data-provider tRPC routes from cloud API keys."
        className="mt-6"
        flushBody
      >
        {events24h.topRoutes.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Route</TableHead>
                <TableHead className="text-right">Calls</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events24h.topRoutes.map((r) => (
                <TableRow key={r.route}>
                  <TableCell className="font-mono text-xs">{r.route}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.count)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">No calls in the last 24 hours.</div>
        )}
      </SectionCard>

      <SectionCard
        title="Recently active keys"
        description="Most recent 20 keys by last-used (or created if never used)."
        className="mt-6"
        flushBody
      >
        {recent.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Billing</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Revoked</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="text-sm">{r.name}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {r.keyPrefix}…
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{r.ownerEmailMasked}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.tier}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          r.billingStatus === 'active'
                            ? 'default'
                            : r.billingStatus === 'past_due'
                              ? 'destructive'
                              : 'outline'
                        }
                      >
                        {r.billingStatus}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.lastUsedAt ? formatRelative(r.lastUsedAt) : '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.revokedAt ? (
                        <Badge variant="destructive">{formatRelative(r.revokedAt)}</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">No keys yet.</div>
        )}
      </SectionCard>
    </>
  );
}
