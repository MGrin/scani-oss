import { PeekSheet } from '@scani/ui/v3/components/PeekSheet';
import { usePeekRoute } from '@scani/ui/v3/hooks/usePeekRoute';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { type HomePeekId, isHomePeekId } from '../../lib/home-card';
import { V3_ROUTES } from '../../lib/routes';
import { AllocationBlock } from './AllocationBlock';
import { DebtBlock } from './DebtBlock';
import { GroupsBlock } from './GroupsBlock';
import { IncomeBlock } from './IncomeBlock';
import { ReturnsBlock } from './ReturnsBlock';
import { UpcomingBlock } from './UpcomingBlock';
import { VaultsBlock } from './VaultsBlock';
import { WrapperGainsBlock } from './WrapperGainsBlock';

const TITLE_KEYS: Record<Exclude<HomePeekId, 'hero'>, string> = {
  allocation: 'v3.home.allocation.title',
  bills: 'v3.home.upcoming.title',
  holdings: 'v3.home.topHoldings.title',
  returns: 'v3.home.returns.title',
  income: 'v3.home.income.title',
  wrappers: 'v3.wrappers.block.title',
  groups: 'v3.home.groups.title',
  vaults: 'v3.home.vaults.title',
  debt: 'v3.allocation.debt',
};

/**
 * The full block behind a Home tile, opened at `/home/<id>` (SC-1669).
 *
 * Nothing left Home when the cards shrank to tiles: each tile is a link to the
 * block it replaced, whole, so the URL is shareable and Back closes it. The
 * hero and Top holdings read the page's own overview, so the page hands those
 * two in rather than this sheet asking for the overview a second time.
 */
export function HomePeek({
  hero,
  heroTitle,
  holdings,
  currency,
}: {
  /** Null where the page has no overview to build them from; the id is then the not-found sheet. */
  hero: ReactNode | null;
  /** The translated name of the chart the hero shows, so its peek is named for it (SC-1690). */
  heroTitle: string;
  holdings: ReactNode | null;
  currency: string;
}) {
  const { t } = useTranslation();
  const route = usePeekRoute(V3_ROUTES.homePeek);
  const id = isHomePeekId(route.id) ? route.id : null;
  const body: Record<HomePeekId, () => ReactNode> = {
    hero: () => hero,
    allocation: () => <AllocationBlock variant="peek" />,
    bills: () => <UpcomingBlock currency={currency} variant="peek" />,
    holdings: () => holdings,
    returns: () => <ReturnsBlock variant="peek" />,
    income: () => <IncomeBlock variant="peek" />,
    wrappers: () => <WrapperGainsBlock variant="peek" />,
    groups: () => <GroupsBlock variant="peek" />,
    vaults: () => <VaultsBlock variant="peek" />,
    debt: () => <DebtBlock variant="peek" />,
  };

  const content = id ? body[id]() : null;

  return (
    <PeekSheet
      open={route.id !== null}
      onOpenChange={(next) => {
        if (!next) route.close();
      }}
      noun={t('nav.home')}
      // An id that names no block is the not-found sheet rather than a 404 page.
      spec={
        content == null || id === null
          ? null
          : { title: id === 'hero' ? heroTitle : t(TITLE_KEYS[id]), primary: [], content }
      }
    />
  );
}
