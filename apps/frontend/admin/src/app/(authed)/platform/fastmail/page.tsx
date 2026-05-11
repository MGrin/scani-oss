import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getFastmailStatus } from '@/lib/clients/fastmail';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function FastmailPage() {
  const fetchedAt = new Date().toISOString();
  const status = await getFastmailStatus();

  return (
    <>
      <PageHeader
        title="Fastmail"
        description={
          <>
            Transactional email via JMAP. No public billing API — this page reports token presence
            and session capabilities only. Billing at{' '}
            <a
              href="https://www.fastmail.com/settings/subscriptions"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              fastmail.com/settings/subscriptions
            </a>
            .
          </>
        }
        fetchedAt={fetchedAt}
      />

      {status.ok ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatCard
              label="Token"
              value={status.data.tokenConfigured ? 'configured' : 'missing'}
            />
            <StatCard label="Username" value={status.data.username ?? '—'} />
            <StatCard label="Account" value={status.data.accountName ?? '—'} />
          </div>

          <SectionCard title="JMAP capabilities" className="mt-6">
            {status.data.capabilities.length > 0 ? (
              <ul className="space-y-1 font-mono text-xs text-muted-foreground">
                {status.data.capabilities.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              <div className="text-xs text-muted-foreground">None — token may lack scopes.</div>
            )}
          </SectionCard>
        </>
      ) : (
        <ErrorPanel service="Fastmail" error={status.error} />
      )}
    </>
  );
}
