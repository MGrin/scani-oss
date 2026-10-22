import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { useUserJobs } from '@/v3/hooks/useUserJobs';
import { type BurstAccountRow, burstAccountRows, jobOutcomeState } from '../../lib/jobs';
import { jobDetailPath } from '../../lib/routes';
import { JobStateBadge } from './JobStateBadge';

/**
 * The accounts one app-open refreshed, each linking to its own refresh
 * (SC-1724). The Jobs page shows the open as one row; this is that row's detail.
 */
export function RefreshBurstAccounts({ requestId }: { requestId: string }) {
  const { t } = useTranslation();
  const { jobs } = useUserJobs();
  const accounts = trpc.accounts.getAll.useQuery();
  const names = new Map((accounts.data ?? []).map((account) => [account.id, account.name]));
  const rows = burstAccountRows(t, jobs, requestId, names);
  return rows.length > 0 ? <RefreshBurstAccountsCard rows={rows} /> : null;
}

export function RefreshBurstAccountsCard({ rows }: { rows: BurstAccountRow[] }) {
  const { t } = useTranslation();
  return (
    <section className="mt-4">
      <p className="px-4 text-label">{t('v3.jobs.burst.accountsHeading')}</p>
      <DataRowList className="mt-2">
        {rows.map(({ job, label }) => (
          <DataRow
            key={job.jobId}
            label={label}
            value={<JobStateBadge state={jobOutcomeState(job)} needsAction={false} failure={job} />}
            href={jobDetailPath(job.jobId)}
          />
        ))}
      </DataRowList>
    </section>
  );
}
