import { EmptyState } from '@scani/ui/components/EmptyState';
import { Mail } from 'lucide-react';
import { PageHeader } from '@/components/PageHeader';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default function WaitlistPage() {
  const fetchedAt = new Date().toISOString();
  return (
    <>
      <PageHeader
        title="Waitlist"
        description="Beta-preview signups from the landing page (waitlist_signups table)."
        fetchedAt={fetchedAt}
      />
      <EmptyState
        icon={Mail}
        title="Coming in Phase 2"
        description="Will surface total signups, signup-velocity chart, recent-signups table (email, source, referrer, IP-hash), and converted-to-account state — plus a 'send magic-link invite' write action."
      />
    </>
  );
}
