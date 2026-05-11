import { formatNumber, formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getRecentRuns, getRepoInfo } from '@/lib/clients/github';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function GithubPage() {
  const fetchedAt = new Date().toISOString();
  const [runs, repo] = await Promise.all([getRecentRuns(15), getRepoInfo()]);

  return (
    <>
      <PageHeader
        title="GitHub"
        description={
          repo.ok ? `${repo.data.fullName} (${repo.data.visibility})` : 'Repo info unavailable.'
        }
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {repo.ok ? (
          <>
            <StatCard label="Disk" value={`${formatNumber(repo.data.diskKb)} KB`} />
            <StatCard label="Open issues" value={repo.data.openIssues} />
            <StatCard label="Default branch" value={repo.data.defaultBranch} />
            <StatCard label="Last push" value={formatRelative(repo.data.pushedAt)} />
          </>
        ) : (
          <div className="col-span-2 sm:col-span-4">
            <ErrorPanel service="Repo info" error={repo.error} />
          </div>
        )}
      </div>

      <SectionCard title="Recent workflow runs" className="mt-6" flushBody>
        {runs.ok ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.data.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-muted-foreground">{r.runNumber}</TableCell>
                    <TableCell>
                      <a
                        href={r.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {r.name}
                      </a>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.headBranch}</TableCell>
                    <TableCell className="text-muted-foreground">{r.event}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          r.conclusion === 'success'
                            ? 'default'
                            : r.conclusion === 'failure'
                              ? 'destructive'
                              : 'outline'
                        }
                      >
                        {r.conclusion ?? r.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatRelative(r.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="p-4">
            <ErrorPanel service="Workflow runs" error={runs.error} />
          </div>
        )}
      </SectionCard>
    </>
  );
}
