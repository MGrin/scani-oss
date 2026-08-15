import { Button } from '@scani/ui/ui/button';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Eye } from 'lucide-react';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import {
  optimisticRemoveHiddenHolding,
  optimisticSetTokenScam,
} from '@/v2/hooks/optimisticUpdates';
import { type HiddenHoldingRow, isScamFlagged } from '../../lib/tokens';

/**
 * The two ways a holding comes back from the hidden list — the only mutating
 * part of that surface, kept in a leaf so the list itself stays renderable (and
 * therefore assertable) without a tRPC client.
 *
 * The two actions are genuinely different in blast radius and the copy has to
 * say so: unhiding is a change to *your* portfolio, while un-flagging a scam
 * token restores it in **every** user's token search. So only one of them
 * confirms, and it is the one whose reach leaves this account.
 *
 * SC-73 replaced the `window.confirm` that used to guard it, which v3 inherited
 * from v2 on the argument that a native confirm over a sheet is still better
 * than a global write on one tap. Both halves of that were wrong. It is the
 * single highest-blast-radius write in the product sitting behind the one
 * confirm mechanism nothing else in v3 uses: a browser-chrome alert with an
 * OS-supplied "OK" that is not labelled like the act, a "Cancel" whose position
 * v3 does not control, and — inside a peek sheet resting at half the viewport
 * on a phone — no relationship at all to the record it is asking about. It is
 * also the exact shape §8.1 rejected, a second surface stacked over the sheet.
 * `ConfirmAction` is the house pattern and it costs nothing to use here.
 *
 * `destructive` is right even though `markAsScam` technically reverses it. The
 * red is about the write having no inverse *for the reader*, and this one has
 * none: no v3 surface can re-flag a token, and the window during which every
 * other user can find it again cannot be taken back by a later flag.
 *
 * `optimisticUpdates.ts` is imported from v2 unchanged, the same way holdings
 * does it — cancel, patch, roll back on error, invalidate on settle is already
 * the right pattern.
 */

interface HiddenHoldingActionsProps {
  holding: HiddenHoldingRow;
}

export function HiddenHoldingActions({ holding }: HiddenHoldingActionsProps) {
  const utils = trpc.useUtils();
  const [confirmingUnmark, setConfirmingUnmark] = useState(false);

  const settle = () => {
    void utils.holdings.getHidden.invalidate();
    void utils.holdings.getWithDetails.invalidate();
  };

  const restore = trpc.holdings.restore.useMutation({
    onMutate: () => optimisticRemoveHiddenHolding(utils, holding.id),
    onSuccess: () => showSuccess(`${holding.token.symbol} is back on your dashboard`),
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, 'Unhiding the holding');
    },
    onSettled: settle,
  });

  const unmarkScam = trpc.tokens.unmarkAsScam.useMutation({
    onMutate: () => optimisticSetTokenScam(utils, holding.token.id, false),
    onSuccess: () => showSuccess(`${holding.token.symbol} restored in token search`),
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, 'Restoring the token');
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
          <Eye className="mr-2 size-4" aria-hidden="true" />
          Unhide
        </Button>
      ) : null}

      {isScamFlagged(holding) ? (
        <ConfirmAction
          label="Not a scam"
          // Never "Not a scam" twice. The trigger is a claim about the token;
          // the commit is the act, and the act is global — so the word every
          // reader has to see before the second tap is "everyone".
          confirmLabel="Clear the scam flag for everyone"
          destructive
          open={confirmingUnmark}
          onOpenChange={setConfirmingUnmark}
          isPending={unmarkScam.isPending}
          consequence={`${holding.token.symbol} (${holding.token.name}) stops being flagged as a scam for every Scani user, not just you — it reappears in token search and in price lookups account-wide. Only do this if you have checked the contract yourself.`}
          onConfirm={() => unmarkScam.mutate({ tokenId: holding.token.id })}
        />
      ) : null}
    </>
  );
}
