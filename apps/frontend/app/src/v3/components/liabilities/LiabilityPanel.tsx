import type { LiabilityProjectionDto } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Block } from '@scani/ui/v3/components/Block';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { trpc } from '@/lib/trpc';
import { LiabilityTermsForm } from './LiabilityTermsForm';

/**
 * SC-1640. Above a liability account's holdings: what is owed and, from the
 * loan or card terms, when it is paid off. The schedule says what was
 * promised and the amount owed says what happened, so the payoff is walked
 * from what is owed today.
 */
export function LiabilityPanel({ accountId }: { accountId: string }) {
  const [editing, setEditing] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const { symbol: baseCurrency } = useBaseCurrency();
  const projection = trpc.liabilities.getProjection.useQuery({ accountId });
  const terms = trpc.liabilities.getTerms.useQuery({ accountId }, { enabled: editing });
  // An asset account answers null: nothing to show, and no panel.
  if (!projection.data) return null;
  const data = projection.data;

  return (
    <>
      <LiabilityPanelView
        kind={data.kind}
        hasTerms={data.hasTerms}
        data={data}
        fallbackCurrency={baseCurrency}
        onEditTerms={() => setEditing(true)}
        termsError={editing && terms.isError ? terms.error : null}
        onRetryTerms={() => void terms.refetch()}
        scheduleOpen={scheduleOpen}
        onToggleSchedule={() => setScheduleOpen((open) => !open)}
      />
      {/* Mounted only while open, so the form seeds from the saved terms each time. */}
      {editing && terms.isSuccess ? (
        <LiabilityTermsForm
          open
          accountId={accountId}
          kind={data.kind}
          initial={terms.data ?? null}
          onDone={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

export function LiabilityPanelView({
  kind,
  hasTerms,
  data,
  fallbackCurrency = 'USD',
  onEditTerms,
  termsError = null,
  onRetryTerms = () => {},
  scheduleOpen = false,
  onToggleSchedule = () => {},
}: {
  kind: LiabilityProjectionDto['kind'];
  hasTerms: boolean;
  data: LiabilityProjectionDto;
  /** The reader's base currency, for an account with no holding to name one. */
  fallbackCurrency?: string;
  onEditTerms: () => void;
  /** A failed terms read (SC-1672): shown, never a button that does nothing. */
  termsError?: unknown;
  onRetryTerms?: () => void;
  scheduleOpen?: boolean;
  onToggleSchedule?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const currency = data.currency ?? fallbackCurrency;
  const owed = Number(data.owed);
  const addLabel =
    kind === 'credit_card'
      ? t('v3.liabilities.addCard')
      : kind === 'loan'
        ? t('v3.liabilities.addLoan')
        : t('v3.liabilities.addOther');

  return (
    <Block className="p-4">
      <div data-ui="liability-panel" className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-label">{t('v3.liabilities.owed')}</span>
          <Numeric value={owed} currency={currency} className="text-heading" />
        </div>

        {data.projection ? (
          <LoanFigures
            projection={data.projection}
            payment={data.schedule?.[0]?.payment ?? null}
            currency={currency}
            locale={i18n.language}
          />
        ) : null}

        {data.card ? <CardFigures card={data.card} currency={currency} /> : null}

        {data.schedule && data.schedule.length > 0 ? (
          <ScheduleTable
            rows={data.schedule}
            open={scheduleOpen}
            onToggle={onToggleSchedule}
            currency={currency}
            locale={i18n.language}
          />
        ) : null}

        <div>
          <Button variant="outline" size="sm" onClick={onEditTerms}>
            {hasTerms ? t('v3.liabilities.editTerms') : addLabel}
          </Button>
        </div>

        {termsError ? (
          <QueryError
            error={termsError}
            subject={t('v3.liabilities.termsSubject')}
            onRetry={onRetryTerms}
          />
        ) : null}
      </div>
    </Block>
  );
}

function LoanFigures({
  projection,
  payment,
  currency,
  locale,
}: {
  projection: NonNullable<LiabilityProjectionDto['projection']>;
  payment: string | null;
  currency: string;
  locale: string;
}) {
  const { t } = useTranslation();
  if (!projection.converged) {
    return <p className="text-caption text-destructive">{t('v3.liabilities.notConverging')}</p>;
  }
  if (projection.status === 'paid_off') {
    return <p className="text-label">{t('v3.liabilities.paidOff')}</p>;
  }
  const date = projection.payoffDate
    ? new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${projection.payoffDate}T00:00:00Z`)
      )
    : null;
  const months = Math.abs(projection.monthsVsSchedule);
  const status =
    projection.status === 'ahead'
      ? t('v3.liabilities.ahead', { count: months })
      : projection.status === 'behind'
        ? t('v3.liabilities.behind', { count: months })
        : t('v3.liabilities.onTrack');

  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2">
      {date ? (
        <>
          <dt className="text-label">{t('v3.liabilities.paidOffBy', { date })}</dt>
          <dd className="text-caption text-muted-foreground">{status}</dd>
        </>
      ) : null}
      <dt className="text-label">{t('v3.liabilities.interestLeft')}</dt>
      <dd>
        <Numeric value={Number(projection.remainingInterest)} currency={currency} />
      </dd>
      {payment ? (
        <>
          <dt className="text-label">{t('v3.liabilities.payment')}</dt>
          <dd>
            <Numeric value={Number(payment)} currency={currency} />
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function CardFigures({
  card,
  currency,
}: {
  card: NonNullable<LiabilityProjectionDto['card']>;
  currency: string;
}) {
  const { t } = useTranslation();
  if (card.utilization === null) return null;
  const percent = Number(card.utilization) * 100;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-label">{t('v3.liabilities.used')}</span>
        <Numeric value={percent} format="percent" decimals={0} />
      </div>
      <div
        role="progressbar"
        aria-label={t('v3.liabilities.used')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full bg-foreground"
          style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
        />
      </div>
      {card.available !== null ? (
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-label">{t('v3.liabilities.available')}</span>
          <Numeric value={Number(card.available)} currency={currency} />
        </div>
      ) : null}
    </div>
  );
}

function ScheduleTable({
  rows,
  open,
  onToggle,
  currency,
  locale,
}: {
  rows: NonNullable<LiabilityProjectionDto['schedule']>;
  open: boolean;
  onToggle: () => void;
  currency: string;
  locale: string;
}) {
  const { t } = useTranslation();
  const month = new Intl.DateTimeFormat(locale, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button variant="ghost" size="sm" onClick={onToggle} aria-expanded={open}>
          {open ? t('v3.liabilities.hideSchedule') : t('v3.liabilities.showSchedule')}
        </Button>
      </div>
      {open ? (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-caption">
            <thead className="sticky top-0 bg-surface-1 text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 text-start font-normal">
                  {t('v3.liabilities.scheduleDate')}
                </th>
                <th scope="col" className="py-1 text-end font-normal">
                  {t('v3.liabilities.schedulePayment')}
                </th>
                <th scope="col" className="py-1 text-end font-normal">
                  {t('v3.liabilities.scheduleInterest')}
                </th>
                <th scope="col" className="py-1 text-end font-normal">
                  {t('v3.liabilities.schedulePrincipal')}
                </th>
                <th scope="col" className="py-1 text-end font-normal">
                  {t('v3.liabilities.scheduleRemaining')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.n} className="border-t border-border">
                  <td className="py-1">{month.format(new Date(`${r.date}T00:00:00Z`))}</td>
                  <td className="py-1 text-end">
                    <Numeric value={Number(r.payment)} currency={currency} />
                  </td>
                  <td className="py-1 text-end">
                    <Numeric value={Number(r.interest)} currency={currency} />
                  </td>
                  <td className="py-1 text-end">
                    <Numeric value={Number(r.principal)} currency={currency} />
                  </td>
                  <td className="py-1 text-end">
                    <Numeric value={Number(r.remaining)} currency={currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
