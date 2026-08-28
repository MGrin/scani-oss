import { cn } from '@scani/ui/lib/cn';
import { MIRROR_IN_RTL } from '@scani/ui/lib/direction';
import { Button } from '@scani/ui/ui/button';
import { Checkbox } from '@scani/ui/ui/checkbox';
import { Label } from '@scani/ui/ui/label';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Textarea } from '@scani/ui/ui/textarea';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Block } from '@scani/ui/v3/components/Block';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import { peekPath } from '@scani/ui/v3/lib/peek';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import type { TFunction } from 'i18next';
import { ArrowLeft, FileText, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { baseCurrencyDefaultAction } from '@/lib/currency-default';
import { trpc } from '@/lib/trpc';
import {
  type AnchorDateSource,
  buildInvoicePrefill,
  matchCurrencyToken,
} from '@/v3/lib/extractionPrefill';
import { DateField } from '../components/form/DateField';
import { Field, FieldRow, FieldSet } from '../components/form/Field';
import { CurrencyField, tokenLabel } from '../components/money/CurrencyField';
import { VendorField } from '../components/money/VendorField';
import {
  describeRepeatInterval,
  describeV3PaymentFormBlockers,
  type IntervalUnit,
  type IntervalUnitChoice,
  type PaymentKind,
} from '../lib/payment-form';
import { todayDateString } from '../lib/paymentTotals';
import { V3_ROUTES } from '../lib/routes';

/**
 * Create — and, at `/v3/payments/recurring/:id/edit`, update — a recurring
 * payment. One component for both, because `payments.create` and
 * `payments.update` take near-identical shapes and the only differences are
 * which mutation fires and whether the fields start prefilled.
 *
 * The logic is v2's — the three prefill effects and the blocker list — with one
 * correction on top of it: `lib/payment-form.ts` adds the amount rule v2's gate
 * never had, without which a vendor was the only thing this form ever asked for
 * and a bill with no figure could be saved (SC-67). What changed otherwise is
 * every measurement.
 *
 * - **Labels 14px, controls 16px** (`<Field>`). v2 labels every field 12px and
 *   sizes every input 14px, which is below the threshold at which Safari on iOS
 *   zooms the page on focus — so filling this form on a phone moves the page
 *   under the user's thumb twelve times.
 * - **Two-value choices are segmented controls, not selects.** Direction and
 *   kind each have exactly two options; a select hides one of two behind a tap
 *   and a popover. Four-value cadence keeps its select, where a segmented
 *   control would truncate on a 393px screen.
 * - **`<Block>` per section, not `<Card>`**, and the section heading is a
 *   14px muted label rather than a 16px card title: the field labels are the
 *   things being read, and v2's headings compete with them.
 * - **Dates go through `<DateField>`, not a bare `type="date"`.** The native
 *   input overflowed the card on a phone and rendered its value in the *system*
 *   locale, centred — see that component for why the picker stays native and
 *   the value does not.
 * - **No two-column grid on a phone.** v2 pairs amount with currency and repeat
 *   count with anchor date in `grid-cols-2` at every width, which is what
 *   forced the bottom-align hack in its own comment. Here the pairs are
 *   `sm:grid-cols-2` and stack below that.
 */

type Direction = 'outflow' | 'inflow';

const NO_ACCOUNT = '__none__';

/**
 * The anchor sets the day every future occurrence lands on, so where it
 * came from is the one thing a human has to check before confirming. Only
 * a stated due date is evidence; the other two are a substitution and a
 * blank, and neither should be able to pass for a date off the document.
 *
 * A switch rather than a `Record` of keys: the guard test reads `t('…')` call
 * sites, and a key sitting in a table as a bare value is invisible to it.
 */
function anchorDateHint(t: TFunction, source: AnchorDateSource): string | undefined {
  switch (source) {
    case 'due-date':
      return undefined;
    case 'issue-date':
      return t('v3.money.paymentForm.anchorFromIssueDate');
    case 'none':
      return t('v3.money.paymentForm.anchorMissing');
  }
}

/** Narrower than the Money list. A form is read one field at a time and a
 *  1000px-wide text input has nothing to do with the length of its answer. */
const INTERVAL_UNITS: { value: IntervalUnit; labelKey: string }[] = [
  { value: 'week', labelKey: 'v3.money.paymentForm.unitWeek' },
  { value: 'month', labelKey: 'v3.money.paymentForm.unitMonth' },
  { value: 'quarter', labelKey: 'v3.money.paymentForm.unitQuarter' },
  { value: 'year', labelKey: 'v3.money.paymentForm.unitYear' },
];

/** The form's three cards at their real height. Drawn only from the
 *  `skeleton` band of the ramp — an edit opened from the peek sheet almost
 *  always has its payment in cache, and a card stack that appears for a
 *  quarter of a second before the real fields is the flash V3-16 deletes. */
function FormSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {['who', 'what', 'when'].map((key) => (
        <div
          key={key}
          className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4"
        >
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ))}
    </div>
  );
}

