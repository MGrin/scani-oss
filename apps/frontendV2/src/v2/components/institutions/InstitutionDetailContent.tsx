import { ExternalLink } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

interface InstitutionDetailContentProps {
  institutionId: string;
  mode?: 'panel' | 'fullPage';
}

export function InstitutionDetailContent({
  institutionId,
  mode = 'panel',
}: InstitutionDetailContentProps) {
  const { data: institutions, isLoading } = trpc.institutions.getByUserIdWithSummary.useQuery();

  const institution = institutions?.find((i: { id: string }) => i.id === institutionId);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (!institution) {
    return <p className="text-muted-foreground text-sm">Institution not found</p>;
  }

  const isCompact = mode === 'panel';

  return (
    <div className={cn('space-y-6', isCompact && 'space-y-4')}>
      <div>
        <div className="flex items-center gap-2">
          <h2 className={cn('font-semibold', isCompact ? 'text-lg' : 'text-2xl')}>
            {institution.name}
          </h2>
        </div>
        {institution.website && (
          <a
            href={institution.website}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline inline-flex items-center gap-1 mt-1"
          >
            {institution.website.replace(/^https?:\/\//, '')}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Accounts</p>
          <p className="text-xl font-semibold mt-0.5">{institution.summary?.accountCount ?? 0}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Value</p>
          <p className="text-xl font-semibold mt-0.5">
            $
            {Number(institution.summary?.totalValue ?? 0).toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </p>
        </div>
      </div>

      <Separator />

      <div>
        <p className="text-xs text-muted-foreground uppercase tracking-wider">Description</p>
        <p className="text-sm mt-1">{institution.description || 'No description'}</p>
      </div>
    </div>
  );
}
