import { formatDateTime } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import { peekOpenState, peekPath } from '@scani/ui/v3/lib/peek';
import { createContext, type ReactNode, useContext } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import {
  type HomeCardQuery,
  type HomeCardState,
  type HomePeekId,
  resolveHomeCardState,
} from '../../lib/home-card';
import { V3_ROUTES } from '../../lib/routes';
import { FigureVisibilityContext, MaskedFigure } from './FigureVisibility';

export type HomeCardVariant = 'card' | 'tile' | 'peek';

interface HomeCardProps {
  title: string;
  /** Lowercase, "your vaults" — the loading label and the error copy's subject. */
  subject: string;
  queries: readonly HomeCardQuery[];
  /** Shaped like the loaded body, so the card does not change height. */
  skeleton: ReactNode;
  /** Called only once every query has answered. */
  children: () => ReactNode;
  href?: string;
  action?: string;
  /** The feature is not in use (no vaults, no income). Honoured only after
   *  every query has answered, never while loading or failed. */
  absent?: boolean;
  /** A cut or window picker. Stays up in every state, so a person can change
   *  it and retry. */
  controls?: ReactNode;
  /** `card` on Home today; `tile` is the card shrunk to one figure, opening
   *  `peek`, which is the card's body with no chrome inside a sheet. */
  variant?: HomeCardVariant;
  /** Required for `tile`: the peek the tile opens. */
  peekId?: HomePeekId;
  /** Required for `tile`: its one figure and the line under it. */
  tile?: () => { figure: ReactNode; caption?: ReactNode };
}

/**
 * True while the page's own `StaleNotice` is up. That banner already says the
 * figures are old and offers a retry, so a card does not repeat it.
 */
export const HomePageStaleContext = createContext(false);

/** A component rather than a bare call, so a hook in a block's body belongs to
 *  this subtree and not to `HomeCard`, which renders it in one state only. */
function Body({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

/**
 * The one way a Home card shows loading, failure, absence and age (SC-1668).
 *
 * Before it, each block drew its own: four loading styles, five error styles,
 * and six of nine cards with no visible error at all — Allocation went blank,
 * Upcoming said "Nothing due", and four blocks returned `null`, which is also
 * what they returned for "you have none". The states and their order are
 * `resolveHomeCardState`'s; this component only draws them.
 */
export function HomeCard({
  title,
  subject,
  queries,
  skeleton,
  children,
  href,
  action,
  absent = false,
  controls,
  variant = 'card',
  peekId,
  tile,
}: HomeCardProps) {
  const { t } = useTranslation();
  const pageStale = useContext(HomePageStaleContext);
  const state = resolveHomeCardState(queries, absent);
  const phase = useDelayedLoading(state.kind === 'loading');
  if (state.kind === 'absent') {
    // A peek is reached by URL too, so it can outlive what it showed: a shared
    // `/home/debt` after the debt is paid. A titled sheet with nothing under it
    // reads as broken.
    return variant === 'peek' ? (
      <p className="px-4 pb-4 text-body text-muted-foreground">{t('v3.home.card.peekEmpty')}</p>
    ) : null;
  }

  if (variant === 'tile' && peekId && tile) {
    return (
      <HomeTile
        title={title}
        peekId={peekId}
        state={state}
        tile={tile}
        showSkeleton={phase !== 'idle'}
      />
    );
  }

  const body = (
    <>
      {controls ? <div className="px-4 pb-3">{controls}</div> : null}
      {state.kind === 'loading' ? (
        <div className="px-4 pb-4">
          <LoadingRamp phase={phase} skeleton={skeleton} label={subject} onRetry={state.retry} />
        </div>
      ) : state.kind === 'error' ? (
        <div className="px-4 pb-4">
          <QueryError
            error={state.error}
            subject={subject}
            onRetry={state.retry}
            variant="inline"
          />
        </div>
      ) : (
        <>
          <Body render={children} />
          {state.staleSince === null || pageStale ? null : (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2">
              <p className="text-caption text-muted-foreground">
                {t('v3.home.card.asOf', { time: formatDateTime(state.staleSince) })}
              </p>
              <Button variant="ghost" size="sm" onClick={state.retry} disabled={state.refreshing}>
                {t('v3.feedback.stale.retry')}
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );

  if (variant === 'peek') return body;
  return (
    <Block>
      <BlockHeader title={title} href={href} action={action} />
      {body}
    </Block>
  );
}

/**
 * A card shrunk to its title, one figure and one line (SC-1669). The whole
 * tile is the link to the peek, so it holds no control of its own, and a
 * failed tile stays a link: the peek is where the error and its retry live.
 */
function HomeTile({
  title,
  peekId,
  state,
  tile,
  showSkeleton,
}: {
  title: string;
  peekId: HomePeekId;
  /** The ramp's own first 300 ms draw nothing, as everywhere else. */
  showSkeleton: boolean;
  state: Exclude<HomeCardState, { kind: 'absent' }>;
  tile: NonNullable<HomeCardProps['tile']>;
}) {
  const { t } = useTranslation();
  const hidden = useContext(FigureVisibilityContext)?.hidden ?? false;
  const pageStale = useContext(HomePageStaleContext);
  return (
    <Link
      to={peekPath(V3_ROUTES.homePeek, peekId)}
      state={peekOpenState(V3_ROUTES.homePeek)}
      className={cn(
        'block h-full rounded-lg',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
    >
      <Block className="flex h-full min-h-24 flex-col gap-1 p-3 transition-colors duration-fast ease-emphasized hover:bg-surface-hover">
        <span className="text-label text-muted-foreground">{title}</span>
        {state.kind === 'loading' ? (
          showSkeleton ? (
            <>
              <Skeleton aria-hidden="true" className="h-6 w-24" />
              <Skeleton aria-hidden="true" className="h-3 w-28" />
            </>
          ) : null
        ) : state.kind === 'error' ? (
          <span className="text-caption text-loss">{t('v3.home.card.tileFailed')}</span>
        ) : (
          <TileFigure
            render={tile}
            hidden={hidden}
            asOf={
              state.staleSince === null || pageStale
                ? null
                : t('v3.home.card.asOf', { time: formatDateTime(state.staleSince) })
            }
          />
        )}
      </Block>
    </Link>
  );
}

function TileFigure({
  render,
  hidden,
  asOf,
}: {
  render: NonNullable<HomeCardProps['tile']>;
  hidden: boolean;
  asOf: string | null;
}) {
  const { figure, caption } = render();
  return (
    <>
      <div className="text-title tabular-nums">
        <MaskedFigure hidden={hidden}>{figure}</MaskedFigure>
      </div>
      {asOf !== null || caption ? (
        <span className="truncate text-caption text-muted-foreground">
          {/* Whole, because captions mix money with counts and names. */}
          {asOf ?? <MaskedFigure hidden={hidden}>{caption}</MaskedFigure>}
        </span>
      ) : null}
    </>
  );
}

/** The skeleton for a card whose body is a short list of rows. */
export function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}
