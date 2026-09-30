import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { allocatedElsewhere, type ShareIssue, shareIssue, shareValue } from '../../lib/addMembers';
import { type MemberEntry, memberMatches } from '../../lib/membership';
import { ChoiceSelect } from '../form/ChoiceSelect';
import { FormSheet } from '../form/FormSheet';
import { PickRow } from './PickRow';

type Step = 'choose' | 'shares' | 'review';

interface VaultAttachSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  vaultId: string;
  vaultName: string;
  /** The user's base currency: holding values are stated in it. */
  currency: string;
  candidates: readonly MemberEntry[];
  values: ReadonlyMap<string, number | null>;
  allocations: readonly { holdingId: string; vaultId: string; percentage: number }[];
  vaultNames: ReadonlyMap<string, string>;
  pending: boolean;
  onAttach: (entries: MemberEntry[], shares: Record<string, number>) => Promise<void>;
}

// Radix Select cannot show an empty-string value, so the sentinel is a word.
const ALL_ACCOUNTS = 'all';

/**
 * "Attach holdings to <vault>" (SC-1411), in three steps in one sheet: choose
 * the holdings, set the share each contributes, review. A holding can be split
 * across vaults, so the share step says how much is still free and where the
 * rest already counts — the one fact the user needs to pick a number.
 */
