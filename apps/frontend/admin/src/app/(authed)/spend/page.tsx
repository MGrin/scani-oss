import { EmptyState } from '@scani/ui/components/EmptyState';
import { DollarSign } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default function SpendPage() {
  const fetchedAt = new Date().toISOString();
  return (
    <>
      <PageHeader
        title="Monthly spend"
        description="Composite cost rollup across every infra provider."
        fetchedAt={fetchedAt}
      />
      <EmptyState
        icon={DollarSign}
        title="Coming in Phase 3"
        description="Will compose Cloudflare billing-history, Fly billing usage, Neon compute-hours × tier, Upstash commands × tier, Sentry events × tier. Each line carries an 'invoiced' vs 'estimated' confidence chip."
      />
    </>
  );
}
