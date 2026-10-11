import { Numeric } from '@scani/ui/v3/components/Numeric';
import { toFiniteNumber } from '@scani/ui/v3/lib/numeric';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { useViewPreference } from '../../hooks/useViewPreference';
import { ALLOCATION_DIMENSION_KEYS, DEFAULT_ALLOCATION_DIMENSION } from '../../lib/home';
import { VIEW_PREFERENCE_KEYS } from '../../lib/view-preference';
import { DebtLine } from '../charts/DebtLine';
import { HomeCard, type HomeCardVariant, RowsSkeleton } from './HomeCard';

/**
 * What is owed, as its own tile once there is any (SC-1640, SC-1669).
 *
 * It reads the allocation query under the cut the Allocation card holds, so
 * the two share one request: the debt totals do not depend on the cut, and a
 * second key would ask the same whole-portfolio question twice.
 */
export function DebtBlock({ variant = 'card' }: { variant?: HomeCardVariant }) {
  const { t } = useTranslation();
  const [dimension] = useViewPreference(
    VIEW_PREFERENCE_KEYS.homeAllocationDimension,
    DEFAULT_ALLOCATION_DIMENSION,
    ALLOCATION_DIMENSION_KEYS
  );
  const allocation = trpc.dashboard.getAssetAllocation.useQuery({ dimension });
  const currency = allocation.data?.baseCurrency ?? 'USD';
  const debt = toFiniteNumber(allocation.data?.totalDebt) ?? 0;
  const liabilities = toFiniteNumber(allocation.data?.liabilityDebt) ?? 0;
  const margin = debt - liabilities;
  const kinds = [
    margin < 0 ? t('v3.allocation.debtMargin') : null,
    liabilities < 0 ? t('v3.allocation.debtLiabilities') : null,
  ].filter((kind): kind is string => kind !== null);

  return (
    <HomeCard
      title={t('v3.allocation.debt')}
      subject={t('v3.home.debt.loadingLabel')}
      // Shown once its answer shows debt, and never as a skeleton or an error:
      // most people owe nothing, and the Allocation tile already reports this
      // same query's failure.
      queries={allocation.data ? [allocation] : []}
      absent={!(debt < 0)}
      skeleton={<RowsSkeleton />}
      variant={variant}
      peekId="debt"
      tile={() => ({
        figure: <Numeric value={debt} currency={currency} compact />,
        caption: kinds.join(' · '),
      })}
    >
      {() => (
        <div className="px-4 pb-4">
          <DebtLine
            value={debt}
            liabilities={liabilities}
            currency={currency}
            underLegend={false}
          />
        </div>
      )}
    </HomeCard>
  );
}