export function VaultAttachSheet({
  open,
  onOpenChange,
  vaultId,
  vaultName,
  currency,
  candidates,
  values,
  allocations,
  vaultNames,
  pending,
  onAttach,
}: VaultAttachSheetProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('choose');
  const [query, setQuery] = useState('');
  const [account, setAccount] = useState(ALL_ACCOUNTS);
  const [ticked, setTicked] = useState<string[]>([]);
  const [shares, setShares] = useState<Record<string, number | undefined>>({});

  const accounts = useMemo(
    () => [
      ...new Map(
        candidates.flatMap((e) => (e.accountId && e.account ? [[e.accountId, e.account]] : []))
      ),
    ],
    [candidates]
  );
  const chosen = ticked
    .map((id) => candidates.find((e) => e.id === id))
    .filter((e): e is MemberEntry => Boolean(e));
  const issues = new Map<string, ShareIssue | null>(
    chosen.map((e) => [e.id, shareIssue(shares[e.id], e.available ?? 0)])
  );
  const blocked = chosen.filter((e) => issues.get(e.id));
  const total = chosen.reduce(
    (sum, e) => sum + (shareValue(values.get(e.id) ?? null, shares[e.id]) ?? 0),
    0
  );

  const close = (next: boolean) => {
    if (!next) {
      setStep('choose');
      setQuery('');
      setAccount(ALL_ACCOUNTS);
      setTicked([]);
      setShares({});
    }
    onOpenChange(next);
  };
  const attach = async () => {
    try {
      await onAttach(chosen, shares as Record<string, number>);
      close(false);
    } catch {
      /* Shown by the hook; the choices stay so the user can correct them. */
    }
  };

  const primary =
    step === 'choose'
      ? {
          label: t('v3.vaults.attach.next', { count: chosen.length }),
          disabled: chosen.length === 0,
          go: () => setStep('shares'),
        }
      : step === 'shares'
        ? {
            label: t('v3.vaults.attach.toReview'),
            disabled: blocked.length > 0,
            go: () => setStep('review'),
          }
        : {
            label: t('v3.vaults.attach.submit', { count: chosen.length }),
            disabled: pending,
            go: () => void attach(),
          };
  const back = step === 'shares' ? 'choose' : step === 'review' ? 'shares' : null;

  const rows = candidates.filter(
    (e) => (account === ALL_ACCOUNTS || e.accountId === account) && memberMatches(e, query)
  );

  return (
    <FormSheet
      open={open}
      onOpenChange={close}
      title={t('v3.vaults.attach.title', { vault: vaultName })}
      description={t(`v3.vaults.attach.${step}.description`)}
      footer={
        <>
          {step === 'shares' && blocked.length > 0 ? (
            <p className="text-caption text-muted-foreground" aria-live="polite">
              {t('v3.form.blockers', {
                blockers: blocked
                  .map((e) => t('v3.vaults.attach.shareFor', { label: e.label }))
                  .join(', '),
              })}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 lg:flex-row lg:justify-end">
            {back ? (
              <Button variant="ghost" onClick={() => setStep(back)} disabled={pending}>
                {t('v3.vaults.attach.back')}
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => close(false)} disabled={pending}>
                {t('v3.form.cancel')}
              </Button>
            )}
            <Button onClick={primary.go} disabled={primary.disabled}>
              {pending ? t('v3.vaults.attach.attaching') : primary.label}
            </Button>
          </div>
        </>
      }
    >
      {step === 'choose' ? (
        <div className="flex flex-col gap-3">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('ui.dataView.accounts.config.search')}
            aria-label={t('v3.vaults.attach.search')}
          />
          {accounts.length > 1 ? (
            <ChoiceSelect
              label={t('ui.dataView.holdings.col.account')}
              value={account}
              onValueChange={setAccount}
              options={[
                { value: ALL_ACCOUNTS, label: t('v3.vaults.attach.allAccounts') },
                ...accounts.map(([value, label]) => ({ value, label })),
              ]}
            />
          ) : null}
          {rows.length === 0 ? (
            <p className="py-6 text-center text-body text-muted-foreground">
              {t('v3.vaults.attach.empty')}
            </p>
          ) : (
            <div className="-mx-3 flex flex-col">
              {rows.map((entry) => (
                <PickRow
                  key={entry.id}
                  id={`attach-${entry.id}`}
                  label={entry.label}
                  sublabel={entry.sublabel}
                  checked={ticked.includes(entry.id)}
                  onCheckedChange={(checked) =>
                    setTicked(
                      checked ? [...ticked, entry.id] : ticked.filter((id) => id !== entry.id)
                    )
                  }
                  trailing={t('v3.vaults.attach.free', { percent: entry.available ?? 0 })}
                  disabledReason={
                    (entry.available ?? 0) <= 0 ? t('v3.vaults.attach.fullyAllocated') : undefined
                  }
                />
              ))}
            </div>
          )}
        </div>
      ) : null}

      {step === 'shares' ? (
        <div className="flex flex-col gap-3">
          {chosen.map((entry) => {
            const available = entry.available ?? 0;
            const elsewhere = allocatedElsewhere(entry.id, vaultId, allocations, vaultNames);
            const issue = issues.get(entry.id);
            return (
              <div
                key={entry.id}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-3"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-label">{entry.label}</span>
                  <Numeric
                    value={values.get(entry.id) ?? null}
                    currency={currency}
                    className="text-caption text-muted-foreground"
                  />
                </div>
                <p className="text-caption text-muted-foreground">
                  {elsewhere.length > 0
                    ? t('v3.vaults.attach.freeElsewhere', {
                        percent: available,
                        elsewhere: elsewhere.map((e) => `${e.percentage}% ${e.name}`).join(', '),
                      })
                    : t('v3.vaults.attach.freeAll', { percent: available })}
                </p>
                <div className="flex flex-col gap-2">
                  <div className="relative">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min="0.01"
                      max={available}
                      step="0.01"
                      className="pe-7"
                      aria-label={t('v3.membership.allocationFor', { label: entry.label })}
                      aria-invalid={shares[entry.id] !== undefined && Boolean(issue)}
                      value={shares[entry.id] ?? ''}
                      onChange={(event) =>
                        setShares({
                          ...shares,
                          [entry.id]:
                            event.target.value === '' ? undefined : Number(event.target.value),
                        })
                      }
                    />
                    <span className="-translate-y-1/2 pointer-events-none absolute end-2.5 top-1/2 text-caption text-muted-foreground">
                      %
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {[25, 50]
                      .filter((p) => p < available)
                      .map((p) => (
                        <Button
                          key={p}
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setShares({ ...shares, [entry.id]: p })}
                        >
                          {`${p}%`}
                        </Button>
                      ))}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t('v3.vaults.attach.allFree')}
                      onClick={() => setShares({ ...shares, [entry.id]: available })}
                    >
                      {`${available}%`}
                    </Button>
                  </div>
                </div>
                <p className="text-caption" aria-live="polite">
                  {issue && shares[entry.id] !== undefined ? (
                    <span className="text-destructive">
                      {t(`v3.vaults.attach.issue.${issue}`, { percent: available })}
                    </span>
                  ) : shareValue(values.get(entry.id) ?? null, shares[entry.id]) !== null ? (
                    <span className="text-muted-foreground">
                      {t('v3.vaults.attach.brings')}{' '}
                      <Numeric
                        value={shareValue(values.get(entry.id) ?? null, shares[entry.id])}
                        currency={currency}
                      />
                    </span>
                  ) : null}
                </p>
              </div>
            );
          })}
        </div>
      ) : null}

      {step === 'review' ? (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-surface-1">
            {chosen.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-label">{entry.label}</span>
                  <span className="truncate text-caption text-muted-foreground">
                    {entry.sublabel}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end">
                  <Numeric
                    value={shareValue(values.get(entry.id) ?? null, shares[entry.id])}
                    currency={currency}
                    className="text-label"
                  />
                  <span className="font-mono text-caption text-muted-foreground tabular-nums">{`${shares[entry.id]}%`}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="flex items-baseline justify-between gap-3 px-3 text-label">
            <span>{t('v3.vaults.attach.total', { vault: vaultName })}</span>
            <Numeric value={total} currency={currency} />
          </p>
        </div>
      ) : null}
    </FormSheet>
  );
}
