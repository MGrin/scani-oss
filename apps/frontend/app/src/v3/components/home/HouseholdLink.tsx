import { DashboardItem } from '@scani/ui/v3/components/PageLayout';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { V3_ROUTES } from '../../lib/routes';

/** The way into the household view (SC-1647), shown only to a household member. */
export function HouseholdLink() {
  const { t } = useTranslation();
  const mine = trpc.household.mine.useQuery(undefined, { staleTime: 60_000 });
  const household = mine.data?.household;
  if (!household) return null;
  return (
    <DashboardItem span="full">
      <Link
        to={V3_ROUTES.household}
        className="flex items-center gap-2 rounded-md border border-border px-4 py-3 text-body hover:bg-muted"
      >
        <Users className="size-4" aria-hidden />
        <span>{t('v3.household.view.link')}</span>
        <span className="text-caption text-muted-foreground">{household.name}</span>
      </Link>
    </DashboardItem>
  );
}
