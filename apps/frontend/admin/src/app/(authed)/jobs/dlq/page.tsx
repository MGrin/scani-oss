import { EmptyState } from '@scani/ui/components/EmptyState';
import { AlertTriangle } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default function DlqPage() {
  const fetchedAt = new Date().toISOString();
  return (
    <>
      <PageHeader
        title="Dead-letter queue"
        description="Jobs that exhausted their retry attempts and got pushed to scani-dlq."
        fetchedAt={fetchedAt}
      />
      <EmptyState
        icon={AlertTriangle}
        title="Coming in Phase 2"
        description="Dedicated DLQ inspector with replay action. The dlq-depth-probe scheduled job already monitors size every 5 minutes."
      />
    </>
  );
}
