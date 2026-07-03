import { formatBytes, formatCurrency, formatNumber, formatRelative } from '@scani/shared';
import { Alert, AlertDescription, AlertTitle } from '@scani/ui/ui/alert';
import { Activity, CheckCircle2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/PageHeader';
import { type Status, StatusBadge } from '@/components/StatusBadge';
import { StreamingCard } from '@/components/StreamingCard';
import { getAppDbStats } from '@/lib/clients/appDb';
import { getBackendHealth } from '@/lib/clients/backendHealth';
import { getQueueDepths } from '@/lib/clients/bullmq';
import { getBillingProfile, getPagesProjects, getR2Buckets } from '@/lib/clients/cloudflare';
import { getFastmailStatus } from '@/lib/clients/fastmail';
import { getFlyOverview } from '@/lib/clients/fly';
import { getRecentRuns } from '@/lib/clients/github';
import { getNeonOverviewSummary } from '@/lib/clients/neon';
import { getSentryOverviewSummary } from '@/lib/clients/sentry';
import { getSpendSummary } from '@/lib/clients/spend';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const fetchedAt = new Date().toISOString();

  return (
    <div>
      <PageHeader
        title="Infrastructure overview"
        description="Live data pulled directly from each provider on every page load."
        fetchedAt={fetchedAt}
      />

      <BackendHealthStrip />

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StreamingCard
          title={<CardTitleLink href="/platform/fly">Fly.io</CardTitleLink>}
          description="api, worker, data-provider"
        >
          <FlyCard />
        </StreamingCard>

        <StreamingCard
          title={<CardTitleLink href="/platform/neon">Neon Postgres</CardTitleLink>}
          description="App database"
        >
          <NeonCard />
        </StreamingCard>

        <StreamingCard
          title={<CardTitleLink href="/platform/cloudflare">Cloudflare</CardTitleLink>}
          description="Pages · R2 · billing"
        >
          <CloudflareCard />
        </StreamingCard>

        <StreamingCard
          title={<CardTitleLink href="/platform/github">GitHub</CardTitleLink>}
          description="CI / repo"
        >
          <GithubCard />
        </StreamingCard>

        <StreamingCard
          title={<CardTitleLink href="/platform/fastmail">Fastmail</CardTitleLink>}
          description="Transactional email"
        >
          <FastmailCard />
        </StreamingCard>

        <StreamingCard
          title={<CardTitleLink href="/platform/sentry">Sentry</CardTitleLink>}
          description="Error tracking"
        >
          <SentryCard />
        </StreamingCard>

        <StreamingCard
          title={<CardTitleLink href="/app/holdings">App database</CardTitleLink>}
          description="Users · holdings · integrations"
        >
          <AppDbCard />
        </StreamingCard>

        <StreamingCard
          title={<CardTitleLink href="/jobs/queue">BullMQ queue</CardTitleLink>}
          description="scani-jobs"
        >
          <QueueCard />
        </StreamingCard>

        <StreamingCard
          title={<CardTitleLink href="/spend">Monthly spend</CardTitleLink>}
          description="Invoiced + estimated rollup"
        >
          <SpendCard />
        </StreamingCard>
      </div>
    </div>
  );
}

function CardTitleLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="hover:text-primary transition-colors">
      {children}
    </Link>
  );
}

