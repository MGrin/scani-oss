import { balanceDecimals } from '@scani/shared';
import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { Button } from '@scani/ui/ui/button';
import { useToast } from '@scani/ui/ui/use-toast';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { FormSheet } from '../form/FormSheet';
import { UndoHide } from '../holdings/UndoHide';
import { PickRow } from '../membership/PickRow';

/**
 * Wallet tokens nothing can price (SC-1469), asked about once.
 *
 * Every row arrived through a wallet sync, has never been quoted and is in an
 * unpriceable cooldown — so it already counts for nothing, and hiding it moves
 * no total. Nothing hides without the owner's yes. Every row starts ticked;
 * unticking one keeps it, and the keep is saved so it is never asked about
 * again. Hide goes through `holdings.bulkDelete`, which hides a synced holding
 * rather than deleting it, and the toast's Undo restores exactly the ones it
 * hid — never the keep, because the owner was shown those and that stays true.
 * After that, Tokens → Hidden brings any one back.
 */
export function UnpriceableAirdropsSheet({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const pending = trpc.holdings.unpriceableAirdrops.useQuery();
  const hide = trpc.holdings.bulkDelete.useMutation();
  const keep = trpc.holdings.keepUnpriceableAirdrops.useMutation();
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const airdrops = pending.data ?? [];

  // Answered from another tab, or priced since: there is nothing to ask.
  useEffect(() => {
    if (pending.isSuccess && pending.data.length === 0 && !busy) onClose();
  }, [pending.isSuccess, pending.data, busy, onClose]);

  if (airdrops.length === 0) return null;

  const toHide = airdrops.filter((airdrop) => !kept.has(airdrop.holdingId));
  const toKeep = airdrops.filter((airdrop) => kept.has(airdrop.holdingId));

  const refresh = () =>
    Promise.all([
      utils.holdings.unpriceableAirdrops.invalidate(),
      utils.holdings.getWithDetails.invalidate(),
      utils.holdings.getHidden.invalidate(),
      utils.review.listPending.invalidate(),
      utils.portfolio.invalidate(),
    ]);

  const answer = async () => {
    setBusy(true);
    setFailure(null);
    let problem: string | null = null;
    let keptCount = 0;
    if (toKeep.length > 0) {
      try {
        const result = await keep.mutateAsync({ ids: toKeep.map((airdrop) => airdrop.holdingId) });
        keptCount = result.keptIds.length;
      } catch (error) {
        problem = userFacingMessage(error) ?? t('v3.review.unpriceable.keepFailed');
      }
    }
    let hidden: string[] = [];
    if (toHide.length > 0) {
      try {
        const result = await hide.mutateAsync({ ids: toHide.map((airdrop) => airdrop.holdingId) });
        hidden = result.hiddenIds;
        if (result.failedIds.length > 0) {
          problem = t('v3.review.unpriceable.partlyFailed', { count: result.failedIds.length });
        }
      } catch (error) {
        problem = userFacingMessage(error) ?? t('v3.review.unpriceable.failed');
      }
    }
    await refresh();
    setBusy(false);
    setFailure(problem);
    if (hidden.length > 0) {
      toast({
        title: t('v3.review.unpriceable.toast.hidden', { count: hidden.length }),
        action: <UndoHide hiddenIds={hidden} onWritten={refresh} />,
      });
    } else if (keptCount > 0) {
      toast({ title: t('v3.review.unpriceable.toast.kept', { count: keptCount }) });
    }
    if (problem === null) onClose();
  };

  const primaryLabel =
    toHide.length === 0
      ? t('v3.review.unpriceable.keepAll')
      : toHide.length === airdrops.length
        ? t('v3.review.unpriceable.hideAll')
        : t('v3.review.unpriceable.hideSome', { count: toHide.length });

  return (
    <FormSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('v3.review.unpriceable.title')}
      description={t('v3.review.unpriceable.description')}
      footer={
        <div className="flex flex-col gap-2">
          {failure ? (
            <p role="alert" className="text-caption text-destructive lg:text-end">
              {failure}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 lg:flex-row lg:justify-end">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t('v3.form.cancel')}
            </Button>
            <Button disabled={busy} onClick={answer}>
              {primaryLabel}
            </Button>
          </div>
        </div>
      }
    >
      <ul className="flex flex-col">
        {airdrops.map((airdrop) => (
          <li key={airdrop.holdingId}>
            <PickRow
              id={`unpriceable-${airdrop.holdingId}`}
              label={airdrop.tokenSymbol}
              sublabel={airdrop.accountName}
              checked={!kept.has(airdrop.holdingId)}
              onCheckedChange={(checked) =>
                setKept((current) => {
                  const next = new Set(current);
                  if (checked) next.delete(airdrop.holdingId);
                  else next.add(airdrop.holdingId);
                  return next;
                })
              }
              trailing={
                <Numeric
                  value={airdrop.balance}
                  format="plain"
                  decimals={balanceDecimals(airdrop.balance, airdrop.tokenTypeCode)}
                />
              }
            />
          </li>
        ))}
      </ul>
    </FormSheet>
  );
}
