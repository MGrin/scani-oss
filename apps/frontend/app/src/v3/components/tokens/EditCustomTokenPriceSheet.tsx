import { Textarea } from '@scani/ui/ui/textarea';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import {
  currencyIdForSymbol,
  currencySymbolForId,
  parsePositivePrice,
  priceBlockers,
} from '../../lib/custom-tokens';
import { amountDecimals } from '../../lib/holdings';
import { formatRelative } from '../../lib/relative-time';
import { FiatCurrencyField } from '../form/FiatCurrencyField';
import { Field, FieldRow } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';

/**
 * Re-mark a custom token — the only thing that ever moves its price, since
 * nothing refreshes it.
 *
 * The history is open rather than behind a "Show edit history" toggle. That
 * toggle is the reason to rewrite this form rather than move it: the price on
 * screen is a number a stranger typed, these tokens are shared across every
 * user, and the question the reader has before overwriting it is *who set this
 * and why*. v2 puts that answer one tap away and starts the query only when the
 * tap happens, so the form's most load-bearing context is also its slowest.
 * Here the query runs with the sheet and the list is simply there.
 */

type PriceEditRow = RouterOutputs['tokens']['getPriceEditHistory'][number];

/** Two decimals is the floor, not the rule — a custom token can be a share at
 *  128.40 or a unit at 0.0000042, and rounding the second to 0.00 would report
 *  a real price as no price. Same call `CustomTokensList` makes (V3-12). */
function priceDecimals(value: number | string | null): number {
  return Math.max(2, amountDecimals(Number(value ?? 0)));
}

/**
 * The edit log, without the sheet around it. Exported because Radix renders
 * nothing at all under `renderToStaticMarkup`, so this is the half of the form
 * a test can assert on.
 */
