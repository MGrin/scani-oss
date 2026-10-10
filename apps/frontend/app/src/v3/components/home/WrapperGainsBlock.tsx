import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useTranslation } from 'react-i18next';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { trpc } from '@/lib/trpc';
import type { ReturnsWindowRequest } from '../../lib/returns';
import {
  toWrapperGainsView,
  type WrapperGainsRow,
  type WrapperGainsView,
} from '../../lib/wrapper-gains';
import { HomeCard, type HomeCardVariant, RowsSkeleton } from './HomeCard';

/**
 * Gains over the returns window, grouped by the bucket of each account's
 * wrapper (SC-1645). A label and a grouping only: no tax is computed.
 */
export function WrapperGainsBlock({
  heroWindow = null,
  variant = 'card',
}: {
  heroWindow?: ReturnsWindowRequest | null;
  variant?: HomeCardVariant;
}) {
  const { t } = useTranslation();
  const { symbol } = useBaseCurrency();
  const query = trpc.portfolio.getGainsByWrapper.useQuery({
    window: heroWindow ?? { kind: '1y' },
  });
  const view = toWrapperGainsView(query.data);
  return (
    <HomeCard
      title={t('v3.wrappers.block.title')}
      subject={t('v3.wrappers.block.loadingLabel')}
      queries={[query]}
      absent={!view}
      variant={variant}
      peekId="wrappers"
      tile={() => ({
        figure: (
          <Numeric
            value={view?.wrappedGain ?? null}
            currency={symbol}
            compact
            delta
            indicator="sign"
          />
        ),
        caption: view?.withheld
          ? t('v3.home.returns.eligibility.rebuilding-history')
          : (view?.wrappedTreatments ?? [])
              .map((treatment) => t(`v3.wrappers.bucketShort.${treatment}`))
              .join(' · '),
      })}
      skeleton={<RowsSkeleton />}
    >
      {() => (view ? <WrapperGainsCard view={view} currency={symbol} /> : null)}
    </HomeCard>
  );
}

export function WrapperGainsCard({ view, currency }: { view: WrapperGainsView; currency: string }) {
  const { t } = useTranslation();
  if (view.withheld) {
    return (
      <div className="px-4 pb-3 text-caption text-muted-foreground">
        <p>{t('v3.home.returns.unavailable')}</p>
        <p>{t('v3.home.returns.eligibility.rebuilding-history')}</p>
      </div>
    );
  }
  return (
    <>
      <DataRowList className="border-t border-border">
        {view.rows.map((row) => (
          <BucketRow key={row.treatment} row={row} currency={currency} />
        ))}
      </DataRowList>
      <p className="px-4 pt-2 pb-2 text-caption text-muted-foreground">
        {t('v3.wrappers.block.tileSums')}
      </p>
      {view.general ? (
        <DataRowList className="border-t border-border">
          <BucketRow row={view.general} currency={currency} />
        </DataRowList>
      ) : null}
      {view.carriedHoldings > 0 ? (
        <p className="px-4 pb-2 text-caption text-muted-foreground">
          {t('v3.wrappers.block.carried', { count: view.carriedHoldings })}
        </p>
      ) : null}
      <p className="px-4 pb-3 text-caption text-muted-foreground">{t('v3.wrappers.block.note')}</p>
    </>
  );
}

function BucketRow({ row, currency }: { row: WrapperGainsRow; currency: string }) {
  const { t } = useTranslation();
  return (
    <DataRow
      label={t(`v3.wrappers.bucket.${row.treatment}`)}
      sublabel={
        // Each label stays with its figure, so a line never ends on a bare sign.
        <>
          <span className="whitespace-nowrap">
            {t('v3.wrappers.block.realized')}{' '}
            <Numeric value={row.realized} currency={currency} delta indicator="sign" />
          </span>
          {' · '}
          <span className="whitespace-nowrap">
            {t('v3.wrappers.block.unrealized')}{' '}
            <Numeric value={row.unrealized} currency={currency} delta indicator="sign" />
          </span>
        </>
      }
      wrapIdentity
      value={<Numeric value={row.total} currency={currency} delta indicator="sign" />}
    />
  );
}
