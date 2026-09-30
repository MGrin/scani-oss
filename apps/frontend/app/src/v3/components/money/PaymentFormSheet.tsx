import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Button } from '@scani/ui/ui/button';
import { Checkbox } from '@scani/ui/ui/checkbox';
import { Label } from '@scani/ui/ui/label';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Textarea } from '@scani/ui/ui/textarea';
import { showSuccess } from '@scani/ui/ui/use-toast';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { peekPath } from '@scani/ui/v3/lib/peek';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import type { TFunction } from 'i18next';
import { FileText } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { baseCurrencyDefaultAction } from '@/lib/currency-default';
import { trpc } from '@/lib/trpc';
import {
  type AnchorDateSource,
  buildInvoicePrefill,
  matchCurrencyToken,
} from '@/v3/lib/extractionPrefill';
import { usePaymentSheet } from '../../hooks/usePaymentSheet';
import {
  describeRepeatInterval,
  describeV3PaymentFormBlockers,
  type IntervalUnit,
  type IntervalUnitChoice,
  type PaymentKind,
  paymentAccountOptions,
  paymentAccountSelectedLabel,
} from '../../lib/payment-form';
import { todayDateString } from '../../lib/paymentTotals';
import { type PaymentSheetTarget, V3_PAYMENT_ROUTES, V3_ROUTES } from '../../lib/routes';
import { DateField } from '../form/DateField';
import { Field, FieldRow } from '../form/Field';
import { FormActions, FormSection, FormSheet } from '../form/FormSheet';
import { RecordPicker } from '../form/RecordPicker';
import { CurrencyField, tokenLabel } from './CurrencyField';
import { PaymentGroupsPicker } from './PaymentGroupsPicker';
import { VendorField } from './VendorField';

/**
 * Create — and, with an id, update — a recurring payment, in a `FormSheet`
 * addressed by the URL (SC-1414; `PAYMENT_SHEET` in `lib/routes.ts`). One
 * component for both, because `payments.create` and
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
 * - **`<FormSection>` per section, not a card**, and the section heading is a
 *   14px muted label rather than a 16px card title: the field labels are the
 *   things being read, and v2's headings compete with them. The sections were
 *   `<Block>`s until SC-1436 — a box in a box, and the one edit panel that
 *   looked unlike the rest.
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

/** The form's first three sections at their real height. Drawn only from the
 *  `skeleton` band of the ramp — an edit opened from the peek sheet almost
 *  always has its payment in cache, and a skeleton that appears for a
 *  quarter of a second before the real fields is the flash V3-16 deletes. */
function FormSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {['who', 'what', 'when'].map((key) => (
        <div key={key} className="flex flex-col gap-3">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ))}
    </div>
  );
}

/** The form's old page paths, `/payments/recurring/new` and `…/:id/edit`,
 *  kept as redirects to the sheet for bookmarks (SC-1414). The old
 *  `?fromExtraction=` is not carried: nothing in v3 writes it any more, and a
 *  reader of a parameter nothing produces is what `query-producers.test.ts`
 *  exists to refuse. */
export function LegacyPaymentFormRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={id ? V3_PAYMENT_ROUTES.edit(id) : V3_PAYMENT_ROUTES.create} replace />;
}

/** Mounted once in the shell: renders the form while the URL names one. Keyed
 *  by the sheet value, so switching from one bill to another starts clean. */
export function PaymentFormSheet() {
  const { key, target, close } = usePaymentSheet();
  if (!target || !key) return null;
  return <PaymentForm key={key} target={target} onClose={close} />;
}

