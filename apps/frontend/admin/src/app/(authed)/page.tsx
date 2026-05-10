import { formatBytes, formatNumber, formatRelative } from '@scani/shared';
import { ServiceCard, type ServiceStatus } from '@/components/ServiceCard';
import { getAppDbStats } from '@/lib/clients/appDb';
import { getBackendHealth } from '@/lib/clients/backendHealth';
import { getBillingProfile, getPagesProjects, getR2Buckets } from '@/lib/clients/cloudflare';
import { getFastmailStatus } from '@/lib/clients/fastmail';
import { getFlyOverview } from '@/lib/clients/fly';
import { getRecentRuns } from '@/lib/clients/github';
import { getNeonProjects } from '@/lib/clients/neon';
import { getSentryOverview } from '@/lib/clients/sentry';
import { getQueueDepths, getUpstashDatabases } from '@/lib/clients/upstash';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const [
    backend,
    fly,
    neon,
    upstashDbs,
    queue,
    pages,
    r2,
    cfBilling,
    runs,
    fastmail,
    appDb,
    sentry,
  ] = await Promise.all([
    getBackendHealth(),
    getFlyOverview(),
    getNeonProjects(),
    getUpstashDatabases(),
    getQueueDepths(),
    getPagesProjects(),
    getR2Buckets(),
    getBillingProfile(),
    getRecentRuns(5),
    getFastmailStatus(),
    getAppDbStats(),
    getSentryOverview(),
  ]);

  const backendStatus: ServiceStatus = backend.ok && backend.data.ok ? 'ok' : 'error';

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Infrastructure overview</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Live data pulled directly from each provider · refreshed on every page load
          </p>
        </div>
        <div className="text-xs text-muted-foreground">
          {new Date().toUTCString().replace('GMT', 'UTC')}
        </div>
      </div>

      <div className="mb-6 rounded-lg border border-border bg-card/40 p-4">
        <div className="flex items-center gap-3">
          <span
            className={`inline-block w-3 h-3 rounded-full ${
              backendStatus === 'ok' ? 'bg-emerald-500' : 'bg-red-500'
            }`}
          />
          <div className="text-sm">
            <span className="font-semibold">api.scani.xyz/health</span>
            {backend.ok ? (
              <span className="ml-3 text-muted-foreground">
                HTTP {backend.data.statusCode} ·{' '}
                {typeof backend.data.payload === 'object'
                  ? JSON.stringify(backend.data.payload)
                  : String(backend.data.payload)}
              </span>
            ) : (
              <span className="ml-3 text-red-300">{backend.error}</span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <ServiceCard
          title="Fly.io"
          href="/services/fly"
          status={fly.ok ? 'ok' : 'error'}
          statusLabel={fly.ok ? (fly.data.billingStatus ?? 'ok') : 'error'}
        >
          {fly.ok ? (
            <>
              <div>
                {fly.data.apps.length} apps · org {fly.data.slug}
              </div>
              <div className="text-muted-foreground">
                {fly.data.apps.map((a) => a.name).join(' · ')}
              </div>
            </>
          ) : (
            <div className="text-red-300">{fly.error}</div>
          )}
        </ServiceCard>

        <ServiceCard
          title="Neon Postgres"
          href="/services/neon"
          status={neon.ok ? 'ok' : 'error'}
          statusLabel={neon.ok ? (neon.data[0]?.plan ?? 'ok') : 'error'}
        >
          {neon.ok ? (
            neon.data[0] ? (
              <>
                <div>
                  {neon.data[0].name} · pg{neon.data[0].pgVersion} · {neon.data[0].regionId}
                </div>
                <div className="text-muted-foreground">
                  {neon.data[0].branchCount} branch
                  {neon.data[0].branchCount === 1 ? '' : 'es'} ·{' '}
                  {formatBytes(neon.data[0].syntheticStorageSize ?? neon.data[0].storeBytes)} store
                </div>
                <div className="text-muted-foreground">
                  {neon.data[0].computeHours} CPU-hours ·{' '}
                  {formatBytes(neon.data[0].writtenDataBytes)} written
                </div>
              </>
            ) : (
              <div>No projects</div>
            )
          ) : (
            <div className="text-red-300">{neon.error}</div>
          )}
        </ServiceCard>

        <ServiceCard
          title="Upstash Redis"
          href="/services/upstash"
          status={upstashDbs.ok ? 'ok' : 'error'}
          statusLabel={upstashDbs.ok ? (upstashDbs.data[0]?.state ?? 'ok') : 'error'}
        >
          {upstashDbs.ok ? (
            upstashDbs.data[0] ? (
              <>
                <div>
                  {upstashDbs.data[0].name} · {upstashDbs.data[0].type} ·{' '}
                  {upstashDbs.data[0].region}
                </div>
                <div className="text-muted-foreground">
                  {formatNumber(upstashDbs.data[0].totalCommands)} cmds ·{' '}
                  {formatBytes(upstashDbs.data[0].totalDailyBandwidth)}/d
                </div>
              </>
            ) : (
              <div>No databases</div>
            )
          ) : (
            <div className="text-red-300">{upstashDbs.error}</div>
          )}
        </ServiceCard>

        <ServiceCard
          title="Cloudflare"
          href="/services/cloudflare"
          status={pages.ok && r2.ok && cfBilling.ok ? 'ok' : pages.ok || r2.ok ? 'warn' : 'error'}
          statusLabel={
            cfBilling.ok ? (cfBilling.data.paymentMethodType ?? 'billing ok') : 'partial'
          }
        >
          {pages.ok ? (
            <div>{pages.data.length} Pages projects</div>
          ) : (
            <div className="text-red-300">pages: {pages.error}</div>
          )}
          {r2.ok ? (
            <div className="text-muted-foreground">
              R2: {r2.data.length} bucket{r2.data.length === 1 ? '' : 's'} ·{' '}
              {r2.data.map((b) => b.name).join(', ')}
            </div>
          ) : (
            <div className="text-red-300 text-xs">r2: {r2.error}</div>
          )}
          {cfBilling.ok ? (
            <div className="text-muted-foreground">
              Billing: {cfBilling.data.paymentMethodType ?? 'unknown'}
              {cfBilling.data.lastFour ? ` •••• ${cfBilling.data.lastFour}` : ''}
            </div>
          ) : (
            <div className="text-muted-foreground text-xs">billing: {cfBilling.error}</div>
          )}
        </ServiceCard>

        <ServiceCard
          title="GitHub"
          href="/services/github"
          status={runs.ok ? 'ok' : 'error'}
          statusLabel={
            runs.ok ? (runs.data[0]?.conclusion ?? runs.data[0]?.status ?? 'ok') : 'error'
          }
        >
          {runs.ok ? (
            <>
              <div>Last CI: {runs.data[0]?.name ?? '—'}</div>
              {runs.data[0] ? (
                <div className="text-muted-foreground">
                  {runs.data[0].headBranch} · {formatRelative(runs.data[0].createdAt)}
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-red-300 text-xs">{runs.error}</div>
          )}
        </ServiceCard>

        <ServiceCard
          title="Fastmail"
          href="/services/fastmail"
          status={fastmail.ok ? (fastmail.data.tokenConfigured ? 'ok' : 'warn') : 'error'}
          statusLabel={
            fastmail.ok ? (fastmail.data.tokenConfigured ? 'configured' : 'no token') : 'error'
          }
        >
          {fastmail.ok ? (
            fastmail.data.tokenConfigured ? (
              <>
                <div>{fastmail.data.username ?? '—'}</div>
                <div className="text-muted-foreground">No public billing API</div>
              </>
            ) : (
              <div className="text-muted-foreground">Token not configured</div>
            )
          ) : (
            <div className="text-red-300">{fastmail.error}</div>
          )}
        </ServiceCard>

        <ServiceCard
          title="Sentry"
          href="/services/sentry"
          status={
            sentry.ok
              ? sentry.data.reduce((acc, p) => acc + p.unresolvedIssues, 0) > 0
                ? 'warn'
                : 'ok'
              : 'error'
          }
          statusLabel={
            sentry.ok
              ? `${sentry.data.reduce((acc, p) => acc + p.unresolvedIssues, 0)} unresolved`
              : 'error'
          }
        >
          {sentry.ok ? (
            <>
              <div>
                {sentry.data.length} project{sentry.data.length === 1 ? '' : 's'} ·{' '}
                {formatNumber(sentry.data.reduce((acc, p) => acc + p.events7d, 0))} events 7d
              </div>
              <div className="text-muted-foreground">
                {sentry.data
                  .filter((p) => p.unresolvedIssues > 0)
                  .map((p) => `${p.slug} (${p.unresolvedIssues})`)
                  .join(' · ') || 'no open issues'}
              </div>
            </>
          ) : (
            <div className="text-red-300">{sentry.error}</div>
          )}
        </ServiceCard>

        <ServiceCard title="App database" href="/app-stats" status={appDb.ok ? 'ok' : 'error'}>
          {appDb.ok ? (
            <>
              <div>
                {formatNumber(appDb.data.users)} users · {formatNumber(appDb.data.activeSessions)}{' '}
                active sessions
              </div>
              <div className="text-muted-foreground">
                {formatNumber(appDb.data.userIntegrationCredentials)} integrations ·{' '}
                {formatNumber(appDb.data.holdings)} holdings
              </div>
              <div className="text-muted-foreground">
                {appDb.data.dbSizePretty} · prices fresh{' '}
                {formatRelative(appDb.data.tokenPricesFreshestAt)}
              </div>
            </>
          ) : (
            <div className="text-red-300">{appDb.error}</div>
          )}
        </ServiceCard>

        <ServiceCard
          title="BullMQ queue"
          status={queue.ok ? (queue.data.failed > 0 ? 'warn' : 'ok') : 'error'}
          statusLabel={queue.ok ? `${queue.data.failed} failed` : 'error'}
        >
          {queue.ok ? (
            <>
              <div>{queue.data.queue}</div>
              <div className="text-muted-foreground">
                {queue.data.waiting} waiting · {queue.data.active} active · {queue.data.delayed}{' '}
                delayed
              </div>
              <div className="text-muted-foreground">
                {formatNumber(queue.data.completed)} completed (window)
              </div>
            </>
          ) : (
            <div className="text-red-300">{queue.error}</div>
          )}
        </ServiceCard>
      </div>
    </div>
  );
}