export function PaymentFormPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const [searchParams] = useSearchParams();
  // Only meaningful on create: an edit already has its own vendor, amount and
  // cadence, and re-applying an invoice over them is a silent overwrite of what
  // the user previously confirmed.
  const extractionId = isEdit ? null : searchParams.get('fromExtraction');
  const fromExtraction = Boolean(extractionId);
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const paymentQuery = trpc.payments.get.useQuery({ paymentId: id ?? '' }, { enabled: isEdit });
  const accountsQuery = trpc.accounts.getByUserIdWithSummary.useQuery();
  const tokensQuery = trpc.tokens.getAll.useQuery();
  // Fetched by id rather than pulled out of the pending-review queue: that queue
  // holds only extractions still awaiting a decision, so a revisited link would
  // find nothing there and silently lose the prefill.
  const extractionQuery = trpc.documents.getExtraction.useQuery(
    { extractionId: extractionId ?? '' },
    { enabled: fromExtraction }
  );
  const baseCurrency = useBaseCurrency();
  const extraction = extractionQuery.data ?? null;

  // Only the queries this instance of the form actually blocks on. A disabled
  // react-query stays `isLoading` forever — it has no data and never will —
  // so including `paymentQuery` on the create route would hold the form behind
  // a skeleton that could never resolve.
  const formState = mergeQueries(
    ...(isEdit ? [paymentQuery] : []),
    ...(fromExtraction ? [extractionQuery] : []),
    ...(isEdit || fromExtraction ? [tokensQuery] : [])
  );
  const loadingPhase = useDelayedLoading(formState.isLoading);

  const [vendorId, setVendorId] = useState('');
  const [vendorName, setVendorName] = useState('');
  /** An invoice's vendor with no `vendors` row yet — created server-side on submit. */
  const [pendingVendorName, setPendingVendorName] = useState('');
  const [markAnchorPaid, setMarkAnchorPaid] = useState(true);
  const [direction, setDirection] = useState<Direction>('outflow');
  const [kind, setKind] = useState<PaymentKind>('fixed');
  const [estimateFromHistory, setEstimateFromHistory] = useState(false);
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<{ id: string; label: string } | null>(null);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnitChoice>('month');
  const [intervalCount, setIntervalCount] = useState('1');
  const [anchorDate, setAnchorDate] = useState(todayDateString());
  /** Only ever moves off `'none'` on the invoice path — a manually created
      payment anchors on today by choice, which needs no caveat. */
  const [anchorDateSource, setAnchorDateSource] = useState<AnchorDateSource>('none');
  const [endDate, setEndDate] = useState('');
  const [accountId, setAccountId] = useState(NO_ACCOUNT);
  const [notes, setNotes] = useState('');
  const [prefilled, setPrefilled] = useState(false);
  const [invoicePrefilled, setInvoicePrefilled] = useState(false);

  const tokens = tokensQuery.data;

  // Prefill once the existing payment loads — a plain `useState` initial value
  // cannot work here, since the query is still loading on first render.
  useEffect(() => {
    if (!isEdit || prefilled || !paymentQuery.data || !tokens) return;
    const { payment } = paymentQuery.data;
    const token = tokens.find((candidate) => candidate.id === payment.currencyTokenId);
    setVendorId(payment.vendorId);
    setDirection(payment.direction as Direction);
    setKind(payment.kind as PaymentKind);
    setEstimateFromHistory(payment.estimateFromHistory);
    setAmount(payment.expectedAmount ?? '');
    setCurrency({
      id: payment.currencyTokenId,
      label: token ? tokenLabel(t, token) : payment.currencyTokenId,
    });
    setIntervalUnit(payment.intervalUnit as IntervalUnit);
    setIntervalCount(String(payment.intervalCount));
    setAnchorDate(payment.anchorDate);
    setEndDate(payment.endDate ?? '');
    setAccountId(payment.accountId ?? NO_ACCOUNT);
    setNotes(payment.notes ?? '');
    setPrefilled(true);
  }, [isEdit, prefilled, paymentQuery.data, tokens, t]);

  // Prefill from a parsed invoice. Only the fields the invoice evidences are
  // touched — direction, kind and repeat count keep the form's own defaults,
  // which is what an invoice implies anyway. The cadence is the exception: it
  // is CLEARED when the invoice states none, rather than left at the form's
  // monthly default, so the empty control asks the question instead of
  // answering it (SC-147).
  useEffect(() => {
    if (!extraction || invoicePrefilled || !tokens) return;
    const prefill = buildInvoicePrefill(extraction);
    setPendingVendorName(prefill.vendorName);
    setAmount(prefill.amount);
    setAnchorDate(prefill.anchorDate);
    setAnchorDateSource(prefill.anchorDateSource);
    setIntervalUnit(prefill.intervalUnit ?? '');
    setMarkAnchorPaid(prefill.markAnchorPaid);
    const token = matchCurrencyToken(tokens, prefill.currencyCode);
    if (token) setCurrency({ id: token.id, label: tokenLabel(t, token) });
    setInvoicePrefilled(true);
  }, [extraction, invoicePrefilled, tokens, t]);

  // Default the currency to the user's base currency. Without this the picker
  // starts empty and `currency` stays null until something is chosen — typing
  // "USD" and moving on reads as filled but leaves the form silently invalid.
  // Gated on `isResolved`, not on the token being present: until the query
  // lands the context serves a synthetic `currency-USD` placeholder, and
  // `currencyTokenId` is validated as a uuid server-side.
  const baseCurrencyToken = baseCurrency.token;
  const baseCurrencyResolved = baseCurrency.isResolved;
  const currencyDefaultSpent = useRef(false);
  useEffect(() => {
    const action = baseCurrencyDefaultAction({
      isEdit,
      alreadySpent: currencyDefaultSpent.current,
      baseCurrencyResolved,
      currency,
    });
    if (action === 'wait') return;
    currencyDefaultSpent.current = true;
    if (action === 'fill') {
      setCurrency({ id: baseCurrencyToken.id, label: tokenLabel(t, baseCurrencyToken) });
    }
  }, [isEdit, currency, baseCurrencyResolved, baseCurrencyToken, t]);

  const afterWrite = (paymentId: string, message: string) => {
    showSuccess(message);
    void utils.payments.invalidate();
    // Back to the list with the record's own peek open, which is where a
    // payment's detail lives in v3.
    navigate(peekPath(V3_ROUTES.recurring, paymentId), { replace: true });
  };

  // The success MESSAGE is translated and the error CONTEXT is not, and the
  // difference is what the toast does with each. `showSuccess` renders the
  // message verbatim; `showError` splices its context into
  // `${context}: ${serverMessage}` under a hardcoded English "Something went
  // wrong", both of which live in `@scani/ui` where there is no `t`. Half a
  // sentence in French over an English title is worse than the English one —
  // SC-235.
  const createMutation = trpc.payments.create.useMutation({
    onSuccess: (payment) => afterWrite(payment.id, t('v3.money.paymentForm.created')),
    onError: (error) => showError(error, t('v3.money.pending.creatingPayment')),
  });

  const createFromExtractionMutation = trpc.payments.createFromExtraction.useMutation({
    onSuccess: (payment) => {
      void utils.vendors.invalidate();
      // The extraction is accepted inside the same mutation, so the review feed
      // and the document page are both stale now.
      void utils.documents.invalidate();
      void utils.review.listPending.invalidate();
      afterWrite(payment.id, t('v3.money.paymentForm.createdFromInvoice'));
    },
    onError: (error) => showError(error, t('v3.money.pending.creatingPayment')),
  });

  const updateMutation = trpc.payments.update.useMutation({
    onSuccess: (payment) => afterWrite(payment.id, t('v3.money.paymentForm.updated')),
    onError: (error) => showError(error, t('v3.money.pending.updatingPayment')),
  });

  const isSaving =
    createMutation.isPending || updateMutation.isPending || createFromExtractionMutation.isPending;
  // Only route through `createFromExtraction` when the extraction is actually in
  // hand: a stale link must degrade to the plain form rather than submit an id
  // the server will reject.
  const createsFromInvoice = Boolean(extractionId && extraction);
  const blockers = describeV3PaymentFormBlockers(t, {
    vendorId,
    pendingVendorName: createsFromInvoice ? pendingVendorName : '',
    currencyTokenId: currency?.id ?? null,
    anchorDate,
    intervalCount,
    intervalUnit,
    amount,
    kind,
  });
  const canSubmit = blockers.length === 0;

  const handleSubmit = () => {
    if (!canSubmit || !currency || !intervalUnit) return;
    const payload = {
      direction,
      kind,
      expectedAmount: amount.trim() ? amount.trim() : null,
      // Only a variable payment can be estimated from history — a fixed one
      // has a declared figure that always wins, so a flag left set on a
      // payment switched back to `fixed` would be state nothing reads and
      // everything would still have to carry. Cleared here rather than in the
      // `setKind` handler so it is a property of what is SAVED, which is the
      // only thing any later reader sees.
      estimateFromHistory: kind === 'variable' && estimateFromHistory,
      currencyTokenId: currency.id,
      intervalUnit,
      // Safe unguarded: `canSubmit` is false unless the blocker list accepted
      // this as a positive integer, and the early return has run.
      intervalCount: Number.parseInt(intervalCount, 10),
      anchorDate,
      endDate: endDate.trim() ? endDate.trim() : null,
      accountId: accountId === NO_ACCOUNT ? null : accountId,
      notes: notes.trim() ? notes.trim() : null,
    };
    if (isEdit && id) {
      updateMutation.mutate({ paymentId: id, vendorId, ...payload });
    } else if (createsFromInvoice && extractionId) {
      createFromExtractionMutation.mutate({
        ...payload,
        // Null hands the vendor decision to the server, which find-or-creates
        // by the invoice's own name.
        vendorId: vendorId || null,
        extractionId,
        markAnchorPaid,
      });
    } else {
      createMutation.mutate({ vendorId, ...payload });
    }
  };

  // Rendering the empty form first and rewriting every field a beat later reads
  // as the app undoing the user's work.
  if (formState.isLoading) {
    return (
      <PageLayout>
        {/* `label` here and `subject` below are the SAME noun, deliberately —
            both land in a sentence assembled in `@scani/ui`, the ramp's
            sr-only line and every branch of `describeQueryError`. SC-235 left
            them English because a translator could not see which frame the
            noun lands in; the first real locale showed those frames are three
            keys in the kit's own bundle, all taking the noun in one slot, so
            the noun is keyed and the rule is written down instead: a subject
            key is accusative in a language that marks case (SC-201). */}
        <LoadingRamp
          phase={loadingPhase}
          skeleton={<FormSkeleton />}
          label={t('v3.money.thisPayment')}
          onRetry={formState.retry}
        />
      </PageLayout>
    );
  }

  // A request that failed is not a payment that was deleted, and telling
  // someone their bill is gone when the server merely timed out is the worst
  // thing this screen can say. The two states are separated here.
  if (formState.isError) {
    return (
      <PageLayout>
        <QueryError
          error={formState.error}
          subject={t('v3.money.thisPayment')}
          onRetry={formState.retry}
        />
      </PageLayout>
    );
  }

  if (isEdit && !paymentQuery.data) {
    return (
      <PageLayout className="items-start">
        <div className="flex flex-col gap-1">
          <h1 className="text-title">{t('v3.money.paymentForm.missingTitle')}</h1>
          <p className="text-body text-muted-foreground">{t('v3.money.paymentForm.missingBody')}</p>
        </div>
        <Button asChild variant="outline">
          <Link to={V3_ROUTES.recurring}>{t('v3.money.paymentForm.allRecurring')}</Link>
        </Button>
      </PageLayout>
    );
  }

  const accounts = accountsQuery.data ?? [];

  return (
    <PageLayout>
      <div className="flex flex-col gap-2">
        <Button variant="ghost" size="sm" asChild className="-ms-2 self-start">
          <Link to={isEdit && id ? peekPath(V3_ROUTES.recurring, id) : V3_ROUTES.recurring}>
            <ArrowLeft className={cn(MIRROR_IN_RTL, 'me-1 h-4 w-4')} aria-hidden="true" />
            {isEdit
              ? t('v3.money.paymentForm.backToPayment')
              : t('v3.money.paymentForm.allRecurring')}
          </Link>
        </Button>
        <h1 className="text-title">
          {isEdit ? t('v3.money.paymentForm.titleEdit') : t('v3.money.paymentForm.titleNew')}
        </h1>
        <p className="text-body text-muted-foreground">{t('v3.money.paymentForm.intro')}</p>
        {createsFromInvoice ? (
          <p className="flex items-start gap-1.5 text-caption text-muted-foreground">
            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              {/* Two whole sentences with the invoice number in or out, rather
                  than one sentence with " invoice #N" glued on: the number sits
                  after its noun in English and before it in half the languages
                  SC-201 adds, and a fragment cannot move. */}
              {extraction?.invoiceNumber
                ? t('v3.money.paymentForm.suggestedFromNumbered', {
                    vendor: extraction?.vendorNameRaw,
                    number: extraction.invoiceNumber,
                  })
                : t('v3.money.paymentForm.suggestedFrom', { vendor: extraction?.vendorNameRaw })}
              {/* Only worth saying when a cadence WAS read off the document.
                  With none, the empty control and its own hint are the
                  message, and this sentence would read as a second one. */}
              {intervalUnit ? <> {t('v3.money.paymentForm.cadenceCaveat')}</> : null}
            </span>
          </p>
        ) : null}
        {fromExtraction && !extraction ? (
          <p className="text-caption text-destructive">
            {t('v3.money.paymentForm.extractionGone')}
          </p>
        ) : null}
      </div>

      <Block>
        <FieldSet title={t('v3.money.paymentForm.sectionWho')}>
          <VendorField
            value={vendorId}
            valueLabel={vendorName}
            pendingName={createsFromInvoice ? pendingVendorName : undefined}
            onSelect={(nextVendorId, displayName) => {
              setVendorId(nextVendorId);
              setVendorName(displayName);
            }}
            onClearPending={() => setPendingVendorName('')}
            disabled={isSaving}
          />
        </FieldSet>
      </Block>

      <Block>
        <FieldSet title={t('v3.money.paymentForm.sectionWhat')}>
          {/* The field's own name and its two values are the same three words
              the Money list filters on — one key each, shared, so a translator
              cannot make the form and the list disagree about what a "Bill"
              is. */}
          <Field
            label={t('v3.money.field.direction')}
            hint={
              direction === 'inflow'
                ? t('v3.money.paymentForm.directionIn')
                : t('v3.money.paymentForm.directionOut')
            }
          >
            <Segmented
              value={direction}
              onValueChange={(next) => setDirection(next as Direction)}
              aria-label={t('v3.money.field.direction')}
              className="w-full"
            >
              <SegmentedItem value="outflow">{t('v3.money.direction.bill')}</SegmentedItem>
              <SegmentedItem value="inflow">{t('v3.money.direction.income')}</SegmentedItem>
            </Segmented>
          </Field>

          {/* "Amount is", not "Kind": the stored value is `fixed` / `variable`,
              which is a column name. The question a person is answering is
              whether the figure in the next field will hold. */}
          <Field
            label={t('v3.money.paymentForm.amountIs')}
            hint={kind === 'variable' ? t('v3.money.paymentForm.amountIsVariableHint') : undefined}
          >
            <Segmented
              value={kind}
              onValueChange={(next) => setKind(next as PaymentKind)}
              aria-label={t('v3.money.paymentForm.amountIsQuestion')}
              className="w-full"
            >
              <SegmentedItem value="fixed">{t('v3.money.paymentForm.kindFixed')}</SegmentedItem>
              <SegmentedItem value="variable">
                {t('v3.money.paymentForm.kindVariable')}
              </SegmentedItem>
            </Segmented>
          </Field>

          <FieldRow>
            {/* The estimate is the one field on this form that may be left
                empty, and only because "varies" is an answer. A fixed amount
                is not optional — see `lib/payment-form.ts`. */}
            <Field
              label={
                kind === 'variable'
                  ? t('v3.money.paymentForm.estimate')
                  : t('v3.money.paymentForm.amount')
              }
              htmlFor="payment-amount"
              hint={kind === 'variable' ? t('v3.money.paymentForm.estimateHint') : undefined}
            >
              <AmountInput
                id="payment-amount"
                value={amount}
                onValueChange={setAmount}
                placeholder="0.00"
                decimalScale={2}
                disabled={isSaving}
                className="text-body"
              />
            </Field>
            <CurrencyField
              value={currency}
              onSelect={(tokenId, label) => setCurrency({ id: tokenId, label })}
              onClear={() => setCurrency(null)}
              disabled={isSaving}
            />
          </FieldRow>
        </FieldSet>
      </Block>

      <Block>
        <FieldSet title={t('v3.money.paymentForm.sectionWhen')}>
          {/* `Repeats every` keeps the full row: it is already two controls in a
              trench coat (a count and its unit), and pairing it with a third
              puts four controls on one line. */}
          <Field
            label={t('v3.money.paymentForm.repeatsEvery')}
            htmlFor="payment-interval-count"
            hint={describeRepeatInterval(t, intervalCount, intervalUnit)}
          >
            <div className="flex gap-2">
              <AmountInput
                id="payment-interval-count"
                value={intervalCount}
                onValueChange={setIntervalCount}
                decimalScale={0}
                wrapperClassName="w-20 shrink-0"
                className="text-body"
                disabled={isSaving}
              />
              <Select
                value={intervalUnit}
                onValueChange={(next) => setIntervalUnit(next as IntervalUnit)}
                disabled={isSaving}
              >
                <SelectTrigger
                  className="text-body"
                  aria-label={t('v3.money.paymentForm.repeatUnit')}
                >
                  {/* Radix renders the placeholder for the empty value, which
                      is what an invoice with no stated cadence leaves here. */}
                  <SelectValue placeholder={t('v3.money.paymentForm.repeatUnitPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_UNITS.map((unit) => (
                    <SelectItem key={unit.value} value={unit.value} className="text-body">
                      {t(unit.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Field>

          {/* The two dates are one decision — when it starts and whether it
              ever stops — and they are the same control twice, so side by side
              they share a baseline and read as a range. Previously `First due`
              was paired with the interval and `Stops after` sat alone a full
              field-height below, which is what made the end date look optional
              in the structural sense rather than the literal one. */}
          <FieldRow>
            <Field
              label={t('v3.money.paymentForm.firstDue')}
              htmlFor="payment-anchor-date"
              hint={createsFromInvoice ? anchorDateHint(t, anchorDateSource) : undefined}
            >
              <DateField
                id="payment-anchor-date"
                value={anchorDate}
                onChange={setAnchorDate}
                placeholder={
                  anchorDateSource === 'none'
                    ? t('v3.money.paymentForm.anchorPlaceholder')
                    : undefined
                }
                disabled={isSaving}
              />
            </Field>

            <Field
              label={t('v3.money.paymentForm.stopsAfter')}
              htmlFor="payment-end-date"
              hint={t('v3.money.paymentForm.stopsAfterHint')}
            >
              <DateField
                id="payment-end-date"
                value={endDate}
                onChange={setEndDate}
                placeholder={t('v3.money.paymentForm.stopsAfterPlaceholder')}
                clearable
                disabled={isSaving}
              />
            </Field>
          </FieldRow>

          {/* Only for a variable payment, and only where it can mean something.
              A fixed payment's declared amount always wins, so offering the
              option there would be offering a control that changes nothing —
              the shape SC-625's own forecast button deliberately avoids by
              naming only the payments a settlement exists for. */}
          {kind === 'variable' ? (
            <div className="flex items-start gap-3 rounded-md border border-border-strong p-3">
              <Checkbox
                id="estimate-from-history"
                checked={estimateFromHistory}
                onCheckedChange={(checked) => setEstimateFromHistory(checked === true)}
                disabled={isSaving}
                className="mt-0.5"
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="estimate-from-history" className="text-label">
                  {t('v3.money.paymentForm.estimateFromHistory')}
                </Label>
                <p className="text-caption text-muted-foreground">
                  {t('v3.money.paymentForm.estimateFromHistoryHint')}
                </p>
              </div>
            </div>
          ) : null}

          {createsFromInvoice ? (
            <div className="flex items-start gap-3 rounded-md border border-border-strong p-3">
              <Checkbox
                id="mark-anchor-paid"
                checked={markAnchorPaid}
                onCheckedChange={(checked) => setMarkAnchorPaid(checked === true)}
                disabled={isSaving}
                className="mt-0.5"
              />
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="mark-anchor-paid" className="text-label">
                  {t('v3.money.paymentForm.markPaid')}
                </Label>
                <p className="text-caption text-muted-foreground">
                  {t('v3.money.paymentForm.markPaidHint')}
                </p>
              </div>
            </div>
          ) : null}
        </FieldSet>
      </Block>

      <Block>
        <FieldSet title={t('v3.money.paymentForm.sectionOptional')}>
          <Field label={t('v3.money.paymentForm.linkedAccount')}>
            <Select value={accountId} onValueChange={setAccountId} disabled={isSaving}>
              <SelectTrigger
                className="text-body"
                aria-label={t('v3.money.paymentForm.linkedAccount')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ACCOUNT} className="text-body">
                  {t('v3.money.paymentForm.noLinkedAccount')}
                </SelectItem>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id} className="text-body">
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t('v3.money.paymentForm.notes')} htmlFor="payment-notes">
            <Textarea
              id="payment-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={t('v3.money.paymentForm.notesPlaceholder')}
              disabled={isSaving}
              className="text-body"
            />
          </Field>
        </FieldSet>
      </Block>

      <div className="flex flex-col gap-2">
        <Button onClick={handleSubmit} disabled={!canSubmit || isSaving} className="w-full">
          {isSaving ? (
            <>
              <Loader2 className="me-2 h-4 w-4 animate-spin" aria-hidden="true" />
              {t('v3.money.paymentForm.saving')}
            </>
          ) : isEdit ? (
            t('v3.money.paymentForm.saveChanges')
          ) : (
            t('v3.money.paymentForm.create')
          )}
        </Button>
        {/* A disabled button with no explanation is itself the defect the field
            validation was hiding, so the gate reports reasons rather than a
            boolean and the form prints them.

            The frame was the one string in v3 left deliberately in English
            (SC-235): it wraps a list of imperative clauses that are
            grammatically dependent on it, and the reason given for leaving it
            was that `describePaymentFormBlockers` built most of those clauses
            in `src/v2/`. That has not been true since v3 grew
            `describeV3PaymentFormBlockers` — every clause is a
            `v3.money.blocker.*` key — and SC-423 deleted the tree the
            exemption named, so the piece is whole and moves as one.

            The comma-space join stays in code, and it is the same open
            question `groups.ts`, `money.ts` and `ConvertedTotal` already
            carry: `Intl.ListFormat` is the right answer for all four and
            belongs with the step that does them together, not with one of
            them. */}
        {!canSubmit && !isSaving && blockers.length > 0 ? (
          <p className="text-center text-caption text-muted-foreground">
            {t('v3.money.paymentForm.blockers', { blockers: blockers.join(', ') })}
          </p>
        ) : null}
      </div>
    </PageLayout>
  );
}
