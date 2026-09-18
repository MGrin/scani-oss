import { Button } from '@scani/ui/ui/button';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import {
  optimisticRemoveHiddenHolding,
  optimisticSetTokenScam,
} from '@/v3/hooks/optimisticUpdates';
import { type HiddenHoldingRow, isScamFlagged } from '../../lib/tokens';

/**
 * The two ways a holding comes back from the hidden list — the only mutating
 * part of that surface, kept in a leaf so the list itself stays renderable (and
 * therefore assertable) without a tRPC client.
 *
 * Neither confirms, because both are the reader's own and both have an exact
 * inverse. `Not a scam` USED to be the exception: it cleared the flag on the
 * shared token row, for every Scani user and permanently, so it asked first
 * behind a red "Clear the scam flag for everyone" (SC-73). Since SC-1160 it
 * records the reader's own verdict and changes nothing for anyone else — mgrin
 * ruled on 2026-09-14 that a verdict is per user — and `Mark as scam` on the
 * holding's sheet takes it back. A confirmation guarding a reversible, private
 * act would be spending the one signal that means "this reaches past you".
 *
 * `optimisticUpdates.ts` is imported from v2 unchanged, the same way holdings
 * does it — cancel, patch, roll back on error, invalidate on settle is already
 * the right pattern.
 */

interface HiddenHoldingActionsProps {
  holding: HiddenHoldingRow;
}

export function HiddenHoldingActions({ holding }: HiddenHoldingActionsProps) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();

  const settle = () => {
    void utils.holdings.getHidden.invalidate();
    void utils.holdings.getWithDetails.invalidate();
  };

  const restore = trpc.holdings.restore.useMutation({
    onMutate: () => optimisticRemoveHiddenHolding(utils, holding.id),
    onSuccess: () =>
      showSuccess(t('v3.tokens.actions.holdingRestored', { symbol: holding.token.symbol })),
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, t('v3.tokens.actions.unhiding'));
    },
    onSettled: settle,
  });

  const unmarkScam = trpc.tokens.unmarkAsScam.useMutation({
    onMutate: () => optimisticSetTokenScam(utils, holding.token.id, false),
    onSuccess: () =>
      showSuccess(t('v3.tokens.actions.holdingRestored', { symbol: holding.token.symbol })),
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, t('v3.tokens.actions.restoring'));
    },
    onSettled: settle,
  });

  const hiddenByUser = holding.hiddenReason === 'user_hidden' || holding.hiddenReason === 'both';

  return (
    <>
      {hiddenByUser ? (
        <Button
          variant="outline"
          disabled={restore.isPending}
          onClick={() => restore.mutate({ id: holding.id })}
        >
          <Eye className="me-2 size-4" aria-hidden="true" />
          {t('v3.tokens.hidden.unhide')}
        </Button>
      ) : null}

      {isScamFlagged(holding) ? (
        <Button
          variant="outline"
          disabled={unmarkScam.isPending}
          onClick={() => unmarkScam.mutate({ tokenId: holding.token.id })}
        >
          {t('v3.tokens.actions.notScam')}
        </Button>
      ) : null}
    </>
  );
}
