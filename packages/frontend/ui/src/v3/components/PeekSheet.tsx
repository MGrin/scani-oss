import type { ReactNode } from 'react';
import { useUiTranslation } from '../../i18n';
import {
  BottomDrawer,
  BottomDrawerBody,
  BottomDrawerContent,
  BottomDrawerHeader,
} from '../../ui/bottom-drawer';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../../ui/sheet';
import { Skeleton } from '../../ui/skeleton';
import { useDelayedLoading } from '../hooks/useDelayedLoading';
import { useIsDesktop } from '../hooks/useMediaQuery';
import type { PeekFact, PeekSpec } from '../lib/peek';
import { LoadingRamp } from './feedback/LoadingRamp';

/**
 * The peek sheet — where the twelve data points that left the row went.
 *
 * §2.2 of the research brief: a phone row is three zones, and everything else
 * about a record is one tap away instead of one horizontal scroll away. The
 * sheet rests at half the viewport showing the record's identity, its figure,
 * its primary actions and the four or five facts that answer "what is this";
 * dragging the handle up reveals the titled sections underneath. That rest
 * height is the ticket: a sheet that opens full-height is a page, and a page
 * loses the list it was opened from.
 *
 * The rest height is enforced structurally rather than by hoping the content
 * is short. Identity, figure and actions live in the drawer's fixed header, so
 * they are on screen at any snap point; `primary` and `sections` share the
 * scrolling body, so nothing is ever unreachable — the fold is where the eye
 * stops, never where the content does.
 *
 * Two shells, one content. Below `lg` it is `BottomDrawer`, which owns the snap
 * points and the drag. Above it, a right-side `Sheet`: a half-height drawer on
 * a 1440px screen is a gesture idiom borrowed onto a pointer, and the table
 * behind it already shows the columns the phone had to hide. Both are Radix
 * dialogs, which is why one `SheetTitle` serves both — it is
 * `Dialog.Title` either way, and the peek needs exactly one implementation of
 * its header.
 *
 * Portalling is handled by `V3TokenScope`'s `PortalContainerProvider` (V3-22);
 * without it the sheet mounts on `<body>`, outside `data-ui="v3"`, and renders
 * a coherent-looking overlay in v2's design system.
 */

/** ~50% — the ticket's rest height, and the one the fixed header is sized
 *  against. The second point is the drag-up destination. */
const PEEK_SNAP_POINTS = [0.5, 1] as const;