function PaymentForm({ target, onClose }: { target: PaymentSheetTarget; onClose: () => void }) {
  const { t } = useTranslation();
  const id = target.mode === 'edit' ? target.paymentId : undefined;
  const isEdit = Boolean(id);
  useDocumentTitle(
    isEdit ? t('v3.money.paymentForm.titleEdit') : t('v3.money.paymentForm.titleNew')
  );
  // Only meaningful on create: an edit already has its own vendor, amount and
  // cadence, and re-applying an invoice over them is a silent overwrite of what
  // the user previously confirmed.
  const extractionId = target.mode === 'invoice' ? target.extractionId : null;
  const fromExtraction = Boolean(extractionId);
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const paymentQuery = trpc.payments.get.useQuery({ paymentId: id ?? '' }, { enabled: isEdit });
  const accountsQuery = trpc.accounts.getByUserIdWithSummary.useQuery();
  // Only for the linked-account picker's rows: an account carries an
  // `institutionId` and not a name, and a row that cannot say where the account
  // is held makes two accounts called `Savings` indistinguishable (SC-862).
  const institutionsQuery = trpc.institutions.getByUserId.useQuery();
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
    // `accountsQuery` on the edit route only, and it is not decoration: the
    // linked-account picker shows its chosen account by NAME, which it cannot
    // do before the accounts arrive — so an edit rendered ahead of them said
    // "no account linked" about a payment that has one (SC-862). On the create
    // route nothing is chosen, so there is nothing to be wrong about.
    ...(isEdit ? [paymentQuery, accountsQuery] : []),
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
  const [oneOff, setOneOff] = useState(false);
  /** Empty is a real answer here — the section is optional and an unlinked
   *  payment is the common case. It was a `'__none__'` sentinel while this was
   *  a `<Select>`, which cannot hold an empty value; a combobox with nothing in
   *  it says the same thing without a row that has to be chosen (SC-862). */
  const [accountId, setAccountId] = useState('');
  const [accountQuery, setAccountQuery] = useState('');
  const [accountOpen, setAccountOpen] = useState(false);
  const [notes, setNotes] = useState('');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const assignments = trpc.payments.groupAssignments.useQuery();
  const groupsSeeded = useRef(false);
  useEffect(() => {
    if (id && assignments.data && !groupsSeeded.current) {
      setGroupIds(assignments.data.payments[id] ?? []);
      groupsSeeded.current = true;
    }
  }, [id, assignments.data]);
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
    setOneOff(payment.endDate === payment.anchorDate);
    setAccountId(payment.accountId ?? '');
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

  const [failure, setFailure] = useState<string | null>(null);
  const failed = (error: unknown) => {
    const copy = describeQueryError(error, t('v3.money.thisPayment'), 'save');
    setFailure(`${copy.title}. ${copy.detail}`);
  };

  const afterWrite = (paymentId: string, message: string) => {
    showSuccess(message);
    void utils.payments.invalidate();
    // Back to the list with the record's own peek open, which is where a
    // payment's detail lives in v3.
    navigate(peekPath(V3_ROUTES.recurring, paymentId), { replace: true });
  };

  // A failure is said in the sheet, under the button, rather than in a toast
  // that opens with "Something went wrong" and leaves after four seconds
  // (`FormActions`).
  const createMutation = trpc.payments.create.useMutation({
    onSuccess: (payment) => afterWrite(payment.id, t('v3.money.paymentForm.created')),
    onError: failed,
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
    onError: failed,
  });

  const updateMutation = trpc.payments.update.useMutation({
    onSuccess: (payment) => afterWrite(payment.id, t('v3.money.paymentForm.updated')),
    onError: failed,
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
    if (!canSubmit || !currency || !intervalUnit || (isEdit && !assignments.data)) return;
    setFailure(null);
    const payload = {
      direction,
      kind,
      groupIds,
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
      endDate: oneOff ? anchorDate : endDate.trim() ? endDate.trim() : null,
      accountId: accountId || null,
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

  const shell = (body: ReactNode, footer?: ReactNode) => (
    <FormSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={isEdit ? t('v3.money.paymentForm.titleEdit') : t('v3.money.paymentForm.titleNew')}
      description={t('v3.money.paymentForm.intro')}
      footer={footer}
    >
      {body}
    </FormSheet>
  );

  // Rendering the empty form first and rewriting every field a beat later reads
  // as the app undoing the user's work.
  if (formState.isLoading) {
    return shell(
      <>
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
      </>
    );
  }

  // A request that failed is not a payment that was deleted, and telling
  // someone their bill is gone when the server merely timed out is the worst
  // thing this screen can say. The two states are separated here.
  if (formState.isError) {
    return shell(
      <QueryError
        error={formState.error}
        subject={t('v3.money.thisPayment')}
        onRetry={formState.retry}
      />
    );
  }

  if (isEdit && !paymentQuery.data) {
    return shell(
      <div className="flex flex-col items-start gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-body font-medium">{t('v3.money.paymentForm.missingTitle')}</p>
          <p className="text-body text-muted-foreground">{t('v3.money.paymentForm.missingBody')}</p>
        </div>
        <Button asChild variant="outline">
          <Link to={V3_ROUTES.recurring}>{t('v3.money.paymentForm.allRecurring')}</Link>
        </Button>
      </div>
    );
  }

  const institutionNames = new Map(
    (institutionsQuery.data ?? []).map((institution) => [institution.id, institution.name])
  );
  const accountChoices = (accountsQuery.data ?? []).map((account) => ({
    id: account.id,
    name: account.name,
    institution: institutionNames.get(account.institutionId),
  }));
  const accountOptions = paymentAccountOptions(accountChoices, accountQuery);
  const selectedAccount = accountChoices.find((account) => account.id === accountId);

  return shell(
    <div className="flex flex-col gap-4">
      {/* Rendered only with something in it: an empty sibling would draw the
          rule `FormSection` puts above anything that precedes it. */}
      {createsFromInvoice || (fromExtraction && !extraction) ? (
        <div className="flex flex-col gap-2">
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
      ) : null}

      <FormSection title={t('v3.money.paymentForm.sectionWho')}>
        <VendorField
          value={vendorId}
          valueLabel={vendorName}
          pendingName={createsFromInvoice ? pendingVendorName : undefined}
          onSelect={(nextVendorId, displayName) => {
            // The payee's groups follow the payee: a bill moved to another
            // payee leaves the old one's rule groups and joins the new one's
            // (SC-1408). Groups the reader ticked themselves stay.
            const rules = assignments.data?.payees ?? {};
            const leaving = new Set(rules[vendorId] ?? []);
            setGroupIds((current) => [
              ...new Set([
                ...current.filter((groupId) => !leaving.has(groupId)),
                ...(rules[nextVendorId] ?? []),
              ]),
            ]);
            setVendorId(nextVendorId);
            setVendorName(displayName);
          }}
          onClearPending={() => setPendingVendorName('')}
          disabled={isSaving}
        />
      </FormSection>

      <FormSection title={t('v3.money.paymentForm.sectionWhat')}>
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
            <SegmentedItem value="variable">{t('v3.money.paymentForm.kindVariable')}</SegmentedItem>
          </Segmented>
        </Field>

        {/* One column at every width: the sheet is 448px wide even on a desktop,
              and beside the amount the currency picker truncated to "USD …". */}
        <FieldRow className="lg:grid-cols-1">
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
      </FormSection>

      <FormSection title={t('v3.money.paymentForm.sectionWhen')}>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={oneOff}
            onChange={(event) => {
              setOneOff(event.target.checked);
              if (event.target.checked) {
                setIntervalUnit('month');
                setIntervalCount('1');
              }
            }}
          />
          {t('v3.money.groups.oneOff')}
        </label>
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
              <SelectTrigger aria-label={t('v3.money.paymentForm.repeatUnit')}>
                {/* Radix renders the placeholder for the empty value, which
                      is what an invoice with no stated cadence leaves here. */}
                <SelectValue placeholder={t('v3.money.paymentForm.repeatUnitPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {INTERVAL_UNITS.map((unit) => (
                  <SelectItem key={unit.value} value={unit.value}>
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
      </FormSection>

      <FormSection title={t('v3.money.paymentForm.sectionOptional')}>
        {/* `RecordPicker`, not the `<Select>` this was: a select over every
              account has no search, so a reader with more accounts than the
              popover shows scrolls a list of bare names — and the name alone
              cannot tell two `Savings` apart. Deliberately not `AccountPicker`,
              which is the control for COMPARING rows and would put an inline
              radio list of every account into an optional section (SC-862). */}
        <Field label={t('v3.money.paymentForm.linkedAccount')} htmlFor="payment-account">
          <RecordPicker
            inputId="payment-account"
            ariaLabel={t('v3.money.paymentForm.linkedAccount')}
            value={
              selectedAccount
                ? { id: selectedAccount.id, label: paymentAccountSelectedLabel(selectedAccount) }
                : null
            }
            onSelect={(chosenId) => {
              setAccountId(chosenId);
              setAccountQuery('');
            }}
            // No "none" row to go back to, and none is needed: an empty
            // optional field already says no account is linked.
            onClear={() => {
              setAccountId('');
              setAccountQuery('');
              setAccountOpen(true);
            }}
            query={accountQuery}
            onQueryChange={setAccountQuery}
            open={accountOpen}
            onOpenChange={setAccountOpen}
            options={accountOptions}
            isLoading={accountsQuery.isLoading}
            placeholder={t('v3.money.paymentForm.accountSearchPlaceholder')}
            emptyLabel={t('v3.money.paymentForm.accountNoResults')}
            disabled={isSaving}
          />
        </Field>

        <PaymentGroupsPicker
          value={groupIds}
          onChange={setGroupIds}
          viaPayee={assignments.data?.payees[vendorId] ?? []}
          disabled={isSaving}
        />
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
      </FormSection>
    </div>,
    <FormActions
      submitLabel={
        isEdit ? t('v3.money.paymentForm.saveChanges') : t('v3.money.paymentForm.create')
      }
      pendingLabel={t('v3.money.paymentForm.saving')}
      onSubmit={handleSubmit}
      onCancel={onClose}
      blockers={blockers}
      pending={isSaving}
      error={failure}
    />
  );
}
