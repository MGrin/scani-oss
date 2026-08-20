import { quantityDecimals } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { readManualHoldings } from '../../lib/job-results';
import { V3_CAPTURE_ROUTES, V3_ROUTES } from '../../lib/routes';

/**
 * What a hand-typed batch of holdings became — also where the review card's
 * confirm lands, since it hands off to this job.
 *
 * The correction: **a row with no price has no value.** v2 multiplies balance
 * by a price it may not have and renders the product, so a holding whose price
 * did not resolve shows `$0.00` — a claim about somebody's money made out of
 * the absence of a figure. `UNPRICEABLE_PLACEHOLDER` is the answer the rest of
 * the app has given since the silent-zero cleanup, and `<Numeric>` renders it
 * for a null on its own.
 *
 * The type badge is also gone. v2 prints `typeCode` raw — `public-stock`,
 * `fiat` — in a coloured pill drawn from Tailwind's palette rather than the
 * token layer, which is a machine value dressed as a label and a colour that
 * means nothing. The row already says what the thing is.
 */
export function ManualHoldingsCreateResult({ result }: { result: unknown }) {
  const { t } = useTranslation();
  const { symbol: currency } = useBaseCurrency();
  const view = readManualHoldings(result);

  if (!view) {
    return (
      <Block className="p-4">
        <p className="text-body text-muted-foreground">{t('v3.jobs.manual.unreadablePayload')}</p>
      </Block>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Block className="flex flex-col">
        <BlockHeader title={t('v3.jobs.manual.title')} />
        <DataRowList className="border-t border-border">
          <DataRow
            label={t('v3.jobs.manual.saved')}
            value={<Numeric value={view.rows.length} format="plain" decimals={0} />}
          />
          <DataRow
            label={t('v3.jobs.manual.priced')}
            value={<Numeric value={view.pricedCount} format="plain" decimals={0} />}
          />
        </DataRowList>

        <DataRowList className="border-t border-border">
          {view.rows.map((row) => (
            <DataRow
              key={row.id}
              href={`${V3_ROUTES.holdings}?account=${encodeURIComponent(view.accountId)}`}
              label={
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="font-medium">{row.symbol}</span>
                  {row.name && row.name !== row.symbol ? (
                    <span className="min-w-0 truncate text-muted-foreground">{row.name}</span>
                  ) : null}
                  <Badge variant="outline">
                    {row.isUpdate ? t('v3.jobs.manual.row.updated') : t('v3.jobs.manual.row.new')}
                  </Badge>
                </span>
              }
              sublabel={
                <span className="flex items-center gap-1">
                  <Numeric
                    value={row.balance}
                    format="plain"
                    decimals={quantityDecimals(row.balance)}
                  />
                  <span>{row.symbol}</span>
                </span>
              }
              // `null` renders the em dash, not a zero. A holding whose price
              // did not resolve is not a holding worth nothing.
              value={<Numeric value={row.value} currency={currency} />}
              delta={
                row.pricingFailed ? (
                  <span className="text-muted-foreground">{t('v3.jobs.manual.row.noPrice')}</span>
                ) : row.priceSource ? (
                  <span className="text-muted-foreground">{row.priceSource}</span>
                ) : undefined
              }
            />
          ))}
        </DataRowList>

        {view.unpricedCount > 0 ? (
          <p className="border-t border-border p-4 text-body text-muted-foreground">
            {t('v3.jobs.manual.unpricedNote', { count: view.unpricedCount })}
          </p>
        ) : null}
      </Block>

      <div className="flex flex-col gap-2 lg:flex-row">
        <Button asChild className="lg:flex-none">
          <Link to={`${V3_ROUTES.holdings}?account=${encodeURIComponent(view.accountId)}`}>
            {t('v3.jobs.review.viewHoldings')}
          </Link>
        </Button>
        <Button asChild variant="outline" className="lg:flex-none">
          <Link to={V3_CAPTURE_ROUTES.manualEntry}>{t('v3.jobs.manual.addMore')}</Link>
        </Button>
      </div>
    </div>
  );
}
