import { formatNumber } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import Link from 'next/link';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { type CredentialStyle, getProviderCatalog } from '@/lib/clients/providerStatus';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const CREDENTIAL_VARIANT: Record<CredentialStyle, 'default' | 'outline' | 'secondary'> = {
  pool: 'outline',
  user: 'secondary',
  self: 'default',
};

const CREDENTIAL_LABEL: Record<CredentialStyle, string> = {
  pool: 'Pool',
  user: 'Per-user',
  self: 'Scani',
};

export default async function ProvidersPage() {
  const fetchedAt = new Date().toISOString();
  const result = await getProviderCatalog();
  if (!result.ok) {
    return (
      <>
        <PageHeader title="Providers" fetchedAt={fetchedAt} />
        <ErrorPanel service="Providers" error={result.error} />
      </>
    );
  }
  const providers = result.data;
  const counts = providers.reduce(
    (acc, p) => {
      acc[p.credential] = (acc[p.credential] ?? 0) + 1;
      return acc;
    },
    {} as Record<CredentialStyle, number>
  );

  return (
    <>
      <PageHeader
        title="Providers"
        description={
          <>
            28 third-party integrations under{' '}
            <code className="font-mono text-xs">packages/clients/providers</code>. Rate-limit
            "Window" reads the current sliding-window count from{' '}
            <code className="font-mono text-xs">rl:&lt;key&gt;</code> in Upstash. Per-user-keyed
            providers shard the limiter per user, so the page reports{' '}
            <code className="font-mono text-xs">—</code> for those (a representative number requires
            SCAN; coming in Phase 2.x).
          </>
        }
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total" value={providers.length} />
        <StatCard label="Pool credentials" value={formatNumber(counts.pool ?? 0)} />
        <StatCard label="Per-user credentials" value={formatNumber(counts.user ?? 0)} />
        <StatCard label="Scani-owned" value={formatNumber(counts.self ?? 0)} />
      </div>

      <SectionCard title="Catalog" className="mt-6" flushBody>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Capabilities</TableHead>
                <TableHead>Credentials</TableHead>
                <TableHead className="text-right">Window</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map((p) => (
                <TableRow key={p.key}>
                  <TableCell>
                    <Link
                      href={`/providers/${encodeURIComponent(p.key)}`}
                      className="hover:underline"
                    >
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">{p.name}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">{p.key}</span>
                      </div>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {p.categories.map((c) => (
                        <Badge key={c} variant="outline" className="text-[10px]">
                          {c}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={CREDENTIAL_VARIANT[p.credential]}>
                      {CREDENTIAL_LABEL[p.credential]}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.rateLimitWindow !== null ? (
                      formatNumber(p.rateLimitWindow)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </>
  );
}
