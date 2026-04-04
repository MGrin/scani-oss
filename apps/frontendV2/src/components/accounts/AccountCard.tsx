import type { Token } from '@scani/shared';
import { InstitutionBadge } from '@/components/features';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { MoneyDisplay } from '@/components/ui/money-display';

interface AccountCardProps {
  account: {
    id: string;
    institutionId: string;
    name: string;
    typeId: string;
    summary: {
      holdingsCount: number;
      totalValue: string;
    };
    // biome-ignore lint/suspicious/noExplicitAny: Account type doesn't know about groups at compile time
    groups: any[];
  };
  institution: { name: string; website: string | null } | undefined;
  accountTypeName: string;
  isSelected: boolean;
  baseCurrencyToken: Token;
  onSelect: (id: string) => void;
  onNavigate: (id: string) => void;
}

export function AccountCard({
  account,
  institution,
  accountTypeName,
  isSelected,
  baseCurrencyToken,
  onSelect,
  onNavigate,
}: AccountCardProps) {
  return (
    <Card
      className={`hover:shadow-md transition-shadow ${isSelected ? 'ring-2 ring-primary' : ''}`}
    >
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <div className="min-w-[44px] min-h-[44px] flex items-center justify-center">
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => onSelect(account.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select ${account.name}`}
              />
            </div>
            <button
              type="button"
              className="cursor-pointer text-left font-semibold hover:underline"
              onClick={() => onNavigate(account.id)}
            >
              {account.name}
            </button>
          </span>
          <div className="text-sm text-muted-foreground">{accountTypeName}</div>
        </CardTitle>
        <div className="flex items-center gap-2">
          <InstitutionBadge
            institutionId={account.institutionId}
            institutionName={institution?.name || 'Unknown Institution'}
            institutionWebsite={institution?.website || undefined}
          />
        </div>
      </CardHeader>
      <CardContent className="cursor-pointer" onClick={() => onNavigate(account.id)}>
        <div className="space-y-3">
          <div className="text-2xl font-bold">
            <MoneyDisplay
              value={parseFloat(account.summary.totalValue)}
              token={baseCurrencyToken}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {account.summary.holdingsCount} holding
            {account.summary.holdingsCount !== 1 ? 's' : ''}
          </div>
          {account.groups && (
            <div className="flex flex-wrap gap-1 pt-2">
              {/* biome-ignore lint/suspicious/noExplicitAny: Account type doesn't know about groups at compile time */}
              {account.groups.slice(0, 3).map((group: any) => (
                <Badge
                  key={group.id}
                  variant="outline"
                  className="text-xs"
                  style={{
                    backgroundColor: group.color,
                    opacity: 0.2,
                  }}
                >
                  {group.name}
                </Badge>
              ))}
              {account.groups.length > 3 && (
                <Badge variant="secondary" className="text-xs">
                  +{account.groups.length - 3}
                </Badge>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
