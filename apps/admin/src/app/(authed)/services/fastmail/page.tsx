import { ErrorPanel } from '@/components/ErrorPanel';
import { MetricTile } from '@/components/MetricTile';
import { Section } from '@/components/Section';
import { getFastmailStatus } from '@/lib/clients/fastmail';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function FastmailPage() {
  const status = await getFastmailStatus();

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Fastmail</h1>
      <p className="text-xs text-neutral-400 mb-6">
        Transactional email via JMAP. No public billing API — this page reports token presence and
        session capabilities only. Billing lives at{' '}
        <a
          href="https://www.fastmail.com/settings/subscriptions"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          fastmail.com/settings/subscriptions
        </a>
        .
      </p>

      {status.ok ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 mb-8">
            <MetricTile
              label="Token"
              value={status.data.tokenConfigured ? 'configured' : 'missing'}
            />
            <MetricTile label="Username" value={status.data.username ?? '—'} />
            <MetricTile label="Account" value={status.data.accountName ?? '—'} />
          </div>

          <Section title="JMAP capabilities">
            {status.data.capabilities.length > 0 ? (
              <ul className="text-xs font-mono text-neutral-400 space-y-1">
                {status.data.capabilities.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              <div className="text-xs text-neutral-500">None — token may lack scopes.</div>
            )}
          </Section>
        </>
      ) : (
        <ErrorPanel service="Fastmail" error={status.error} />
      )}
    </div>
  );
}
