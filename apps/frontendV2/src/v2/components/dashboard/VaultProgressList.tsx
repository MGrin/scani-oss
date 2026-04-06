import { Vault } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { V2_ROUTES } from '../../lib/routes';

interface VaultData {
  id: string;
  name: string;
  color: string;
  currencySymbol: string;
  currentAmount: string;
  targetAmount: string;
  progress: number;
}

interface VaultProgressListProps {
  vaults: VaultData[];
}

export function VaultProgressList({ vaults }: VaultProgressListProps) {
  if (vaults.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Vault className="h-4 w-4" />
            Vaults
          </CardTitle>
          <Link
            to={V2_ROUTES.vaults}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            View all
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {vaults.map((vault) => {
          const progressClamped = Math.min(vault.progress, 100);
          return (
            <Link
              key={vault.id}
              to={V2_ROUTES.vaultDetail(vault.id)}
              className="block hover:bg-accent/50 -mx-2 px-2 py-2 rounded-md transition-colors"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <div
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: vault.color }}
                />
                <span className="text-sm font-medium truncate flex-1">{vault.name}</span>
                <span className="text-xs text-muted-foreground">{vault.progress.toFixed(0)}%</span>
              </div>
              <Progress value={progressClamped} className="h-1.5 mb-1" />
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>
                  {vault.currencySymbol}{' '}
                  {Number.parseFloat(vault.currentAmount).toLocaleString(undefined, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  })}
                </span>
                <span>
                  of {vault.currencySymbol}{' '}
                  {Number.parseFloat(vault.targetAmount).toLocaleString(undefined, {
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                  })}
                </span>
              </div>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
