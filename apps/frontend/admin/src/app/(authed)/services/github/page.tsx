import { formatNumber, formatRelative } from '@scani/shared';
import { ErrorPanel } from '@/components/ErrorPanel';
import { MetricTile } from '@/components/MetricTile';
import { Section } from '@/components/Section';
import { getRecentRuns, getRepoInfo } from '@/lib/clients/github';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function GithubPage() {
  const [runs, repo] = await Promise.all([getRecentRuns(15), getRepoInfo()]);

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">GitHub</h1>
      <p className="text-xs text-muted-foreground mb-6">
        {repo.ok ? `${repo.data.fullName} (${repo.data.visibility})` : 'repo info unavailable'}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-8">
        {repo.ok ? (
          <>
            <MetricTile label="Disk" value={`${formatNumber(repo.data.diskKb)} KB`} />
            <MetricTile label="Open issues" value={repo.data.openIssues} />
            <MetricTile label="Default branch" value={repo.data.defaultBranch} />
            <MetricTile label="Last push" value={formatRelative(repo.data.pushedAt)} />
          </>
        ) : (
          <div className="col-span-4">
            <ErrorPanel service="Repo info" error={repo.error} />
          </div>
        )}
      </div>

      <Section title="Recent workflow runs">
        {runs.ok ? (
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left font-normal py-1">#</th>
                <th className="text-left font-normal py-1">workflow</th>
                <th className="text-left font-normal py-1">branch</th>
                <th className="text-left font-normal py-1">event</th>
                <th className="text-left font-normal py-1">status</th>
                <th className="text-left font-normal py-1">when</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} className="border-t border-border/60">
                  <td className="py-1 font-mono text-muted-foreground">{r.runNumber}</td>
                  <td className="py-1">
                    <a
                      href={r.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:underline"
                    >
                      {r.name}
                    </a>
                  </td>
                  <td className="py-1 text-muted-foreground">{r.headBranch}</td>
                  <td className="py-1 text-muted-foreground">{r.event}</td>
                  <td
                    className={`py-1 ${
                      r.conclusion === 'success'
                        ? 'text-emerald-400'
                        : r.conclusion === 'failure'
                          ? 'text-red-400'
                          : 'text-foreground/80'
                    }`}
                  >
                    {r.conclusion ?? r.status}
                  </td>
                  <td className="py-1 text-muted-foreground">{formatRelative(r.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ErrorPanel service="Workflow runs" error={runs.error} />
        )}
      </Section>
    </div>
  );
}
