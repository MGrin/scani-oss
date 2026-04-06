import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { HoldingDetailContent } from '../components/holdings/HoldingDetailContent';
import { V2_ROUTES } from '../lib/routes';

export function HoldingDetailPage() {
  const { id } = useParams<{ id: string }>();

  if (!id) return null;

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link to={V2_ROUTES.holdings}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Holdings
          </Link>
        </Button>
      </div>
      <HoldingDetailContent holdingId={id} mode="fullPage" />
    </div>
  );
}
