import { formatDate } from '@scani/shared';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { useViewPreference } from '../../hooks/useViewPreference';
import {
  RETURNS_WINDOW_KEYS,
  RETURNS_WINDOWS,
  type ReturnsView,
  type ReturnsWindow,
  returnsView,
} from '../../lib/returns';
import { VIEW_PREFERENCE_KEYS } from '../../lib/view-preference';

/**
 * How the portfolio did, two ways (SC-1159) — see `lib/returns.ts` for why
 * both. Renders nothing until there is history to measure: a card of dashes
 * above a portfolio added today tells a newcomer nothing.
 */
export function ReturnsBlock() {
  const [windowKey, setWindowKey] = useViewPreference<ReturnsWindow>(
    VIEW_PREFERENCE_KEYS.homeReturnsWindow,
    'ytd',
    RETURNS_WINDOW_KEYS
  );
  const query = trpc.portfolio.getReturns.useQuery({ window: { kind: windowKey } });
  const view = returnsView(query.data?.returns);
  // Keep the card standing while another window loads, so the switch does not
  // collapse and re-grow the row it sits in.
  if (!view && !query.isFetching) return null;

  return <ReturnsCard view={view} windowKey={windowKey} onWindowChange={setWindowKey} />;
}

export function ReturnsCard({
  view,
  windowKey,
  onWindowChange,
}: {
  view: ReturnsView | null;
  windowKey: ReturnsWindow;
  onWindowChange: (key: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <Block>
      <BlockHeader title={t('v3.home.returns.title')} />
      <div className="px-4 pb-3">
        <Segmented
          value={windowKey}
          onValueChange={onWindowChange}
          aria-label={t('v3.home.returns.chooseWindow')}
        >
          {RETURNS_WINDOWS.map((option) => (
            <SegmentedItem key={option.key} value={option.key}>
              {t(option.labelKey)}
            </SegmentedItem>
          ))}
        </Segmented>
      </div>
      {view ? (
        <>
          <dl className="divide-y divide-border border-t border-border">
            <ReturnRow
              label={t('v3.home.returns.twr.label')}
              caption={t('v3.home.returns.twr.caption')}
              value={view.twr?.cumulative ?? null}
              note={
                view.twr?.annualized != null ? (
                  <Trans
                    i18nKey="v3.home.returns.perYear"
                    components={{
                      value: <Numeric value={view.twr.annualized} format="percent" decimals={1} />,
                    }}
                  />
                ) : null
              }
            />
            <ReturnRow
              label={t('v3.home.returns.xirr.label')}
              caption={
                view.xirr?.approximate
                  ? t('v3.home.returns.xirr.approximate')
                  : t('v3.home.returns.xirr.caption')
              }
              value={view.xirr?.rate ?? null}
              note={view.xirr ? t('v3.home.returns.perYearUnit') : null}
            />
          </dl>
          {view.since || view.partial ? (
            <p className="border-t border-border px-4 py-3 text-caption text-muted-foreground">
              {view.since ? t('v3.home.returns.since', { date: formatDate(view.since) }) : null}
              {view.since && view.partial ? ' ' : null}
              {view.partial ? t('v3.home.returns.partial') : null}
            </p>
          ) : null}
        </>
      ) : null}
    </Block>
  );
}

function ReturnRow({
  label,
  caption,
  value,
  note,
}: {
  label: string;
  caption: string;
  value: number | null;
  note: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <dt className="min-w-0">
        <span className="block text-label">{label}</span>
        <span className="block text-caption text-muted-foreground">{caption}</span>
      </dt>
      <dd className="shrink-0 text-end">
        {value === null ? (
          <span className="text-label text-muted-foreground">—</span>
        ) : (
          <Numeric value={value} format="percent" decimals={1} delta className="text-label" />
        )}
        {note ? <span className="block text-caption text-muted-foreground">{note}</span> : null}
      </dd>
    </div>
  );
}
