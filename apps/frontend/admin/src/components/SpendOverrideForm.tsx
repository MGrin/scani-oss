'use client';

import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import {
  PROVIDER_DISPLAY,
  type SpendOverride,
  type SpendProvider,
} from '@/lib/clients/spend-pricing';

const PROVIDERS: SpendProvider[] = ['neon', 'fly', 'upstash', 'cloudflare', 'sentry'];

/** Previous calendar month as `YYYY-MM` — the month a fresh invoice covers. */
function previousMonth(): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface Props {
  /** Existing overrides, used to pre-fill the amount when one already exists. */
  existing: SpendOverride[];
  /** Master gate — disabled when ADMIN_WRITES_ENABLED is off. */
  enabled: boolean;
}

/**
 * Record an actual bill off a vendor invoice. Neon and Fly expose no
 * billing API, and every live usage API only reports the *current*
 * month — so last month's real number reaches the page only through
 * this form. The recorded actual supersedes the estimate for its month.
 */
export function SpendOverrideForm({ existing, enabled }: Props) {
  const router = useRouter();
  const [provider, setProvider] = useState<SpendProvider>('neon');
  const [period, setPeriod] = useState(previousMonth());
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const match = useMemo(
    () => existing.find((o) => o.provider === provider && o.period === period),
    [existing, provider, period]
  );

  function selectProvider(p: SpendProvider) {
    setProvider(p);
    syncPrefill(p, period);
  }
  function changePeriod(p: string) {
    setPeriod(p);
    syncPrefill(provider, p);
  }
  function syncPrefill(p: SpendProvider, per: string) {
    const found = existing.find((o) => o.provider === p && o.period === per);
    setAmount(found ? String(found.amountUsd) : '');
    setNote(found?.note ?? '');
    setStatus(null);
  }

  function submit(clear: boolean) {
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/spend/override', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            provider,
            period,
            amountUsd: clear ? null : Number(amount),
            note: note || undefined,
            clear,
          }),
          cache: 'no-store',
        });
        const json = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          message?: string;
        };
        if (!res.ok || json.ok === false) {
          setStatus({ ok: false, message: json.error ?? `HTTP ${res.status}` });
          return;
        }
        setStatus({ ok: true, message: json.message ?? 'Saved.' });
        if (clear) {
          setAmount('');
          setNote('');
        }
        router.refresh();
      } catch (err) {
        setStatus({ ok: false, message: err instanceof Error ? err.message : String(err) });
      }
    });
  }

  if (!enabled) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        Recording actuals is disabled — set <code>ADMIN_WRITES_ENABLED=1</code> to enable.
      </p>
    );
  }

  const amountValid = amount !== '' && Number.isFinite(Number(amount)) && Number(amount) >= 0;

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ovr-provider" className="text-xs">
            Provider
          </Label>
          <Select value={provider} onValueChange={(v) => selectProvider(v as SpendProvider)}>
            <SelectTrigger id="ovr-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p} value={p}>
                  {PROVIDER_DISPLAY[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ovr-period" className="text-xs">
            Billing month
          </Label>
          <Input
            id="ovr-period"
            type="month"
            value={period}
            onChange={(e) => changePeriod(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ovr-amount" className="text-xs">
            Actual bill (USD)
          </Label>
          <Input
            id="ovr-amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            placeholder="24.29"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ovr-note" className="text-xs">
            Note (optional)
          </Label>
          <Input
            id="ovr-note"
            placeholder="e.g. invoice #123"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending || !amountValid}
          onClick={() => submit(false)}
        >
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {match ? 'Update actual' : 'Record actual'}
        </Button>
        {match ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => submit(true)}
          >
            Clear
          </Button>
        ) : null}
        {status ? (
          <span
            className={`text-xs ${status.ok ? 'text-emerald-500' : 'text-destructive'}`}
            role="status"
            aria-live="polite"
          >
            {status.message}
          </span>
        ) : null}
      </div>
    </div>
  );
}
