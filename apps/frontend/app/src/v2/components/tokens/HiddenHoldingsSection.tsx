import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent } from '@scani/ui/ui/card';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Eye, EyeOff } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { optimisticRemoveHiddenHolding } from '../../hooks/optimisticUpdates';
import { ScamActionButton } from '../ScamActionButton';
import { ScamBadge } from '../ScamBadge';

const SKELETON_KEYS = ['a', 'b'];

type HiddenHolding = {
  id: string;
  balance: string;
  hiddenReason: 'user_hidden' | 'scam' | 'both';
  token: { id: string; symbol: string; name: string; isScamProbability: number };
  account: { id: string; name: string };
  institution: { id: string; name: string };
};

function UnhideButton({ holdingId, onChanged }: { holdingId: string; onChanged: () => void }) {
  const utils = trpc.useUtils();
  const restore = trpc.holdings.restore.useMutation({
    onMutate: () => optimisticRemoveHiddenHolding(utils, holdingId),
    onSuccess: () => {
      showSuccess('Holding unhidden');
      onChanged();
    },
    onError: (err, _vars, ctx) => {
      ctx?.restore();
      showError(err, 'unhide holding');
    },
    onSettled: () => {
      void utils.holdings.getHidden.invalidate();
      void utils.holdings.getWithDetails.invalidate();
    },
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 text-xs gap-1"
      disabled={restore.isLoading}
      onClick={() => restore.mutate({ id: holdingId })}
    >
      <Eye className="h-3.5 w-3.5" />
      Unhide
    </Button>
  );
}

export function HiddenHoldingsSection() {
  const utils = trpc.useUtils();
  const { data: holdings, isLoading } = trpc.holdings.getHidden.useQuery();

  const refresh = () => {
    void utils.holdings.getHidden.invalidate();
    void utils.holdings.getWithDetails.invalidate();
  };

  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-lg font-semibold tracking-tight">Hidden holdings</h3>
        <p className="text-sm text-muted-foreground mt-1">
          Holdings kept off your dashboard — either hidden by you or auto-flagged as a likely scam.
          Restore one to make it count again.
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {SKELETON_KEYS.map((k) => (
            <Skeleton key={`hidden-skel-${k}`} className="h-16" />
          ))}
        </div>
      ) : holdings && holdings.length > 0 ? (
        <div className="space-y-2">
          {(holdings as HiddenHolding[]).map((h) => {
            const showUnhide = h.hiddenReason === 'user_hidden' || h.hiddenReason === 'both';
            const showScam = h.hiddenReason === 'scam' || h.hiddenReason === 'both';
            return (
              <Card key={h.id}>
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold">{h.token.symbol}</span>
                      {showScam ? (
                        <ScamBadge probability={h.token.isScamProbability} />
                      ) : (
                        <Badge variant="secondary" className="gap-1 h-5 px-1.5 text-[10px]">
                          <EyeOff className="h-3 w-3" />
                          Hidden by you
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {h.token.name} · {h.account.name} · {h.institution.name}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-mono text-sm">{h.balance}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {showUnhide && <UnhideButton holdingId={h.id} onChanged={refresh} />}
                    {showScam && (
                      <ScamActionButton
                        tokenId={h.token.id}
                        tokenSymbol={h.token.symbol}
                        probability={h.token.isScamProbability}
                        onChanged={refresh}
                      />
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No hidden holdings. Everything you own is on your dashboard.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
