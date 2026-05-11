import { EmptyState } from '@scani/ui/components/EmptyState';
import { Plug } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default function ProvidersPage() {
  const fetchedAt = new Date().toISOString();
  return (
    <>
      <PageHeader
        title="Providers"
        description="28 third-party data + AI providers (pricing, balances, transactions, AI, token-identity)."
        fetchedAt={fetchedAt}
      />
      <EmptyState
        icon={Plug}
        title="Coming in Phase 2"
        description="Will enumerate every provider under packages/clients/providers, join with rate-limiter Redis namespaces + circuit-breaker state, and surface status / last-call / budget per row. Per-provider drill-down at /providers/[key]."
      />
    </>
  );
}
