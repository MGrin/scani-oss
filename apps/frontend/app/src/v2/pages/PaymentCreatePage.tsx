import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { PageLoader } from '@scani/ui/ui/loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { Textarea } from '@scani/ui/ui/textarea';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { VendorPicker } from '../components/payments/VendorPicker';
import { TokenSearchInput, type TokenSelectionValue } from '../components/tokens/TokenSearchInput';
import { useBaseCurrency } from '../hooks/useBaseCurrency';
import { describePaymentFormBlockers } from '../lib/paymentForm';
import { V2_ROUTES } from '../lib/routes';

type Direction = 'outflow' | 'inflow';
type Kind = 'fixed' | 'variable';
type IntervalUnit = 'week' | 'month' | 'quarter' | 'year';

const NO_ACCOUNT = '__none__';

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Create (and, via `/payments/:id/edit`, update) a recurring payment.
 * Reused for both because `payments.create` and `payments.update` take
 * near-identical shapes — the only difference is which mutation fires and
 * whether the fields start prefilled from `payments.get`.
 */
export function PaymentCreatePage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const paymentQuery = trpc.payments.get.useQuery({ paymentId: id ?? '' }, { enabled: isEdit });
  const { data: accounts, isLoading: accountsLoading } =
    trpc.accounts.getByUserIdWithSummary.useQuery();
  const { data: tokens, isLoading: tokensLoading } = trpc.tokens.getAll.useQuery(undefined, {
    enabled: isEdit,
  });
  const {
    token: baseCurrencyToken,
    isLoading: baseCurrencyLoading,
    isResolved: baseCurrencyResolved,
  } = useBaseCurrency();

  const [vendorId, setVendorId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [direction, setDirection] = useState<Direction>('outflow');
  const [kind, setKind] = useState<Kind>('fixed');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<TokenSelectionValue | null>(null);
  const [intervalUnit, setIntervalUnit] = useState<IntervalUnit>('month');
  const [intervalCount, setIntervalCount] = useState('1');
  const [anchorDate, setAnchorDate] = useState(todayDateString());
  const [endDate, setEndDate] = useState('');
  const [accountId, setAccountId] = useState(NO_ACCOUNT);
  const [notes, setNotes] = useState('');
  const [prefilled, setPrefilled] = useState(false);

  // Prefill once the existing payment loads — a plain `useState` initial
  // value can't work here since the query is still loading on first render.
  useEffect(() => {
    if (!isEdit || prefilled || !paymentQuery.data || !tokens) return;
    const { payment } = paymentQuery.data;
    const token = tokens.find((t) => t.id === payment.currencyTokenId);
    setVendorId(payment.vendorId);
    setDirection(payment.direction as Direction);
    setKind(payment.kind as Kind);
    setAmount(payment.expectedAmount ?? '');
    setCurrency({
      id: payment.currencyTokenId,
      label: token ? `${token.symbol} — ${token.name}` : payment.currencyTokenId,
    });
    setIntervalUnit(payment.intervalUnit as IntervalUnit);
    setIntervalCount(String(payment.intervalCount));
    setAnchorDate(payment.anchorDate);
    setEndDate(payment.endDate ?? '');
    setAccountId(payment.accountId ?? NO_ACCOUNT);
    setNotes(payment.notes ?? '');
    setPrefilled(true);
  }, [isEdit, prefilled, paymentQuery.data, tokens]);

  // Default the currency to the user's base currency on mount. Without
  // this, `TokenSearchInput` starts empty and `currency` stays `null`
  // until the user picks a result from the dropdown — typing "USD" and
  // moving on reads as filled but leaves the form silently invalid.
  useEffect(() => {
    if (isEdit || currency || baseCurrencyLoading || !baseCurrencyResolved) return;
    setCurrency({
      id: baseCurrencyToken.id,
      label: `${baseCurrencyToken.symbol} — ${baseCurrencyToken.name}`,
    });
  }, [isEdit, currency, baseCurrencyLoading, baseCurrencyResolved, baseCurrencyToken]);

  const createMutation = trpc.payments.create.useMutation({
    onSuccess: (payment) => {
      showSuccess('Payment created');
      void utils.payments.invalidate();
      navigate(V2_ROUTES.paymentDetail(payment.id));
    },
    onError: (error) => showError(error, 'Creating payment'),
  });

  const updateMutation = trpc.payments.update.useMutation({
    onSuccess: (payment) => {
      showSuccess('Payment updated');
      void utils.payments.invalidate();
      navigate(V2_ROUTES.paymentDetail(payment.id));
    },
    onError: (error) => showError(error, 'Updating payment'),
  });

  const isSaving = createMutation.isPending || updateMutation.isPending;
  // A disabled button with no explanation is itself the defect the field
  // validation was hiding, so the gate reports reasons rather than a
  // boolean and the form prints them under the button.
  const blockers = describePaymentFormBlockers({
    vendorId,
    currencyTokenId: currency?.id ?? null,
    anchorDate,
    intervalCount,
  });
  const canSubmit = blockers.length === 0;

  const handleSubmit = () => {
    if (!canSubmit || !currency) return;
    const payload = {
      vendorId,
      direction,
      kind,
      expectedAmount: amount.trim() ? amount.trim() : null,
      currencyTokenId: currency.id,
      intervalUnit,
      // Safe to parse unguarded: `canSubmit` above is false unless
      // `describePaymentFormBlockers` accepted this value as a positive
      // integer, and the early return has already run.
      intervalCount: Number.parseInt(intervalCount, 10),
      anchorDate,
      endDate: endDate.trim() ? endDate.trim() : null,
      accountId: accountId === NO_ACCOUNT ? null : accountId,
      notes: notes.trim() ? notes.trim() : null,
    };
    if (isEdit && id) {
      updateMutation.mutate({ paymentId: id, ...payload });
    } else {
      createMutation.mutate(payload);
    }
  };

  if (isEdit && (paymentQuery.isLoading || accountsLoading || tokensLoading)) return <PageLoader />;
  if (isEdit && (paymentQuery.error || !paymentQuery.data)) {
    return (
      <div className="max-w-2xl space-y-6">
        <p className="text-sm text-destructive">Payment not found.</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild className="-ml-2 mb-2">
          <Link to={isEdit && id ? V2_ROUTES.paymentDetail(id) : V2_ROUTES.paymentsList}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            {isEdit ? 'Back to payment' : 'All payments'}
          </Link>
        </Button>
        <h2 className="text-2xl font-bold tracking-tight">
          {isEdit ? 'Edit Recurring Payment' : 'New Recurring Payment'}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          A bill or recurring income, matched against transactions as they arrive.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Who</CardTitle>
        </CardHeader>
        <CardContent>
          <VendorPicker
            value={vendorId}
            valueLabel={vendorName}
            onSelect={(newVendorId, displayName) => {
              setVendorId(newVendorId);
              setVendorName(displayName);
            }}
            disabled={isSaving}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">What</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Direction</Label>
              <Select
                value={direction}
                onValueChange={(v) => setDirection(v as Direction)}
                disabled={isSaving}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="outflow">Bill (money out)</SelectItem>
                  <SelectItem value="inflow">Income (money in)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as Kind)} disabled={isSaving}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Fixed amount</SelectItem>
                  <SelectItem value="variable">Variable amount</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Cells bottom-align their contents so the inputs stay on one
              line even when a label wraps and its neighbour's doesn't
              ("Estimated amount (optional)" vs "Currency", at narrow
              widths). Grid rows stretch both cells to the same height, so
              justify-end pins both controls to that shared baseline —
              no reserved label height to guess at. */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 flex flex-col justify-end">
              <Label className="text-xs">
                {kind === 'variable' ? 'Estimated amount (optional)' : 'Amount'}
              </Label>
              <NumericFormat
                value={amount}
                onValueChange={(v) => setAmount(v.value)}
                customInput={Input}
                placeholder="0.00"
                thousandSeparator=","
                decimalSeparator="."
                decimalScale={2}
                allowNegative={false}
                disabled={isSaving}
              />
            </div>
            <div className="space-y-1.5 flex flex-col justify-end">
              <Label className="text-xs">Currency</Label>
              <TokenSearchInput
                value={currency}
                onSelect={(tokenId, label) => setCurrency({ id: tokenId, label })}
                onClear={() => setCurrency(null)}
                placeholder="Search currencies..."
                disabled={isSaving}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">When</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Repeats every</Label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={1}
                  value={intervalCount}
                  onChange={(e) => setIntervalCount(e.target.value)}
                  className="w-20"
                  disabled={isSaving}
                />
                <Select
                  value={intervalUnit}
                  onValueChange={(v) => setIntervalUnit(v as IntervalUnit)}
                  disabled={isSaving}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="week">Week(s)</SelectItem>
                    <SelectItem value="month">Month(s)</SelectItem>
                    <SelectItem value="quarter">Quarter(s)</SelectItem>
                    <SelectItem value="year">Year(s)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Anchor date</Label>
              <Input
                type="date"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value)}
                disabled={isSaving}
              />
            </div>
          </div>
          {/* Fortnightly = interval `week` x 2 anchored on a weekday — it
              produces that weekday every two weeks, never "twice a month".
              Rendered below the grid, not inside the "Repeats every"
              column, so it doesn't grow that column past its neighbour. */}
          <p className="text-[11px] text-muted-foreground">
            e.g. fortnightly = every 2 weeks, anchored on the day it's due
          </p>

          <div className="space-y-1.5">
            <Label className="text-xs">End date (optional)</Label>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              disabled={isSaving}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Extra (optional)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Linked account</Label>
            <Select value={accountId} onValueChange={setAccountId} disabled={isSaving}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ACCOUNT}>No linked account</SelectItem>
                {(accounts ?? []).map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Anything worth remembering about this payment"
              disabled={isSaving}
            />
          </div>
        </CardContent>
      </Card>

      <Button onClick={handleSubmit} disabled={!canSubmit || isSaving} className="w-full">
        {isSaving ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Saving...
          </>
        ) : isEdit ? (
          'Save Changes'
        ) : (
          'Create Payment'
        )}
      </Button>
      {!canSubmit && !isSaving && blockers.length > 0 && (
        <p className="text-xs text-muted-foreground text-center -mt-3">
          To continue: {blockers.join(', ')}.
        </p>
      )}
    </div>
  );
}
