import { formatNumber } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { type CredentialStyle, getProviderDetail } from '@/lib/clients/providerStatus';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const CREDENTIAL_VARIANT: Record<CredentialStyle, 'default' | 'outline' | 'secondary'> = {
  pool: 'outline',
  user: 'secondary',
  self: 'default',
};

const CREDENTIAL_LABEL: Record<CredentialStyle, string> = {
  pool: 'Pool credentials (Scani-owned, shared across all users)',
  user: 'Per-user credentials (each user supplies their own API keys)',
  self: 'Scani-owned credentials (one shared key for the whole platform)',
};

interface PageProps {
  params: { key: string };
}

export default async function ProviderDetailPage({ params }: PageProps) {
  const key = decodeURIComponent(params.key);
  const fetchedAt = new Date().toISOString();
  const result = await getProviderDetail(key);
  if (!result.ok) {
    return (
      <>
        <PageHeader title={`Providers / ${key}`} fetchedAt={fetchedAt} />
        <ErrorPanel service={`Provider ${key}`} error={result.error} />
      </>
    );
  }
  if (!result.data) return notFound();
  const { entry } = result.data;

  return (
    <>
      <PageHeader
        title={
          <>
            <Link href="/providers" className="text-muted-foreground hover:text-foreground">
              Providers
            </Link>{' '}
            <span className="text-muted-foreground/70">/</span> {entry.name}
          </>
        }
        description={
          <>
            <span className="font-mono text-xs">{entry.key}</span> · {entry.description}
          </>
        }
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          label="Credentials"
          value={<Badge variant={CREDENTIAL_VARIANT[entry.credential]}>{entry.credential}</Badge>}
          sub={CREDENTIAL_LABEL[entry.credential]}
        />
        <StatCard
          label="Capabilities"
          value={
            <div className="flex flex-wrap gap-1">
              {entry.categories.map((c) => (
                <Badge key={c} variant="outline" className="text-[10px]">
                  {c}
                </Badge>
              ))}
            </div>
          }
        />
        <StatCard
          label="Rate-limit window"
          value={
            entry.rateLimitWindow !== null ? (
              formatNumber(entry.rateLimitWindow)
            ) : (
              <span className="text-muted-foreground">—</span>
            )
          }
          sub={
            entry.credential === 'user'
              ? 'sharded per user — SCAN coming in Phase 2.x'
              : `rl:${entry.key} sliding-window count`
          }
        />
      </div>

      <SectionCard title="Coming in Phase 2.x" className="mt-6">
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>
            Recent request history (success / failure / latency) — needs a per-call telemetry hook
            from <code className="font-mono">@scani/rate-limiter</code>.
          </li>
          <li>
            Circuit-breaker state (currently in-memory only — needs Redis-backed state to surface
            here).
          </li>
          <li>
            For per-user providers: SCAN <code className="font-mono">rl:{entry.key}:*</code> to
            sample top-N users by call volume.
          </li>
          <li>Recent failures with redacted payload from BullMQ history.</li>
        </ul>
      </SectionCard>
    </>
  );
}
