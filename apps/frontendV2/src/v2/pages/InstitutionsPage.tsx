import { Building2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../lib/routes';

export function InstitutionsPage() {
  const navigate = useNavigate();
  const { data: institutions, isLoading } = trpc.institutions.getByUserIdWithSummary.useQuery();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={`skel-${i}`} className="h-20" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Institutions</h2>
        <p className="text-sm text-muted-foreground mt-1">
          {institutions?.length || 0} institutions with accounts
        </p>
      </div>

      {institutions && institutions.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {institutions.map((inst) => (
            <Card
              key={inst.id}
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => navigate(V2_ROUTES.institutionDetail(inst.id))}
            >
              <CardContent className="flex items-center gap-3 p-4">
                <div className="h-9 w-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-sm truncate">{inst.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {inst.summary?.accountCount ?? 0} accounts
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold">
                    $
                    {Number(inst.summary?.totalValue ?? 0).toLocaleString('en-US', {
                      minimumFractionDigits: 0,
                      maximumFractionDigits: 0,
                    })}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-12">
          <Building2 className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">No institutions yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Add data to see your institutions here
          </p>
        </div>
      )}
    </div>
  );
}
