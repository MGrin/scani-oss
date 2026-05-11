import { formatBytes, formatNumber, formatRelative } from '@scani/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getHoldingStats } from '@/lib/clients/db/holdingStats';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function HoldingsPage() {
  const fetchedAt = new Date().toISOString();
  const stats = await getHoldingStats();
  if (!stats.ok) {
    return (
      <>
        <PageHeader title="Holdings" fetchedAt={fetchedAt} />
        <ErrorPanel service="App database" error={stats.error} />
      </>
    );
  }
  const {
    holdings,
    tokens,
    tokenPrices,
    tokenPricesFreshestAt,
    dbSizeBytes,
    dbSizePretty,
    bySource,
    staleActive,
    userWallets,
  } = stats.data;

  return (
    <>
      <PageHeader
        title="Holdings"
        description="Position counts, token-catalog size, price freshness, stale-balance probe."
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Holdings" value={formatNumber(holdings)} />
        <StatCard label="Tokens" value={formatNumber(tokens)} />
        <StatCard
          label="Token price rows"
          value={formatNumber(tokenPrices)}
          sub={tokenPricesFreshestAt ? `freshest ${formatRelative(tokenPricesFreshestAt)}` : '—'}
        />
        <StatCard
          label="DB size"
          value={dbSizePretty}
          sub={`${formatBytes(dbSizeBytes)} (${formatNumber(dbSizeBytes)} bytes)`}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SectionCard
          title="By source"
          description="Holdings.source = how the position got into the database."
          flushBody
        >
          {bySource.length > 0 ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead className="text-right">Holdings</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {bySource.map((r) => (
                  <TableRow key={r.source}>
                    <TableCell className="font-mono">{r.source}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(r.count)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <div className="p-4 text-xs text-muted-foreground">No holdings yet.</div>
          )}
        </SectionCard>

        <SectionCard title="Probes" description="Operational signals from the holdings table.">
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-xs">
            <dt className="text-muted-foreground">Active holdings stale &gt; 24h</dt>
            <dd className="font-mono tabular-nums">{formatNumber(staleActive)}</dd>
            <dt className="text-muted-foreground">User wallet rows</dt>
            <dd className="font-mono tabular-nums">{formatNumber(userWallets)}</dd>
          </dl>
        </SectionCard>
      </div>
    </>
  );
}
