import { showSuccess } from '@scani/ui/ui/use-toast';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import {
  buildMoneyMove,
  buildValueUpdate,
  describeHandValuedFailure,
  type MoneyDraft,
  type ValueDraft,
} from '../lib/hand-valued';

/** Submit either hand-valued form (SC-1596), with one idempotency key per press. */
export function useHandValued(onDone: () => void) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updateValue = trpc.holdings.updateHandValue.useMutation();
  const moveMoney = trpc.holdings.moveHandValuedMoney.useMutation();

  const run = async (write: () => Promise<unknown>) => {
    setIsSaving(true);
    setError(null);
    try {
      await write();
      showSuccess(t('v3.holdings.handValued.saved'));
      onDone();
    } catch (failure) {
      setError(describeHandValuedFailure(t, failure));
    } finally {
      setIsSaving(false);
      await invalidatePortfolioQueries(utils);
    }
  };

  return {
    isSaving,
    error,
    submitValue: (holdingId: string, currency: string, draft: ValueDraft) => {
      const update = buildValueUpdate(holdingId, currency, draft);
      if (update) {
        void run(() => updateValue.mutateAsync({ update, idempotencyKey: crypto.randomUUID() }));
      }
    },
    submitMoney: (holdingId: string, currency: string, draft: MoneyDraft) => {
      const move = buildMoneyMove(holdingId, currency, draft);
      if (move) {
        void run(() => moveMoney.mutateAsync({ move, idempotencyKey: crypto.randomUUID() }));
      }
    },
  };
}
