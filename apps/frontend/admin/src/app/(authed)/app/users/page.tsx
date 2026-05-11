import { formatNumber, formatRelative } from '@scani/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getUserStats } from '@/lib/clients/db/userStats';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const fetchedAt = new Date().toISOString();
  const stats = await getUserStats();
  if (!stats.ok) {
    return (
      <>
        <PageHeader title="Users" fetchedAt={fetchedAt} />
        <ErrorPanel service="App database" error={stats.error} />
      </>
    );
  }
  const { users, activeSessions, vaults, accounts, signups7d, signups30d, recentSignups } =
    stats.data;

  return (
    <>
      <PageHeader
        title="Users"
        description="Account totals from the production database + recent signup velocity."
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total users" value={formatNumber(users)} />
        <StatCard label="Active sessions" value={formatNumber(activeSessions)} />
        <StatCard
          label="Signups (7d)"
          value={formatNumber(signups7d)}
          sub={`${formatNumber(signups30d)} in 30d`}
        />
        <StatCard
          label="Per-user objects"
          value={formatNumber(vaults + accounts)}
          sub={`${formatNumber(vaults)} vaults · ${formatNumber(accounts)} accounts`}
        />
      </div>

      <SectionCard
        title="Recent signups"
        description="Most recent 20. Emails are masked at the local part for privacy."
        className="mt-6"
        flushBody
      >
        {recentSignups.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="font-mono text-[10px]">ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentSignups.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-mono text-xs">{u.emailMasked}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(u.createdAt)}
                    </TableCell>
                    <TableCell className="font-mono text-[10px] text-muted-foreground">
                      {u.id}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">No users yet.</div>
        )}
      </SectionCard>
    </>
  );
}
