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
import { ArrowLeft, FileText, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { baseCurrencyDefaultAction } from '@/lib/currency-default';
import { trpc } from '@/lib/trpc';
import {
  type AnchorDateSource,
  buildInvoicePrefill,
  matchCurrencyToken,
} from '@/v2/lib/extractionPrefill';
import { todayDateString } from '@/v2/lib/paymentTotals';
import { DateField } from '../components/form/DateField';
import { Field, FieldRow, FieldSet } from '../components/form/Field';
import { CurrencyField, tokenLabel } from '../components/money/CurrencyField';
import { VendorField } from '../components/money/VendorField';
import {
  describeRepeatInterval,
  describeV3PaymentFormBlockers,
  type PaymentKind,
} from '../lib/payment-form';
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
type IntervalUnit = 'week' | 'month' | 'quarter' | 'year';
/** `''` is the unanswered cadence an invoice with no stated period leaves
 *  behind — see `buildInvoicePrefill`. Nothing else can produce it. */
type IntervalUnitChoice = IntervalUnit | '';

const NO_ACCOUNT = '__none__';

/**
 * The anchor sets the day every future occurrence lands on, so where it
 * came from is the one thing a human has to check before confirming. Only
 * a stated due date is evidence; the other two are a substitution and a
 * blank, and neither should be able to pass for a date off the document.
 */
const ANCHOR_DATE_HINTS: Record<AnchorDateSource, string | undefined> = {
  'due-date': undefined,
  'issue-date': 'The invoice states no due date — this is its issue date.',
  none: 'No date found on the invoice. Pick the day this is due.',
};

/** Narrower than the Money list. A form is read one field at a time and a
 *  1000px-wide text input has nothing to do with the length of its answer. */
const INTERVAL_UNITS: { value: IntervalUnit; label: string }[] = [
  { value: 'week', label: 'Week(s)' },
  { value: 'month', label: 'Month(s)' },
  { value: 'quarter', label: 'Quarter(s)' },
  { value: 'year', label: 'Year(s)' },
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
    setAmount(payment.expectedAmount ?? '');
    setCurrency({
      id: payment.currencyTokenId,
      label: token ? tokenLabel(token) : payment.currencyTokenId,
    });
    setIntervalUnit(payment.intervalUnit as IntervalUnit);
    setIntervalCount(String(payment.intervalCount));
    setAnchorDate(payment.anchorDate);
    setEndDate(payment.endDate ?? '');
    setAccountId(payment.accountId ?? NO_ACCOUNT);
    setNotes(payment.notes ?? '');
    setPrefilled(true);
  }, [isEdit, prefilled, paymentQuery.data, tokens]);

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
    if (token) setCurrency({ id: token.id, label: tokenLabel(token) });
    setInvoicePrefilled(true);
  }, [extraction, invoicePrefilled, tokens]);

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
      setCurrency({ id: baseCurrencyToken.id, label: tokenLabel(baseCurrencyToken) });
    }
  }, [isEdit, currency, baseCurrencyResolved, baseCurrencyToken]);

  const afterWrite = (paymentId: string, message: string) => {
    showSuccess(message);
    void utils.payments.invalidate();
    // Back to the list with the record's own peek open, which is where a
    // payment's detail lives in v3.
    navigate(peekPath(V3_ROUTES.recurring, paymentId), { replace: true });
  };

  const createMutation = trpc.payments.create.useMutation({
    onSuccess: (payment) => afterWrite(payment.id, 'Payment created'),
    onError: (error) => showError(error, 'Creating payment'),
  });

  const createFromExtractionMutation = trpc.payments.createFromExtraction.useMutation({
    onSuccess: (payment) => {
      void utils.vendors.invalidate();
      // The extraction is accepted inside the same mutation, so the review feed
      // and the document page are both stale now.
      void utils.documents.invalidate();
      void utils.review.listPending.invalidate();
      afterWrite(payment.id, 'Payment created from invoice');
    },
    onError: (error) => showError(error, 'Creating payment'),
  });

  const updateMutation = trpc.payments.update.useMutation({
    onSuccess: (payment) => afterWrite(payment.id, 'Payment updated'),
    onError: (error) => showError(error, 'Updating payment'),
  });

  const isSaving =
    createMutation.isPending || updateMutation.isPending || createFromExtractionMutation.isPending;
  // Only route through `createFromExtraction` when the extraction is actually in
  // hand: a stale link must degrade to the plain form rather than submit an id
  // the server will reject.
  const createsFromInvoice = Boolean(extractionId && extraction);
  const blockers = describeV3PaymentFormBlockers({
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
        <LoadingRamp
          phase={loadingPhase}
          skeleton={<FormSkeleton />}
          label="this payment"
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
        <QueryError error={formState.error} subject="this payment" onRetry={formState.retry} />
      </PageLayout>
    );
  }

  if (isEdit && !paymentQuery.data) {
    return (
      <PageLayout className="items-start">
        <div className="flex flex-col gap-1">
          <h1 className="text-title">That payment isn't here</h1>
          <p className="text-body text-muted-foreground">
            It may have been ended and removed, or the link may be out of date.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to={V3_ROUTES.recurring}>All recurring payments</Link>
        </Button>
      </PageLayout>
    );
  }

  const accounts = accountsQuery.data ?? [];

  return (
    <PageLayout>
      <div className="flex flex-col gap-2">
        <Button variant="ghost" size="sm" asChild className="-ml-2 self-start">
          <Link to={isEdit && id ? peekPath(V3_ROUTES.recurring, id) : V3_ROUTES.recurring}>
            <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
            {isEdit ? 'Back to payment' : 'All recurring payments'}
          </Link>
        </Button>
        <h1 className="text-title">{isEdit ? 'Edit payment' : 'New recurring payment'}</h1>
        <p className="text-body text-muted-foreground">
          A bill or recurring income, matched against transactions as they arrive.
        </p>
        {createsFromInvoice ? (
          <p className="flex items-start gap-1.5 text-caption text-muted-foreground">
            <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>
              Suggested from {extraction?.vendorNameRaw}
              {extraction?.invoiceNumber ? ` invoice #${extraction.invoiceNumber}` : ' invoice'}.
              {/* Only worth saying when a cadence WAS read off the document.
                  With none, the empty control and its own hint are the
                  message, and this sentence would read as a second one. */}
              {intervalUnit
                ? " One invoice can't prove how often it repeats — check the schedule before saving."
                : null}
            </span>
          </p>
        ) : null}
        {fromExtraction && !extraction ? (
          <p className="text-caption text-destructive">
            That invoice is no longer awaiting review, so nothing could be prefilled. Fill the form
            in yourself, or reopen the document from Review.
          </p>
        ) : null}
      </div>

      <Block>
        <FieldSet title="Who">
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
        <FieldSet title="What">
          <Field label="Direction" hint={direction === 'inflow' ? 'Money in' : 'Money out'}>
            <Segmented
              value={direction}
              onValueChange={(next) => setDirection(next as Direction)}
              aria-label="Direction"
              className="w-full"
            >
              <SegmentedItem value="outflow">Bill</SegmentedItem>
              <SegmentedItem value="inflow">Income</SegmentedItem>
            </Segmented>
          </Field>

          {/* "Amount is", not "Kind": the stored value is `fixed` / `variable`,
              which is a column name. The question a person is answering is
              whether the figure in the next field will hold. */}
          <Field
            label="Amount is"
            hint={
              kind === 'variable' ? 'The real figure is set when you settle each one.' : undefined
            }
          >
            <Segmented
              value={kind}
              onValueChange={(next) => setKind(next as PaymentKind)}
              aria-label="Is the amount fixed?"
              className="w-full"
            >
              <SegmentedItem value="fixed">Same every time</SegmentedItem>
              <SegmentedItem value="variable">Varies</SegmentedItem>
            </Segmented>
          </Field>

          <FieldRow>
            {/* The estimate is the one field on this form that may be left
                empty, and only because "varies" is an answer. A fixed amount
                is not optional — see `lib/payment-form.ts`. */}
            <Field
              label={kind === 'variable' ? 'Estimate' : 'Amount'}
              htmlFor="payment-amount"
              hint={kind === 'variable' ? 'Optional.' : undefined}
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
        <FieldSet title="When">
          {/* `Repeats every` keeps the full row: it is already two controls in a
              trench coat (a count and its unit), and pairing it with a third
              puts four controls on one line. */}
          <Field
            label="Repeats every"
            htmlFor="payment-interval-count"
            hint={describeRepeatInterval(intervalCount, intervalUnit)}
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
                <SelectTrigger className="text-body" aria-label="Repeat unit">
                  {/* Radix renders the placeholder for the empty value, which
                      is what an invoice with no stated cadence leaves here. */}
                  <SelectValue placeholder="How often?" />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_UNITS.map((unit) => (
                    <SelectItem key={unit.value} value={unit.value} className="text-body">
                      {unit.label}
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
              label="First due"
              htmlFor="payment-anchor-date"
              hint={createsFromInvoice ? ANCHOR_DATE_HINTS[anchorDateSource] : undefined}
            >
              <DateField
                id="payment-anchor-date"
                value={anchorDate}
                onChange={setAnchorDate}
                placeholder={anchorDateSource === 'none' ? 'Not on the invoice' : undefined}
                disabled={isSaving}
              />
            </Field>

            <Field
              label="Stops after"
              htmlFor="payment-end-date"
              hint="Leave empty to repeat forever."
            >
              <DateField
                id="payment-end-date"
                value={endDate}
                onChange={setEndDate}
                placeholder="Never"
                clearable
                disabled={isSaving}
              />
            </Field>
          </FieldRow>

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
                  This invoice is already paid
                </Label>
                <p className="text-caption text-muted-foreground">
                  Marks the period it covers as settled, so the one you'll see coming up is the next
                  payment, not this one.
                </p>
              </div>
            </div>
          ) : null}
        </FieldSet>
      </Block>

      <Block>
        <FieldSet title="Optional">
          <Field label="Linked account">
            <Select value={accountId} onValueChange={setAccountId} disabled={isSaving}>
              <SelectTrigger className="text-body" aria-label="Linked account">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ACCOUNT} className="text-body">
                  No linked account
                </SelectItem>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id} className="text-body">
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Notes" htmlFor="payment-notes">
            <Textarea
              id="payment-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Anything worth remembering about this payment"
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
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : isEdit ? (
            'Save changes'
          ) : (
            'Create payment'
          )}
        </Button>
        {/* A disabled button with no explanation is itself the defect the field
            validation was hiding, so the gate reports reasons rather than a
            boolean and the form prints them. */}
        {!canSubmit && !isSaving && blockers.length > 0 ? (
          <p className="text-center text-caption text-muted-foreground">
            To continue: {blockers.join(', ')}.
          </p>
        ) : null}
      </div>
    </PageLayout>
  );
}
