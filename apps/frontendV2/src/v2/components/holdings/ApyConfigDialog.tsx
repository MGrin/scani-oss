import { useEffect, useState } from 'react';
import { NumericFormat } from 'react-number-format';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from '../../hooks/invalidatePortfolioQueries';

const FREQUENCY_OPTIONS = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays (Mon-Fri)' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
] as const;

const DAY_OF_WEEK_OPTIONS = [
  { value: 0, label: 'Sunday' },
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
] as const;

const MONTH_OPTIONS = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
] as const;

interface ApyConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  holdingId: string;
  existingConfig?: {
    annualRatePct: string;
    payoutFrequency: string;
    payoutDayOfWeek: number | null;
    payoutDayOfMonth: number | null;
    payoutMonth: number | null;
  };
}

export function ApyConfigDialog({
  open,
  onOpenChange,
  holdingId,
  existingConfig,
}: ApyConfigDialogProps) {
  const utils = trpc.useUtils();
  const isEditMode = !!existingConfig;

  const [annualRate, setAnnualRate] = useState('');
  const [frequency, setFrequency] = useState<string>('monthly');
  const [dayOfWeek, setDayOfWeek] = useState<number>(1);
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [month, setMonth] = useState<number>(1);

  useEffect(() => {
    if (existingConfig) {
      setAnnualRate(existingConfig.annualRatePct);
      setFrequency(existingConfig.payoutFrequency);
      if (existingConfig.payoutDayOfWeek != null) setDayOfWeek(existingConfig.payoutDayOfWeek);
      if (existingConfig.payoutDayOfMonth != null)
        setDayOfMonth(String(existingConfig.payoutDayOfMonth));
      if (existingConfig.payoutMonth != null) setMonth(existingConfig.payoutMonth);
    } else {
      setAnnualRate('');
      setFrequency('monthly');
      setDayOfWeek(1);
      setDayOfMonth('1');
      setMonth(1);
    }
  }, [existingConfig]);

  const upsertMutation = trpc.holdings.upsertApyConfig.useMutation({
    onSuccess: async () => {
      await invalidatePortfolioQueries(utils);
      onOpenChange(false);
      showSuccess(isEditMode ? 'APY configuration updated' : 'APY configuration created');
    },
    onError: (error) => showError(error, 'Failed to save APY configuration'),
  });

  const handleSubmit = () => {
    if (!annualRate) return;

    const dayOfMonthNum = Number.parseInt(dayOfMonth, 10);

    upsertMutation.mutate({
      holdingId,
      annualRatePct: annualRate,
      payoutFrequency: frequency as 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly',
      payoutDayOfWeek: frequency === 'weekly' ? dayOfWeek : null,
      payoutDayOfMonth:
        frequency === 'monthly' || frequency === 'yearly'
          ? Number.isNaN(dayOfMonthNum)
            ? 1
            : dayOfMonthNum
          : null,
      payoutMonth: frequency === 'yearly' ? month : null,
    });
  };

  const isPending = upsertMutation.isPending;
  const showDayOfWeek = frequency === 'weekly';
  const showDayOfMonth = frequency === 'monthly' || frequency === 'yearly';
  const showMonth = frequency === 'yearly';

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (isPending) return;
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit APY Configuration' : 'Configure APY'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="apy-rate">Annual Rate (%)</Label>
            <NumericFormat
              id="apy-rate"
              value={annualRate}
              onValueChange={(values) => setAnnualRate(values.value)}
              customInput={Input}
              placeholder="e.g., 4.5"
              decimalSeparator="."
              decimalScale={4}
              allowNegative={false}
              isAllowed={(values) => {
                const { floatValue } = values;
                return floatValue === undefined || (floatValue > 0 && floatValue <= 100);
              }}
              disabled={isPending}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label>Payout Frequency</Label>
            <Select value={frequency} onValueChange={setFrequency} disabled={isPending}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FREQUENCY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {showDayOfWeek && (
            <div className="space-y-2">
              <Label>Day of Week</Label>
              <Select
                value={String(dayOfWeek)}
                onValueChange={(v) => setDayOfWeek(Number(v))}
                disabled={isPending}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAY_OF_WEEK_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={String(opt.value)}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {showMonth && (
            <div className="space-y-2">
              <Label>Month</Label>
              <Select
                value={String(month)}
                onValueChange={(v) => setMonth(Number(v))}
                disabled={isPending}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTH_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={String(opt.value)}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {showDayOfMonth && (
            <div className="space-y-2">
              <Label>Day of Month</Label>
              <NumericFormat
                value={dayOfMonth}
                onValueChange={(values) => setDayOfMonth(values.value)}
                customInput={Input}
                placeholder="1-31"
                decimalScale={0}
                allowNegative={false}
                isAllowed={(values) => {
                  const { floatValue } = values;
                  return floatValue === undefined || (floatValue >= 1 && floatValue <= 31);
                }}
                disabled={isPending}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!annualRate || isPending}>
            {isEditMode ? 'Save' : 'Configure'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