function Facts({ facts }: { facts: PeekFact[] }) {
  return (
    <dl className="divide-y divide-border">
      {facts.map((fact) => (
        <div key={fact.label} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="shrink-0 text-caption text-muted-foreground">{fact.label}</dt>
          {/* `break-words`, not `truncate`: a wallet address or a long account
              name is the reason the user opened the sheet, and a detail view
              that hides the detail has no job. */}
          <dd className="min-w-0 break-words text-right text-body">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Identity, figure and actions. Exported because it is the half of the sheet
 * that is above the fold at every snap point, which is a claim a test can
 * check and a portal makes unreachable — Radix renders nothing at all under
 * `renderToStaticMarkup`.
 *
 * It draws no close button of its own. Both shells already own one — the
 * desktop `Sheet` has always drawn its own, and `BottomDrawer` gained one
 * beside the grab handle in the SC-39 safe-area fix — so the header's own
 * `dismissable` close became a *second* × on every phone peek (SC-53). The
 * shell's is the one to keep: it is first in the DOM for Tab and VoiceOver,
 * it is what a dismissing drag clicks, and it is present at every snap point
 * whether or not the record has a header to put it in.
 */
export function PeekHeader({ spec }: { spec: PeekSpec }) {
  const { t } = useUiTranslation();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        {spec.leading ? (
          <span className="flex shrink-0 items-center pt-0.5">{spec.leading}</span>
        ) : null}
        <div className="min-w-0 flex-1">
          <SheetTitle className="truncate text-title">{spec.title}</SheetTitle>
          {spec.subtitle ? (
            <SheetDescription className="truncate text-caption">{spec.subtitle}</SheetDescription>
          ) : (
            // Radix warns without a description, and a sheet that describes
            // itself twice is worse than one that describes itself once.
            <SheetDescription className="sr-only">{t('ui.peek.recordDetail')}</SheetDescription>
          )}
        </div>
      </div>

      {spec.value ? (
        <p
          // The line for the SC-72 fit rule is this paragraph rather than the
          // span below it: the span is a shrink-to-fit flex item, so its width
          // comes from the figure and cannot be the budget for it. The delta
          // shares the line and wraps under it when they no longer both fit.
          data-figure-line="true"
          className="flex flex-wrap items-baseline gap-x-3 gap-y-1"
        >
          {/* `text-display` is Plex Mono at 44px — the record's figure is to
              this sheet what net worth is to the home screen, and the sheet is
              a screen. */}
          <span className="text-display">{spec.value}</span>
          {spec.delta ? <span className="text-body">{spec.delta}</span> : null}
        </p>
      ) : null}

      {spec.trend ? <div>{spec.trend}</div> : null}

      {spec.actions ? <div className="flex flex-wrap gap-2">{spec.actions}</div> : null}
    </div>
  );
}

/** The facts, primary first. Exported for the same reason as `PeekHeader`. */
export function PeekBody({ spec }: { spec: PeekSpec }) {
  return (
    <div className="flex flex-col gap-4">
      {spec.primary.length > 0 ? <Facts facts={spec.primary} /> : null}
      {spec.content}
      {spec.sections?.map((section) => (
        <section key={section.title} className="flex flex-col gap-1">
          <h3 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
            {section.title}
          </h3>
          <Facts facts={section.facts} />
        </section>
      ))}
    </div>
  );
}

/**
 * What the sheet says when the URL names a record the surface does not have.
 *
 * A linkable sheet gets opened by links that have gone stale, so this is a
 * state the pattern owns rather than an edge case each surface rediscovers.
 * Silently sending the URL back to the list would be the same event, to the
 * person who followed the link, as "the link did nothing".
 */
function MissingBody({ noun }: { noun: string }) {
  const { t } = useUiTranslation();
  return <p className="text-body text-muted-foreground">{t('ui.peek.notOnList', { noun })}</p>;
}

/** The fact rows the sheet is about to show, at their real height. Drawn only
 *  from the `skeleton` band of the ramp — a peek opened over a list the user
 *  is already looking at almost always has its record in cache. */
function LoadingFacts() {
  return (
    <div className="flex flex-col gap-3">
      {['a', 'b', 'c', 'd'].map((key) => (
        <div key={key} className="flex items-center justify-between gap-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

interface PeekSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null while the record is loading, or when the URL names one that is gone. */
  spec: PeekSpec | null;
  /** Singular, lowercase — "holding". Only reaches the not-found copy. */
  noun: string;
  isLoading?: boolean;
}

export function PeekSheet({ open, onOpenChange, spec, noun, isLoading }: PeekSheetProps) {
  const { t } = useUiTranslation();
  const isDesktop = useIsDesktop();
  const loadingPhase = useDelayedLoading(Boolean(isLoading));

  const resolved: PeekSpec = spec ?? {
    title: isLoading ? t('ui.peek.loading') : t('ui.peek.notFound'),
    primary: [],
  };

  let body: ReactNode;
  if (spec) body = <PeekBody spec={spec} />;
  else if (isLoading)
    body = <LoadingRamp phase={loadingPhase} skeleton={<LoadingFacts />} label={noun} />;
  else body = <MissingBody noun={noun} />;

  if (isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 sm:max-w-md"
          // Same reasoning as `RefineSheet`: `SheetContent` sets
          // `backgroundColor` inline against an unset `--background`, and an
          // inline style beats any utility. `--surface-2` is the sheet rung of
          // the ramp (§5.1).
          style={{ backgroundColor: 'hsl(var(--surface-2))' }}
        >
          {/* `pr-12` clears the shell's own close button. */}
          <div className="shrink-0 border-b border-border px-4 pb-4 pr-12 pt-4">
            <PeekHeader spec={resolved} />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{body}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <BottomDrawer open={open} onOpenChange={onOpenChange}>
      <BottomDrawerContent
        snapPoints={PEEK_SNAP_POINTS}
        expandLabel={t('ui.peek.expand')}
        collapseLabel={t('ui.peek.collapse')}
        style={{ backgroundColor: 'hsl(var(--surface-2))' }}
      >
        <BottomDrawerHeader className="border-b border-border pb-4">
          <PeekHeader spec={resolved} />
        </BottomDrawerHeader>
        <BottomDrawerBody className="py-3">
          {body}
          {/* The home indicator sits over the last fact otherwise. */}
          <div style={{ height: 'env(safe-area-inset-bottom, 0px)' }} />
        </BottomDrawerBody>
      </BottomDrawerContent>
    </BottomDrawer>
  );
}
