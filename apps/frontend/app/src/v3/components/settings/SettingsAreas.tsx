import { cn } from '@scani/ui/lib/cn';
import { MIRROR_IN_RTL } from '@scani/ui/lib/direction';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useMediaQuery } from '@scani/ui/v3/hooks/useMediaQuery';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { V3_ROUTES } from '../../lib/routes';
import {
  type SettingsArea,
  type SettingsAreaValue,
  settingsAreaPath,
} from '../../lib/settings-areas';
import { BackLink } from '../BackLink';
import { useAgentsArea, useSettingsAreaValues } from './useSettingsAreaValues';

/**
 * Where the list fits beside an area. `xl` and not `lg`: beside the sidebar at
 * 1024 the area column was 408px, and a paired field in it 180px.
 */
const SPLIT_QUERY = '(min-width: 1280px)';

/**
 * Settings as a list of areas (SC-1670).
 *
 * On a phone `/settings` is the list and `/settings/<area>` is one area. From
 * `xl` the list stays beside the area, and bare `/settings` opens the first.
 * Only the half on screen is mounted, so a phone on the list does not mount a
 * form it cannot see, and a phone in an area does not run the list's reads.
 */
export function SettingsAreas({
  areas,
  areaId,
}: {
  areas: SettingsArea[];
  /** The `:area` segment of the address, whether or not it names an area. */
  areaId: string | undefined;
}) {
  const { t } = useTranslation();
  const split = useMediaQuery(SPLIT_QUERY);
  const area = areas.find((candidate) => candidate.id === areaId) ?? null;
  const shown = area ?? (split && areaId === undefined ? (areas[0] ?? null) : null);

  return (
    <PageLayout measure={split ? 'wide' : 'narrow'}>
      <div className={cn(split && 'grid grid-cols-[280px_minmax(0,1fr)] items-start gap-8')}>
        {(split || area === null) && (
          <AreaList
            areas={areas}
            currentId={shown?.id ?? null}
            // One `h1` a page: the list's title is it only while no area is open.
            isPageHeading={shown === null}
            notFound={areaId !== undefined && area === null}
          />
        )}
        {shown && (
          <section className="flex min-w-0 flex-col gap-6" aria-label={t(shown.titleKey)}>
            {!split && <BackLink to={V3_ROUTES.settings} label={t('settings.title')} />}
            <PageHeader title={t(shown.titleKey)} />
            {shown.sections()}
          </section>
        )}
      </div>
    </PageLayout>
  );
}

function AreaList({
  areas,
  currentId,
  isPageHeading,
  notFound,
}: {
  areas: SettingsArea[];
  currentId: string | null;
  isPageHeading: boolean;
  notFound: boolean;
}) {
  const { t } = useTranslation();
  const values = useSettingsAreaValues();
  const agents = useAgentsArea();
  const title = t('settings.title');

  return (
    <nav aria-label={title} className="flex flex-col gap-4">
      {isPageHeading ? (
        <PageHeader title={title} />
      ) : (
        <p className="flex min-h-[44px] items-center text-title">{title}</p>
      )}
      {notFound && (
        <p role="status" className="text-body text-muted-foreground">
          {t('v3.settings.areas.notFound')}
        </p>
      )}
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface-1">
        {areas.map((area) => {
          const row = (value: SettingsAreaValue) => (
            <li key={area.id}>
              <AreaRow area={area} current={area.id === currentId} value={value} />
            </li>
          );
          if (area.Row) return <area.Row key={area.id}>{row}</area.Row>;
          if (area.id === 'agents') return agents.listed ? row(agents.value) : null;
          return row(area.id in values ? values[area.id] : null);
        })}
      </ul>
    </nav>
  );
}

function AreaRow({
  area,
  current,
  value,
}: {
  area: SettingsArea;
  current: boolean;
  value: SettingsAreaValue;
}) {
  const { t } = useTranslation();
  const Icon = area.icon;
  return (
    <Link
      to={settingsAreaPath(area.id)}
      aria-current={current ? 'page' : undefined}
      className={cn(
        'flex min-h-14 items-center gap-3 px-4 py-3',
        'transition-colors duration-fast ease-emphasized hover:bg-surface-hover',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        current && 'bg-surface-hover'
      )}
    >
      <Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-label">{t(area.titleKey)}</span>
        {value === undefined ? (
          <Skeleton aria-hidden="true" className="mt-1 h-3 w-40" />
        ) : (
          value !== null && (
            <span className="truncate text-caption text-muted-foreground">{value}</span>
          )
        )}
      </span>
      <ChevronRight
        aria-hidden="true"
        className={cn(MIRROR_IN_RTL, 'size-4 shrink-0 text-muted-foreground')}
      />
    </Link>
  );
}
