import { EmptyState } from '@scani/ui/components/EmptyState';
import { Cloud } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default function CloudPage() {
  const fetchedAt = new Date().toISOString();
  return (
    <>
      <PageHeader
        title="Cloud customers"
        description="Tier 2/3 SaaS customers — cloud users, API keys, usage events."
        fetchedAt={fetchedAt}
      />
      <EmptyState
        icon={Cloud}
        title="Coming in Phase 2"
        description="Will surface cloudUsers, cloudApiKeys (with usage + quota), cloudUsageEvents rollup per tenant, and a 'revoke key' write action."
      />
    </>
  );
}
