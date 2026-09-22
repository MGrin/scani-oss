import { formatDate } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Trans, useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';

export interface SuggestionRow {
  counterparty: string;
  counterpartyKey: string;
  currencyTokenId: string;
  amount: string;
  anchorDate: string;
  evidence: { transactionId: string; date: string; amount: string }[];
}

const keyOf = (s: Pick<SuggestionRow, 'counterpartyKey' | 'currencyTokenId'>) =>
  `${s.counterpartyKey}|${s.currencyTokenId}`;

interface ViewProps {
  suggestions: SuggestionRow[];
  tokenSymbolById: Map<string, string>;
  /** The suggestion whose answer is in flight, so its buttons can wait. */
  pendingKey: string | null;
  onAccept: (s: SuggestionRow) => void;
  onDismiss: (s: SuggestionRow) => void;
}

/**
 * Monthly payments the ledger shows but the recurring book does not (SC-674).
 *
 * Each card shows the payments it was built from, dates and amounts, because
 * the claim "this is a monthly bill" is only as good as that list, and the
 * reader is the one who decides. Nothing is written until they answer: the
 * forecast lost its reader's trust once by recording classifications he never
 * made (SC-673), and a suggestion that saved itself would do it again.
 */
export function RecurringSuggestionsView({
  suggestions,
  tokenSymbolById,
  pendingKey,
  onAccept,
  onDismiss,
}: ViewProps) {
  const { t } = useTranslation();
  if (suggestions.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" aria-label={t('v3.money.suggestions.title')}>
      <h2 className="text-body font-medium">{t('v3.money.suggestions.title')}</h2>
      {suggestions.map((s) => {
        const symbol = tokenSymbolById.get(s.currencyTokenId) ?? '';
        const busy = pendingKey === keyOf(s);
        return (
          <article
            key={keyOf(s)}
            className="flex flex-col gap-2 rounded-md border border-dashed border-muted-foreground/60 p-3"
          >
            <p className="text-body">
              <Trans
                i18nKey="v3.money.suggestions.claim"
                values={{ payee: s.counterparty }}
                components={{ value: <Numeric value={s.amount} currency={symbol} /> }}
              />
            </p>
            <ul className="flex flex-col gap-0.5 text-caption text-muted-foreground">
              <li>{t('v3.money.suggestions.evidence', { count: s.evidence.length })}</li>
              {s.evidence.map((e) => (
                <li key={e.transactionId} data-evidence-row className="flex gap-2">
                  <span>{formatDate(e.date)}</span>
                  <Numeric value={e.amount} currency={symbol} />
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" data-action="accept" disabled={busy} onClick={() => onAccept(s)}>
                {t('v3.money.suggestions.accept')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-action="dismiss"
                disabled={busy}
                onClick={() => onDismiss(s)}
              >
                {t('v3.money.suggestions.dismiss')}
              </Button>
            </div>
          </article>
        );
      })}
    </section>
  );
}

/** The Recurring tab's suggestions, wired to the server. */
export function RecurringSuggestions({
  tokenSymbolById,
}: {
  tokenSymbolById: Map<string, string>;
}) {
  const utils = trpc.useUtils();
  const suggestions = trpc.payments.suggestions.useQuery();
  // An accepted suggestion becomes a payment, and may create its vendor, so
  // every surface that reads the book or the vendor list changes with it; a
  // dismissed one changes only this list.
  const refresh = (all: boolean) => {
    void utils.payments.suggestions.invalidate();
    if (!all) return;
    void utils.payments.list.invalidate();
    void utils.payments.forecast.invalidate();
    void utils.payments.upcoming.invalidate();
    void utils.vendors.list.invalidate();
    void utils.vendors.spend.invalidate();
  };
  const accept = trpc.payments.acceptSuggestion.useMutation({ onSettled: () => refresh(true) });
  const dismiss = trpc.payments.dismissSuggestion.useMutation({
    onSettled: () => refresh(false),
  });
  const pending = accept.isPending
    ? accept.variables
    : dismiss.isPending
      ? dismiss.variables
      : null;

  return (
    <RecurringSuggestionsView
      suggestions={suggestions.data ?? []}
      tokenSymbolById={tokenSymbolById}
      pendingKey={pending ? keyOf(pending) : null}
      onAccept={(s) =>
        accept.mutate({ counterpartyKey: s.counterpartyKey, currencyTokenId: s.currencyTokenId })
      }
      onDismiss={(s) =>
        dismiss.mutate({ counterpartyKey: s.counterpartyKey, currencyTokenId: s.currencyTokenId })
      }
    />
  );
}
