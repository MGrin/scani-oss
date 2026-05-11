import { EmptyState } from '@scani/ui/components/EmptyState';
import { ListChecks } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default function UserJobsPage() {
  const fetchedAt = new Date().toISOString();
  return (
    <>
      <PageHeader
        title="User jobs"
        description="user_jobs ledger — per-user async operations (screenshot-parse, exchange-import, wallet-import, …)."
        fetchedAt={fetchedAt}
      />
      <EmptyState
        icon={ListChecks}
        title="Coming in Phase 2"
        description="Will surface jobs by state, by name, average completion time, slowest jobs, jobs stuck in queued past the reconciler window."
      />
    </>
  );
}
