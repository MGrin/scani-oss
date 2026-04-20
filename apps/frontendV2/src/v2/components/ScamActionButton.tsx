import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { isScamToken } from './ScamBadge';

interface ScamActionButtonProps {
  tokenId: string;
  tokenSymbol: string;
  probability: number | null | undefined;
  /** Called on successful mutation. Defaults to invalidating holdings queries. */
  onChanged?: () => void;
}

/**
 * Toggles the global scam flag on a token. Used by the wallet-import review
 * body on the job detail page and, in follow-up work, anywhere a holding
 * row is rendered.
 *
 * Copy is global-by-design: a single "Mark as scam" action hides the token
 * from every user's "add a holding" picker and bumps its probability to 1.
 * The reverse action restores visibility.
 */
export function ScamActionButton({
  tokenId,
  tokenSymbol,
  probability,
  onChanged,
}: ScamActionButtonProps) {
  const utils = trpc.useUtils();
  const isCurrentlyScam = isScamToken(probability);

  const markMutation = trpc.tokens.markAsScam.useMutation({
    onSuccess: () => {
      showSuccess(`Marked ${tokenSymbol} as scam`);
      void utils.holdings.getWithDetails.invalidate();
      onChanged?.();
    },
    onError: (err) => showError(err, 'mark as scam'),
  });

  const unmarkMutation = trpc.tokens.unmarkAsScam.useMutation({
    onSuccess: () => {
      showSuccess(`Restored ${tokenSymbol}`);
      void utils.holdings.getWithDetails.invalidate();
      onChanged?.();
    },
    onError: (err) => showError(err, 'unmark as scam'),
  });

  const handleClick = () => {
    if (isCurrentlyScam) {
      if (!window.confirm(`Restore ${tokenSymbol}? It will reappear in token search globally.`)) {
        return;
      }
      unmarkMutation.mutate({ tokenId });
    } else {
      markMutation.mutate({ tokenId });
    }
  };

  const busy = markMutation.isLoading || unmarkMutation.isLoading;

  // Amber is the established Tailwind warning palette: caution, not delete.
  // Delete uses `destructive` (red); "mark scam" sits between — hence amber.
  const warningClass =
    'text-amber-600 hover:bg-amber-500/10 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-400';

  return (
    <Button
      type="button"
      variant={isCurrentlyScam ? 'outline' : 'ghost'}
      size="sm"
      onClick={handleClick}
      disabled={busy}
      className={`h-7 text-xs gap-1 ${isCurrentlyScam ? '' : warningClass}`}
    >
      {isCurrentlyScam ? (
        <>
          <ShieldCheck className="h-3.5 w-3.5" />
          Restore
        </>
      ) : (
        <>
          <ShieldAlert className="h-3.5 w-3.5" />
          Mark scam
        </>
      )}
    </Button>
  );
}
