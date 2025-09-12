import { Building2, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/ui/loading';
import { PageHeader } from '@/components/ui/page-header';
import type { ApiInstitution } from '@/lib/api-types';
import { MOBILE_SPACING } from '@/lib/mobile-utils';
import { trpc } from '@/lib/trpc';

export function Institutions() {
  const navigate = useNavigate();
  const { data: institutions, isLoading } = trpc.institutions.getByUserId.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();

  const getInstitutionTypeLabel = (type: string) => {
    const institutionType = institutionTypes?.find(
      (t: { code: string; name: string }) => t.code === type
    );
    return institutionType?.name || type;
  };

  const getInstitutionTypeColor = (type: string) => {
    // Generate a consistent color based on the type string using a simple hash function
    let hash = 0;
    for (let i = 0; i < type.length; i++) {
      const char = type.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    // Convert hash to HSL color with good saturation and lightness for visibility
    const hue = Math.abs(hash) % 360;
    const saturation = 65; // Good saturation for visibility
    const lightness = 50; // Good contrast for both light and dark themes

    // Convert HSL to hex color
    const hslToHex = (h: number, s: number, l: number) => {
      l /= 100;
      const a = (s * Math.min(l, 1 - l)) / 100;
      const f = (n: number) => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color)
          .toString(16)
          .padStart(2, '0');
      };
      return `#${f(0)}${f(8)}${f(4)}`;
    };

    return hslToHex(hue, saturation, lightness);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Your Financial Institutions"
          subtitle="Overview of institutions where you have accounts"
          loading={true}
        />
        <div className="flex items-center justify-center py-12">
          <div className="flex flex-col items-center gap-3">
            <LoadingSpinner size="lg" />
            <p className="text-muted-foreground">Loading institutions...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={MOBILE_SPACING.sectionGap}>
      <PageHeader
        title="Your Financial Institutions"
        subtitle="Overview of institutions where you have accounts"
        primaryAction={{
          label: 'Add Holding',
          onClick: () => navigate('/quick-add-holding'),
          icon: <Plus className="h-4 w-4 mr-1" />,
        }}
      />

      {!institutions || institutions.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Building2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No institutions yet</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              You haven't added any holdings yet. When you create your first holding, the associated
              institution will appear here automatically.
            </p>
            <Button onClick={() => navigate('/quick-add-holding')}>
              <Plus className="h-4 w-4 mr-2" />
              Create Your First Holding
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="text-sm text-muted-foreground">
            These are the financial institutions where you have accounts with holdings. To add a new
            institution, create a holding at that institution.
          </div>

          <div className={`grid ${MOBILE_SPACING.gridGap} md:grid-cols-2 lg:grid-cols-3`}>
            {institutions.map((institution: ApiInstitution) => (
              <Card key={institution.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-3">
                  <div className="flex items-center space-x-2">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{
                        backgroundColor: getInstitutionTypeColor(institution.type ?? ''),
                      }}
                    />
                    <CardTitle className="text-base truncate" title={institution.name}>
                      {institution.name}
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="space-y-2">
                    <div>
                      <p className="text-xs text-muted-foreground">Type</p>
                      <p className="text-sm font-medium">
                        {getInstitutionTypeLabel(institution.type ?? '')}
                      </p>
                    </div>
                    {institution.description && (
                      <div>
                        <p className="text-xs text-muted-foreground">Description</p>
                        <p className="text-sm truncate" title={institution.description}>
                          {institution.description}
                        </p>
                      </div>
                    )}
                    {institution.website && (
                      <div>
                        <p className="text-xs text-muted-foreground">Website</p>
                        <a
                          href={institution.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm text-blue-600 hover:underline truncate block"
                          title={institution.website}
                        >
                          {institution.website}
                        </a>
                      </div>
                    )}
                    <div className="pt-1 border-t">
                      <p className="text-xs text-muted-foreground">
                        Added {new Date(institution.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
