import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { loadingOnly } from '@scani/ui/v3/lib/query-state';
import { useUserJobs } from '@/v2/hooks/useUserJobs';
import { JobsList } from '../components/jobs/JobsList';

/**
 * Background work, past and present.
 *
 * `useUserJobs` comes from v2 unchanged: it owns the WS subscription that
 * invalidates `jobs.listMine` on every job event (debounced to 250ms so a
 * recompute's four progress ticks are one refetch), and it is shared with the
 * tab bar's badge — so the list and the badge read the same cache entry rather
 * than two that drift.
 */
export function JobsPage() {
  const { jobs, isLoading } = useUserJobs();

  return (
    <PageLayout measure="wide">
      <PageHeader title="Jobs" />
      <JobsList jobs={jobs} query={loadingOnly(isLoading)} />
    </PageLayout>
  );
}