export function PriceEditHistory({
  rows,
  isLoading,
  t,
}: {
  rows: PriceEditRow[];
  isLoading: boolean;
  t: TFunction;
}) {
  if (isLoading) {
    return (
      <p role="status" className="text-caption text-muted-foreground">
        {t('v3.tokens.price.historyLoading')}
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="text-caption text-muted-foreground">{t('v3.tokens.price.historyEmpty')}</p>
    );
  }

  return (
    <ol className="flex flex-col divide-y divide-border rounded-md border border-border">
      {rows.map((row) => {
        const currency = row.baseCurrencySymbol ?? '';
        return (
          <li key={row.id} className="flex flex-col gap-0.5 px-3 py-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-caption">
                <Numeric
                  value={row.previousPrice}
                  currency={currency}
                  decimals={priceDecimals(row.previousPrice)}
                />
                {' → '}
                <Numeric
                  value={row.newPrice}
                  currency={currency}
                  decimals={priceDecimals(row.newPrice)}
                />
              </span>
              <span className="shrink-0 text-caption text-muted-foreground">
                {formatRelative(t, row.createdAt)}
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-3 text-caption text-muted-foreground">
              <span className="min-w-0 truncate">
                {row.reason ?? t('v3.tokens.price.noReasonGiven')}
              </span>
              <span className="min-w-0 shrink-0 truncate">
                {row.editorEmail ?? row.editorName ?? t('v3.tokens.price.unknownEditor')}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

interface EditCustomTokenPriceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tokenId: string;
  tokenSymbol: string;
  currentPrice: number | string | null | undefined;
  /** The symbol the price on screen is quoted in — a manual price has no single
   *  base currency, each is recorded in whatever its author was thinking in. */
  currentBaseCurrency?: string | null;
}

export function EditCustomTokenPriceSheet({
  open,
  onOpenChange,
  tokenId,
  tokenSymbol,
  currentPrice,
  currentBaseCurrency,
}: EditCustomTokenPriceSheetProps) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const baseCurrency = trpc.users.getBaseCurrency.useQuery();
  const currencies = trpc.users.getSupportedCurrencies.useQuery();

  const [price, setPrice] = useState('');
  const [currencyId, setCurrencyId] = useState('');
  const [reason, setReason] = useState('');
  const [failure, setFailure] = useState<string | null>(null);

  const list = currencies.data ?? [];
  // The currency this token was last priced in, so re-marking it keeps its own
  // denomination rather than silently adopting the reader's.
  const defaultCurrencyId =
    currencyIdForSymbol(list, currentBaseCurrency) ||
    baseCurrency.data?.id ||
    currencyIdForSymbol(list, 'USD');

  useEffect(() => {
    if (!open) return;
    setPrice('');
    setCurrencyId(defaultCurrencyId);
    setReason('');
    setFailure(null);
  }, [open, defaultCurrencyId]);

  const history = trpc.tokens.getPriceEditHistory.useQuery(
    { tokenId, limit: 20 },
    { enabled: open }
  );

  const updateMutation = trpc.tokens.updateCustomPrice.useMutation({
    onSuccess: () => {
      void invalidatePortfolioQueries(utils);
      void utils.tokens.getPriceEditHistory.invalidate({ tokenId });
      void utils.tokens.listCustom.invalidate();
      onOpenChange(false);
    },
    onError: (error) => {
      const copy = describeQueryError(error, t('v3.tokens.price.subject'), 'save');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
  });

  const blockers = priceBlockers(t, { price, currencyId });

  const handleSubmit = () => {
    const amount = parsePositivePrice(price);
    const currencySymbol = currencySymbolForId(list, currencyId);
    if (blockers.length > 0 || amount === null || currencySymbol === null) return;
    setFailure(null);
    updateMutation.mutate({
      tokenId,
      newPrice: amount,
      baseCurrencyCode: currencySymbol,
      reason: reason.trim() || undefined,
    });
  };

  const shownCurrency = currentBaseCurrency ?? baseCurrency.data?.symbol ?? '';

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('v3.tokens.price.title', { symbol: tokenSymbol })}
      description={t('v3.tokens.price.description')}
    >
      <div className="flex flex-col gap-4">
        <p className="text-caption text-muted-foreground">
          {t('v3.tokens.price.currently')}{' '}
          <Numeric
            className="text-foreground"
            value={currentPrice ?? null}
            currency={shownCurrency}
            decimals={priceDecimals(currentPrice ?? null)}
          />
        </p>

        <FieldRow>
          <Field label={t('v3.tokens.price.newPrice')} htmlFor="v3-custom-price">
            <AmountInput
              id="v3-custom-price"
              value={price}
              onValueChange={setPrice}
              decimalScale={8}
              placeholder={t('v3.tokens.price.pricePlaceholder')}
            />
          </Field>
          <Field label={t('v3.form.fiatCurrency.label')} htmlFor="v3-custom-price-currency">
            <FiatCurrencyField
              id="v3-custom-price-currency"
              value={currencyId}
              onChange={setCurrencyId}
              compact
            />
          </Field>
        </FieldRow>

        <Field
          label={t('v3.tokens.price.reason')}
          htmlFor="v3-custom-price-reason"
          hint={t('v3.tokens.price.reasonHint')}
        >
          <Textarea
            id="v3-custom-price-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t('v3.tokens.price.reasonPlaceholder')}
            rows={2}
            maxLength={500}
          />
        </Field>

        <FormActions
          submitLabel={t('v3.tokens.price.submit')}
          pendingLabel={t('v3.tokens.price.submitting')}
          onSubmit={handleSubmit}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={updateMutation.isPending}
          error={failure}
        />

        <section className="flex flex-col gap-2">
          <h3 className="text-label text-muted-foreground">{t('v3.tokens.price.historyTitle')}</h3>
          <PriceEditHistory rows={history.data ?? []} isLoading={history.isLoading} t={t} />
        </section>
      </div>
    </FormSheet>
  );
}
