import { formatNumber, formatRelative } from '@scani/shared';
import { ErrorPanel } from '@/components/ErrorPanel';
import { MetricTile } from '@/components/MetricTile';
import { Section } from '@/components/Section';
import { getAppDbStats } from '@/lib/clients/appDb';
import { getBackendDbHealth, getBackendHealth } from '@/lib/clients/backendHealth';
import { getQueueDepths } from '@/lib/clients/upstash';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function AppStatsPage() {
  const [stats, health, dbHealth, queue] = await Promise.all([
    getAppDbStats(),
    getBackendHealth(),
    getBackendDbHealth(),
    getQueueDepths(),
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">App stats</h1>
      <p className="text-xs text-muted-foreground mb-6">
        Live counts from the production database and BullMQ queue
      </p>

      <Section title="Backend health">
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-lg border border-border bg-card/40 p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">/health</div>
            {health.ok ? (
              <div className="text-sm mt-1">
                <span
                  className={`inline-block w-2 h-2 rounded-full mr-2 ${
                    health.data.ok ? 'bg-emerald-500' : 'bg-red-500'
                  }`}
                />
                HTTP {health.data.statusCode} ·{' '}
                {typeof health.data.payload === 'object'
                  ? JSON.stringify(health.data.payload)
                  : String(health.data.payload)}
              </div>
            ) : (
              <div className="text-red-300 text-sm mt-1">{health.error}</div>
            )}
          </div>
          <div className="rounded-lg border border-border bg-card/40 p-4">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">/health/db</div>
            {dbHealth.ok ? (
              <div className="text-sm mt-1">
                <span
                  className={`inline-block w-2 h-2 rounded-full mr-2 ${
                    dbHealth.data.ok ? 'bg-emerald-500' : 'bg-red-500'
                  }`}
                />
                HTTP {dbHealth.data.statusCode}
              </div>
            ) : (
              <div className="text-red-300 text-sm mt-1">{dbHealth.error}</div>
            )}
          </div>
        </div>
      </Section>

      <Section title="Queue (scani-jobs)">
        {queue.ok ? (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <MetricTile label="Waiting" value={queue.data.waiting} />
            <MetricTile label="Active" value={queue.data.active} />
            <MetricTile label="Delayed" value={queue.data.delayed} />
            <MetricTile label="Failed" value={queue.data.failed} />
            <MetricTile label="Completed" value={formatNumber(queue.data.completed)} />
          </div>
        ) : (
          <ErrorPanel service="Queue" error={queue.error} />
        )}
      </Section>

      {stats.ok ? (
        <>
          <Section title="Users & portfolios">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <MetricTile label="Users" value={formatNumber(stats.data.users)} />
              <MetricTile label="Active sessions" value={formatNumber(stats.data.activeSessions)} />
              <MetricTile label="Vaults (portfolios)" value={formatNumber(stats.data.vaults)} />
              <MetricTile label="Accounts" value={formatNumber(stats.data.accounts)} />
            </div>
          </Section>

          <Section title="Holdings & pricing">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <MetricTile label="Holdings" value={formatNumber(stats.data.holdings)} />
              <MetricTile label="Tokens" value={formatNumber(stats.data.tokens)} />
              <MetricTile
                label="Token price rows"
                value={formatNumber(stats.data.tokenPrices)}
                sub={`freshest ${formatRelative(stats.data.tokenPricesFreshestAt)}`}
              />
              <MetricTile
                label="DB size"
                value={stats.data.dbSizePretty}
                sub={`${formatNumber(stats.data.dbSizeBytes)} bytes`}
              />
            </div>
          </Section>

          <Section title="Integrations">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
              <MetricTile
                label="Integration credentials"
                value={formatNumber(stats.data.userIntegrationCredentials)}
              />
              <MetricTile label="Institutions" value={formatNumber(stats.data.institutions)} />
              <MetricTile label="User wallets" value={formatNumber(stats.data.userWallets)} />
            </div>
            {stats.data.integrationsByInstitution.length > 0 && (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-normal py-1">institution</th>
                    <th className="text-left font-normal py-1">credentials</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.data.integrationsByInstitution.map((r) => (
                    <tr key={r.institution} className="border-t border-border/60">
                      <td className="py-1">{r.institution}</td>
                      <td className="py-1 font-mono">{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title="Top institutions by account count">
            {stats.data.topInstitutions.length > 0 ? (
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left font-normal py-1">institution</th>
                    <th className="text-left font-normal py-1">accounts</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.data.topInstitutions.map((r) => (
                    <tr key={r.institution} className="border-t border-border/60">
                      <td className="py-1">{r.institution}</td>
                      <td className="py-1 font-mono">{r.accounts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="text-xs text-muted-foreground">No accounts yet.</div>
            )}
          </Section>
        </>
      ) : (
        <ErrorPanel service="App database" error={stats.error} />
      )}
    </div>
  );
}
