import { EmptyState } from '@scani/ui/components/EmptyState';
import { ListChecks } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default function SchedulesPage() {
  const fetchedAt = new Date().toISOString();
  return (
    <>
      <PageHeader
        title="Scheduled jobs"
        description="14 repeatable BullMQ schedules — pricing, balances, payouts, backfills, reconcilers."
        fetchedAt={fetchedAt}
      />
      <EmptyState
        icon={ListChecks}
        title="Coming in Phase 2"
        description="Will read REPEATABLE_SCHEDULES from @scani/queue, join against BullMQ scheduler keys in Redis to derive lastRun / nextRun / success-count / failure-count, and expose a 'run now' write action."
      />
    </>
  );
}
