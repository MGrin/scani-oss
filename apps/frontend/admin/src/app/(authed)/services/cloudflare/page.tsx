import { formatCurrency, formatRelative } from '@scani/shared';
import { ErrorPanel } from '@/components/ErrorPanel';
import { MetricTile } from '@/components/MetricTile';
import { Section } from '@/components/Section';
import {
  getBillingHistory,
  getBillingProfile,
  getDnsRecords,
  getPagesProjects,
  getR2Buckets,
  getZones,
} from '@/lib/clients/cloudflare';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function CloudflarePage() {
  const [pages, r2, zones, billing, history] = await Promise.all([
    getPagesProjects(),
    getR2Buckets(),
    getZones(),
    getBillingProfile(),
    getBillingHistory(),
  ]);

  const primaryZone = zones.ok ? zones.data[0] : null;
  const dns = primaryZone ? await getDnsRecords(primaryZone.id) : null;

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Cloudflare</h1>
      <p className="text-xs text-neutral-400 mb-6">
        Pages (frontend + landing), R2 (tfstate + backups), DNS zone
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        <MetricTile label="Pages projects" value={pages.ok ? pages.data.length : '—'} />
        <MetricTile label="R2 buckets" value={r2.ok ? r2.data.length : '—'} />
        <MetricTile label="Zones" value={zones.ok ? zones.data.length : '—'} />
        <MetricTile
          label="Primary zone"
          value={primaryZone?.name ?? '—'}
          sub={primaryZone?.plan ?? ''}
        />
      </div>

      <Section title="Billing profile">
        {billing.ok ? (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <MetricTile
              label="Account holder"
              value={
                [billing.data.firstName, billing.data.lastName].filter(Boolean).join(' ') || '—'
              }
              sub={billing.data.country ?? undefined}
            />
            <MetricTile
              label="Payment method"
              value={billing.data.paymentMethodType ?? '—'}
              sub={billing.data.lastFour ? `•••• ${billing.data.lastFour}` : undefined}
            />
            <MetricTile label="Updated" value={formatRelative(billing.data.edited)} />
            <MetricTile label="Profile id" value={billing.data.id ?? '—'} />
          </div>
        ) : (
          <ErrorPanel service="Billing profile" error={billing.error} />
        )}
      </Section>

      <Section title="Billing history (last 10)">
        {history.ok ? (
          history.data.length > 0 ? (
            <table className="w-full text-xs">
              <thead className="text-neutral-500">
                <tr>
                  <th className="text-left font-normal py-1">date</th>
                  <th className="text-left font-normal py-1">type</th>
                  <th className="text-left font-normal py-1">action</th>
                  <th className="text-left font-normal py-1">description</th>
                  <th className="text-right font-normal py-1">amount</th>
                </tr>
              </thead>
              <tbody>
                {history.data.map((h) => (
                  <tr key={h.id} className="border-t border-neutral-800/60">
                    <td className="py-1 text-neutral-400">{formatRelative(h.occurredAt)}</td>
                    <td className="py-1">{h.type}</td>
                    <td className="py-1 text-neutral-400">{h.action}</td>
                    <td className="py-1">{h.description}</td>
                    <td className="py-1 text-right font-mono">
                      {formatCurrency(h.amount, h.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-xs text-neutral-500">No billing history.</div>
          )
        ) : (
          <ErrorPanel service="Billing history" error={history.error} />
        )}
      </Section>

      <Section title="Pages projects">
        {pages.ok ? (
          <div className="space-y-3">
            {pages.data.map((p) => (
              <div
                key={p.name}
                className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold">{p.name}</div>
                    <div className="text-xs text-neutral-400">
                      branch {p.productionBranch} · subdomain {p.subdomain}
                    </div>
                  </div>
                  {p.latestDeployment ? (
                    <div className="text-right text-xs text-neutral-400">
                      <div>deploy {p.latestDeployment.stage}</div>
                      <div>{formatRelative(p.latestDeployment.createdAt)}</div>
                    </div>
                  ) : (
                    <div className="text-xs text-neutral-500">no deployments</div>
                  )}
                </div>
                {p.latestDeployment?.source ? (
                  <div className="mt-2 text-xs text-neutral-400 italic">
                    {p.latestDeployment.source}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <ErrorPanel service="Pages" error={pages.error} />
        )}
      </Section>

      <Section title="R2 buckets">
        {r2.ok ? (
          <table className="w-full text-xs">
            <thead className="text-neutral-500">
              <tr>
                <th className="text-left font-normal py-1">name</th>
                <th className="text-left font-normal py-1">location</th>
                <th className="text-left font-normal py-1">created</th>
              </tr>
            </thead>
            <tbody>
              {r2.data.map((b) => (
                <tr key={b.name} className="border-t border-neutral-800/60">
                  <td className="py-1 font-mono">{b.name}</td>
                  <td className="py-1">{b.location ?? '—'}</td>
                  <td className="py-1 text-neutral-400">{formatRelative(b.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ErrorPanel service="R2" error={r2.error} />
        )}
      </Section>

      <Section title={`DNS — ${primaryZone?.name ?? '(no zone)'}`}>
        {dns?.ok ? (
          <table className="w-full text-xs">
            <thead className="text-neutral-500">
              <tr>
                <th className="text-left font-normal py-1">name</th>
                <th className="text-left font-normal py-1">type</th>
                <th className="text-left font-normal py-1">content</th>
                <th className="text-left font-normal py-1">proxied</th>
              </tr>
            </thead>
            <tbody>
              {dns.data.map((r) => (
                <tr
                  key={`${r.name}-${r.type}-${r.content}`}
                  className="border-t border-neutral-800/60"
                >
                  <td className="py-1">{r.name}</td>
                  <td className="py-1 text-neutral-400">{r.type}</td>
                  <td className="py-1 font-mono">{r.content}</td>
                  <td className="py-1">{r.proxied ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : dns && !dns.ok ? (
          <ErrorPanel service="DNS" error={dns.error} />
        ) : (
          <div className="text-xs text-neutral-500">No zone available.</div>
        )}
      </Section>
    </div>
  );
}
