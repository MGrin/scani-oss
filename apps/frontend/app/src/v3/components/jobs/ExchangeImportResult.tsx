import { Button } from '@scani/ui/ui/button';
import { Block } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { readExchangeImport } from '../../lib/job-results';
import { V3_ROUTES } from '../../lib/routes';
import { JobIssueList } from './JobIssueList';

/**
 * What connecting an exchange or brokerage brought back — one renderer for all
 * thirteen integrations.
 *
 * Two figures and a way in. v2 renders the same two and offers the way in only
 * when something was imported, so an account that connected and reported no
 * balances — the branch its own copy names as normal — leaves the reader on a
 * screen with two zeroes and nowhere to go.
 */
export function ExchangeImportResult({ result }: { result: unknown }) {
  const { t } = useTranslation();
  const view = readExchangeImport(result);
  const allFailed = view.holdingsImported === 0 && view.errors.length > 0;
  const holdingsHref = view.institutionId
    ? `${V3_ROUTES.holdings}?institution=${encodeURIComponent(view.institutionId)}`
    : V3_ROUTES.holdings;

  return (
    <div className="flex flex-col gap-4">
      <Block className="flex flex-col">
        <div className="flex items-center gap-2 px-4 pt-4">
          {/* Colour only where the run established nothing. v3 spends it on
              interactive affordance and gain/loss, so a partial import is
              carried by the icon's shape and by the figures under it. */}
          {view.errors.length > 0 ? (
            <AlertTriangle
              className={`size-4 shrink-0 ${allFailed ? 'text-destructive' : 'text-muted-foreground'}`}
              aria-hidden="true"
            />
          ) : (
            <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <h2 className="text-title">{t('v3.jobs.exchange.title')}</h2>
        </div>
        <DataRowList className="mt-3 border-t border-border">
          <DataRow
            label={t('v3.jobs.exchange.accountsCreated')}
            value={<Numeric value={view.accountsCreated} format="plain" decimals={0} />}
          />
          <DataRow
            label={t('v3.jobs.exchange.holdingsImported')}
            value={<Numeric value={view.holdingsImported} format="plain" decimals={0} />}
          />
        </DataRowList>
        {view.connectedButEmpty ? (
          <p className="border-t border-border p-4 text-body text-muted-foreground">
            {t('v3.jobs.exchange.connectedButEmpty')}
          </p>
        ) : null}
        <div className="border-t border-border p-4">
          <Button asChild variant="outline">
            <Link to={holdingsHref}>{t('v3.jobs.review.viewHoldings')}</Link>
          </Button>
        </div>
      </Block>

      <JobIssueList
        title={t('v3.jobs.exchange.failedTitle', { count: view.errors.length })}
        lines={view.errors}
        note={t('v3.jobs.exchange.failedNote')}
        cap={10}
      />
    </div>
  );
}
