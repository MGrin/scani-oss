import { formatCurrency } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getSpendSummary, type SpendConfidence } from '@/lib/clients/spend';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const CONFIDENCE_VARIANT: Record<SpendConfidence, 'default' | 'outline' | 'secondary'> = {
  invoiced: 'default',
  estimated: 'secondary',
  unknown: 'outline',
};

const PROVIDER_LABEL: Record<string, string> = {
  cloudflare: 'Cloudflare',
  fly: 'Fly.io',
  neon: 'Neon',
  upstash: 'Upstash',
  sentry: 'Sentry',
};

export default async function SpendPage() {
  const fetchedAt = new Date().toISOString();
  const result = await getSpendSummary();
  if (!result.ok) {
    return (
      <>
        <PageHeader title="Monthly spend" fetchedAt={fetchedAt} />
        <ErrorPanel service="Spend" error={result.error} />
      </>
    );
  }
  const { totalUsd, invoicedUsd, estimatedUsd, lineItems, assumptions } = result.data;
  const unknownCount = lineItems.filter((l) => l.confidence === 'unknown').length;

  return (
    <>
      <PageHeader
        title="Monthly spend"
        description={
          <>
            Composite month-to-date rollup. Each line carries a confidence chip:{' '}
            <Badge variant="default" className="mx-0.5">
              invoiced
            </Badge>{' '}
            (real vendor billing data),{' '}
            <Badge variant="secondary" className="mx-0.5">
              estimated
            </Badge>{' '}
            (usage × public-tier pricing — see assumptions below), or{' '}
            <Badge variant="outline" className="mx-0.5">
              unknown
            </Badge>{' '}
            (vendor API doesn't expose enough to compute a number).
          </>
        }
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total month-to-date" value={formatCurrency(totalUsd, 'USD')} />
        <StatCard
          label="Invoiced"
          value={formatCurrency(invoicedUsd, 'USD')}
          sub="Real vendor billing"
        />
        <StatCard
          label="Estimated"
          value={formatCurrency(estimatedUsd, 'USD')}
          sub="Usage × public tier"
        />
        <StatCard
          label="Unknown line items"
          value={unknownCount}
          sub={unknownCount > 0 ? 'See vendor dashboards' : 'all providers modelled'}
        />
      </div>

      <SectionCard
        title="Line items"
        description="Sorted by confidence then amount. Invoiced lines reflect what the vendor actually charged this month; estimates are computed at page load."
        className="mt-6"
        flushBody
      >
        {lineItems.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Provider</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Basis</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lineItems.map((item) => (
                  <TableRow
                    key={`${item.provider}-${item.period}-${item.label}-${item.amount}-${item.currency}`}
                  >
                    <TableCell>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {PROVIDER_LABEL[item.provider] ?? item.provider}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{item.label}</TableCell>
                    <TableCell>
                      <Badge variant={CONFIDENCE_VARIANT[item.confidence]}>{item.confidence}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {item.confidence === 'unknown' ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        formatCurrency(item.amount, item.currency)
                      )}
                    </TableCell>
                    <TableCell className="max-w-md text-xs text-muted-foreground">
                      {item.basis ?? item.period}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">No line items.</div>
        )}
      </SectionCard>

      <SectionCard
        title="Pricing assumptions"
        description="The constants used to compute estimated line items. Update both these AND src/lib/clients/spend.ts in lockstep when a vendor changes their list price."
        className="mt-6"
        flushBody
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Component</TableHead>
              <TableHead>Rate</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {assumptions.map((a) => (
              <TableRow key={a.label}>
                <TableCell className="font-medium">{a.label}</TableCell>
                <TableCell className="font-mono text-xs">{a.rate}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{a.source}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>
    </>
  );
}
