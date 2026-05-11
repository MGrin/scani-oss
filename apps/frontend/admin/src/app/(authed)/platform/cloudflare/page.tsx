import { formatCurrency, formatRelative } from '@scani/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ActionDialog } from '@/components/ActionDialog';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import {
  getBillingHistory,
  getBillingProfile,
  getDnsRecords,
  getPagesProjects,
  getR2Buckets,
  getZones,
} from '@/lib/clients/cloudflare';
import { writesEnabled } from '@/lib/writes';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function CloudflarePage() {
  const fetchedAt = new Date().toISOString();
  const [pages, r2, zones, billing, history] = await Promise.all([
    getPagesProjects(),
    getR2Buckets(),
    getZones(),
    getBillingProfile(),
    getBillingHistory(),
  ]);

  const primaryZone = zones.ok ? zones.data[0] : null;
  const dns = primaryZone ? await getDnsRecords(primaryZone.id) : null;
  const writes = writesEnabled();

  return (
    <>
      <PageHeader
        title="Cloudflare"
        description="Pages (frontends), R2 (tfstate + backups + uploads), DNS zone."
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Pages projects" value={pages.ok ? pages.data.length : '—'} />
        <StatCard label="R2 buckets" value={r2.ok ? r2.data.length : '—'} />
        <StatCard label="Zones" value={zones.ok ? zones.data.length : '—'} />
        <StatCard
          label="Primary zone"
          value={primaryZone?.name ?? '—'}
          sub={primaryZone?.plan ?? ''}
        />
      </div>

      <div className="mt-6 flex flex-col gap-6">
        <SectionCard title="Billing profile">
          {billing.ok ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label="Account holder"
                value={
                  [billing.data.firstName, billing.data.lastName].filter(Boolean).join(' ') || '—'
                }
                sub={billing.data.country ?? undefined}
              />
              <StatCard
                label="Payment method"
                value={billing.data.paymentMethodType ?? '—'}
                sub={billing.data.lastFour ? `•••• ${billing.data.lastFour}` : undefined}
              />
              <StatCard label="Updated" value={formatRelative(billing.data.edited)} />
              <StatCard label="Profile id" value={billing.data.id ?? '—'} />
            </div>
          ) : (
            <ErrorPanel service="Billing profile" error={billing.error} />
          )}
        </SectionCard>

        <SectionCard title="Billing history" description="Last 10 entries." flushBody>
          {history.ok ? (
            history.data.length > 0 ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.data.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell className="text-muted-foreground">
                          {formatRelative(h.occurredAt)}
                        </TableCell>
                        <TableCell>{h.type}</TableCell>
                        <TableCell className="text-muted-foreground">{h.action}</TableCell>
                        <TableCell>{h.description}</TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCurrency(h.amount, h.currency)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="p-4 text-xs text-muted-foreground">No billing history.</div>
            )
          ) : (
            <div className="p-4">
              <ErrorPanel service="Billing history" error={history.error} />
            </div>
          )}
        </SectionCard>

        <SectionCard title="Pages projects">
          {pages.ok ? (
            <div className="flex flex-col gap-3">
              {pages.data.map((p) => (
                <div
                  key={p.name}
                  className="rounded-md border border-border bg-muted/20 p-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{p.name}</div>
                    <div className="text-xs text-muted-foreground">
                      branch {p.productionBranch} · subdomain {p.subdomain}
                    </div>
                    {p.latestDeployment?.source ? (
                      <div className="text-xs italic text-muted-foreground/80">
                        {p.latestDeployment.source}
                      </div>
                    ) : null}
                  </div>
                  {p.latestDeployment ? (
                    <div className="text-xs text-muted-foreground text-right">
                      <div>deploy {p.latestDeployment.stage}</div>
                      <div>{formatRelative(p.latestDeployment.createdAt)}</div>
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">no deployments</div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <ErrorPanel service="Pages" error={pages.error} />
          )}
        </SectionCard>

        <SectionCard title="R2 buckets" flushBody>
          {r2.ok ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {r2.data.map((b) => (
                    <TableRow key={b.name}>
                      <TableCell className="font-mono">{b.name}</TableCell>
                      <TableCell>{b.location ?? '—'}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatRelative(b.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="p-4">
              <ErrorPanel service="R2" error={r2.error} />
            </div>
          )}
        </SectionCard>

        {zones.ok && zones.data.length > 0 ? (
          <SectionCard
            title="Cache"
            description="Purge a zone's edge cache. Routes through Cloudflare's purge_cache API with the existing token."
          >
            <div className="flex flex-wrap gap-2">
              {zones.data.map((z) => (
                <ActionDialog
                  key={z.id}
                  endpoint="/api/admin/cloudflare/purge-cache"
                  payload={{ zoneId: z.id, purgeEverything: true }}
                  label={`Purge ${z.name}`}
                  title={`Purge ${z.name} cache?`}
                  description={
                    <>
                      Drops every cached asset for <span className="font-mono">{z.name}</span>{' '}
                      across Cloudflare's edge. Next request to each path re-fetches from origin —
                      expect a short-lived cold-cache spike. Useful after a misconfigured deploy.
                    </>
                  }
                  confirmLabel="Purge entire zone"
                  destructive
                  enabled={writes}
                />
              ))}
            </div>
          </SectionCard>
        ) : null}

        <SectionCard title={`DNS — ${primaryZone?.name ?? '(no zone)'}`} flushBody>
          {dns?.ok ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Content</TableHead>
                    <TableHead>Proxied</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dns.data.map((r) => (
                    <TableRow key={`${r.name}-${r.type}-${r.content}`}>
                      <TableCell>{r.name}</TableCell>
                      <TableCell className="text-muted-foreground">{r.type}</TableCell>
                      <TableCell className="font-mono">{r.content}</TableCell>
                      <TableCell>{r.proxied ? 'yes' : 'no'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : dns && !dns.ok ? (
            <div className="p-4">
              <ErrorPanel service="DNS" error={dns.error} />
            </div>
          ) : (
            <div className="p-4 text-xs text-muted-foreground">No zone available.</div>
          )}
        </SectionCard>
      </div>
    </>
  );
}