async function BackendHealthStrip() {
  const backend = await getBackendHealth();
  const ok = backend.ok && backend.data.ok;
  return (
    <Alert variant={ok ? 'default' : 'destructive'}>
      {ok ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
      <AlertTitle className="flex items-center gap-2">
        <span>api.scani.xyz</span>
        <StatusBadge status={ok ? 'ok' : 'error'} />
      </AlertTitle>
      <AlertDescription className="font-mono text-[11px]">
        {backend.ok ? (
          <>
            HTTP {backend.data.statusCode}
            {' · '}
            {typeof backend.data.payload === 'object'
              ? JSON.stringify(backend.data.payload)
              : String(backend.data.payload)}
          </>
        ) : (
          backend.error
        )}
      </AlertDescription>
    </Alert>
  );
}

async function FlyCard() {
  const fly = await getFlyOverview();
  if (!fly.ok) return <CardError message={fly.error} />;
  return (
    <CardBody
      status="ok"
      statusLabel={fly.data.billingStatus ?? 'ok'}
      rows={[
        { label: 'Org', value: fly.data.slug },
        { label: 'Apps', value: `${fly.data.apps.length}` },
        { label: 'Apps list', value: fly.data.apps.map((a) => a.name).join(' · ') },
      ]}
    />
  );
}

async function NeonCard() {
  // Uses the lighter `getNeonOverviewSummary` — one HTTP call (no
  // per-project branches fan-out) and a longer TTL. Saves N+1
  // subrequests vs `getNeonProjects` and keeps us under the Cloudflare
  // Worker subrequest cap on the Overview page.
  const neon = await getNeonOverviewSummary();
  if (!neon.ok) return <CardError message={neon.error} />;
  const p = neon.data[0];
  if (!p) return <CardBody status="warn" statusLabel="no projects" rows={[]} />;
  return (
    <CardBody
      status="ok"
      statusLabel={p.plan ?? 'ok'}
      rows={[
        { label: 'Project', value: `${p.name} · pg${p.pgVersion} · ${p.regionId}` },
        { label: 'Storage', value: formatBytes(p.storageBytes) },
        { label: 'CPU-hours', value: `${p.computeHours}` },
      ]}
    />
  );
}

async function CloudflareCard() {
  const [pages, r2, billing] = await Promise.all([
    getPagesProjects(),
    getR2Buckets(),
    getBillingProfile(),
  ]);
  const status: Status =
    pages.ok && r2.ok && billing.ok ? 'ok' : pages.ok || r2.ok ? 'warn' : 'error';
  return (
    <CardBody
      status={status}
      statusLabel={billing.ok ? (billing.data.paymentMethodType ?? 'billing ok') : 'partial'}
      rows={[
        {
          label: 'Pages',
          value: pages.ok ? `${pages.data.length} projects` : pages.error,
          dim: !pages.ok,
        },
        {
          label: 'R2',
          value: r2.ok
            ? `${r2.data.length} buckets · ${r2.data.map((b) => b.name).join(', ')}`
            : r2.error,
          dim: !r2.ok,
        },
        {
          label: 'Billing',
          value: billing.ok
            ? `${billing.data.paymentMethodType ?? 'unknown'}${billing.data.lastFour ? ` •••• ${billing.data.lastFour}` : ''}`
            : billing.error,
          dim: !billing.ok,
        },
      ]}
    />
  );
}

async function GithubCard() {
  const runs = await getRecentRuns(5);
  if (!runs.ok) return <CardError message={runs.error} />;
  const latest = runs.data[0];
  return (
    <CardBody
      status="ok"
      statusLabel={latest?.conclusion ?? latest?.status ?? 'ok'}
      rows={[
        { label: 'Latest', value: latest?.name ?? '—' },
        {
          label: 'Branch',
          value: latest ? `${latest.headBranch} · ${formatRelative(latest.createdAt)}` : '—',
        },
      ]}
    />
  );
}

async function FastmailCard() {
  const fm = await getFastmailStatus();
  if (!fm.ok) return <CardError message={fm.error} />;
  const status: Status = fm.data.tokenConfigured ? 'ok' : 'warn';
  return (
    <CardBody
      status={status}
      statusLabel={fm.data.tokenConfigured ? 'configured' : 'no token'}
      rows={[
        { label: 'User', value: fm.data.username ?? '—' },
        { label: 'Billing API', value: 'not exposed', dim: true },
      ]}
    />
  );
}

async function SentryCard() {
  // Uses the lighter `getSentryOverviewSummary` — 2 subrequests
  // instead of `getSentryOverview`'s 2 + (5 projects × 2) = 12. The
  // dedicated /platform/sentry page still loads the per-project
  // unresolved + latest-release detail via the heavier endpoint.
  const sentry = await getSentryOverviewSummary();
  if (!sentry.ok) return <CardError message={sentry.error} />;
  return (
    <CardBody
      status="ok"
      statusLabel={`${sentry.data.totalProjects} projects`}
      rows={[
        { label: 'Events 7d', value: formatNumber(sentry.data.events7d) },
        { label: 'Active', value: `${sentry.data.activeProjects} project(s)` },
      ]}
    />
  );
}

async function AppDbCard() {
  const db = await getAppDbStats();
  if (!db.ok) return <CardError message={db.error} />;
  return (
    <CardBody
      status="ok"
      statusLabel={db.data.dbSizePretty}
      rows={[
        { label: 'Users', value: formatNumber(db.data.users) },
        { label: 'Sessions', value: formatNumber(db.data.activeSessions) },
        { label: 'Integrations', value: formatNumber(db.data.userIntegrationCredentials) },
        { label: 'Holdings', value: formatNumber(db.data.holdings) },
        {
          label: 'Prices fresh',
          value: formatRelative(db.data.tokenPricesFreshestAt),
          dim: true,
        },
      ]}
    />
  );
}

async function QueueCard() {
  const q = await getQueueDepths();
  if (!q.ok) return <CardError message={q.error} />;
  const status: Status = q.data.failed > 0 ? 'warn' : 'ok';
  return (
    <CardBody
      status={status}
      statusLabel={`${q.data.failed} failed`}
      rows={[
        { label: 'Queue', value: q.data.queue },
        {
          label: 'State',
          value: `${q.data.waiting} waiting · ${q.data.active} active · ${q.data.delayed} delayed`,
        },
        { label: 'Completed', value: formatNumber(q.data.completed) },
      ]}
    />
  );
}

async function SpendCard() {
  const spend = await getSpendSummary();
  if (!spend.ok) return <CardError message={spend.error} />;
  const { totalUsd, invoicedUsd, estimatedUsd, lineItems } = spend.data;
  const unknown = lineItems.filter((l) => l.confidence === 'unknown').length;
  return (
    <CardBody
      status="ok"
      statusLabel={formatCurrency(totalUsd, 'USD')}
      rows={[
        { label: 'Invoiced', value: formatCurrency(invoicedUsd, 'USD') },
        { label: 'Estimated', value: formatCurrency(estimatedUsd, 'USD'), dim: true },
        {
          label: 'Unknown',
          value: unknown > 0 ? `${unknown} line${unknown === 1 ? '' : 's'}` : 'all modelled',
          dim: true,
        },
      ]}
    />
  );
}

interface Row {
  label: string;
  value: React.ReactNode;
  dim?: boolean;
}

function CardBody({
  status,
  statusLabel,
  rows,
}: {
  status: Status;
  statusLabel?: string;
  rows: Row[];
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <StatusBadge status={status} label={statusLabel} />
        <Activity className="h-3 w-3 text-muted-foreground/40" />
      </div>
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
        {rows.map((r) => (
          <RowDef key={r.label} row={r} />
        ))}
      </dl>
    </div>
  );
}

function RowDef({ row }: { row: Row }) {
  return (
    <>
      <dt className="text-muted-foreground/70 uppercase tracking-wide text-[10px] self-center">
        {row.label}
      </dt>
      <dd className={`tabular-nums ${row.dim ? 'text-muted-foreground' : 'text-foreground'}`}>
        {row.value}
      </dd>
    </>
  );
}

function CardError({ message }: { message: string }) {
  return (
    <div className="flex flex-col gap-2">
      <StatusBadge status="error" />
      <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-destructive">
        {message}
      </pre>
    </div>
  );
}
