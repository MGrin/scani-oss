import { type ReactNode, useLayoutEffect, useState } from 'react';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useUiTranslation } from '../../i18n';
import {
  BottomDrawer,
  BottomDrawerBody,
  BottomDrawerContent,
  BottomDrawerHeader,
  DRAWER_SAFE_BOTTOM,
} from '../../ui/bottom-drawer';
import { ScrollBody } from '../../ui/scroll-body';
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

/**
 * Below `lg` the actions are a two-column grid of equal buttons (SC-1405): a
 * wrapping row sized each by its label and left the last one alone on a line.
 * An odd last NORMAL action takes the whole row rather than leaving a gap, an
 * open confirm takes the whole row, and each destructive action gets a
 * full-width row of its own after all of them (SC-1415) — so the pairing of
 * the normal actions is counted without the destructive ones (`of` selector).
 * Desktop keeps the wrapping row.
 */
// Written out in full: Tailwind finds classes by scanning this text, so an
// interpolated selector would never be generated.
const PEEK_ACTIONS = [
  'grid grid-cols-2 gap-2 [&>a]:w-full [&>button]:w-full',
  '[&>:not([data-destructive]):nth-last-child(1_of_:not([data-destructive])):nth-child(odd_of_:not([data-destructive]))]:col-span-2',
  '[&>div]:col-span-2 [&>[data-confirm-open]]:col-span-2',
  '[&>[data-destructive]]:col-span-2 [&>[data-destructive]]:order-last',
  'lg:flex lg:flex-wrap lg:[&>a]:w-auto lg:[&>button]:w-auto lg:[&>[data-destructive]]:order-none',
].join(' ');

/** ~50% — the ticket's rest height, and the one the fixed header is sized
 *  against. The second point is the drag-up destination. */
const PEEK_REST = 0.5;
/** Never taller than a form sheet rests: past this the peek is a page. */
const PEEK_REST_CEILING = 0.92;
/** The first line of the body below the header, so the rest height always
 *  shows that there is more to drag up to. */
const PEEK_BODY_GLIMPSE_PX = 56;

/**
 * The rest height, raised when the fixed header does not fit in half the
 * screen (SC-1433). On a 390px phone a holding's identity, figure and four
 * actions ran past 50%, so the rest height cut Edit through the middle and
 * left nothing clear of the home indicator. The floor is the header, one line
 * of body and the bottom safe area, measured, because the header's height
 * depends on the record's action count and the title's wrap.
 */
function usePeekRest(open: boolean) {
  const [content, contentRef] = useState<HTMLDivElement | null>(null);
  const [header, headerRef] = useState<HTMLDivElement | null>(null);
  const [safe, safeRef] = useState<HTMLDivElement | null>(null);
  const [rest, setRest] = useState(PEEK_REST);

  useLayoutEffect(() => {
    if (!open || !content || !header || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      if (content.clientHeight === 0) return;
      const headerBottom =
        header.getBoundingClientRect().bottom - content.getBoundingClientRect().top;
      const needed = headerBottom + PEEK_BODY_GLIMPSE_PX + (safe?.offsetHeight ?? 0);
      setRest(Math.min(PEEK_REST_CEILING, Math.max(PEEK_REST, needed / content.clientHeight)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(content);
    return () => observer.disconnect();
  }, [open, content, header, safe]);

  return { contentRef, headerRef, safeRef, snapPoints: [rest, 1] as const };
}

function Facts({ facts }: { facts: PeekFact[] }) {
  return (
    <dl className="divide-y divide-border">
      {facts.map((fact) => (
        <div key={fact.label} className="flex items-baseline justify-between gap-4 py-2">
          <dt className="shrink-0 text-caption text-muted-foreground">{fact.label}</dt>
          {/* `break-words`, not `truncate`: a wallet address or a long account
              name is the reason the user opened the sheet, and a detail view
              that hides the detail has no job. */}
          <dd className="min-w-0 break-words text-end text-body">{fact.value}</dd>
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
          {/* An `h1`, not `SheetTitle`'s default `h2` (SC-1002). While a peek
              is open the surface behind it is `aria-hidden` — Radix sets it on
              `<main>` — so the exposed document is this dialog and nothing
              else. Its outline started at `h2` with no `h1` above it, which
              made the record's name a subsection of a heading no assistive
              technology could reach. `asChild` keeps Radix's generated id on
              the element, so `aria-labelledby` still names this heading. */}
          <SheetTitle asChild className="truncate text-title">
            <h1>{spec.title}</h1>
          </SheetTitle>
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

      {spec.actions ? (
        <div data-peek-actions="" className={PEEK_ACTIONS}>
          {spec.actions}
        </div>
      ) : null}
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
      {spec.endAction ? (
        <section className="flex flex-col gap-1">
          <h3 className="text-caption font-medium uppercase tracking-wide text-muted-foreground">
            {spec.endAction.title}
          </h3>
          {/* Wraps, so an opened inline confirm takes the whole row rather
              than squeezing beside the hint. */}
          <div className="flex flex-wrap items-center justify-between gap-3 py-2">
            <p className="min-w-0 flex-1 text-caption text-muted-foreground">
              {spec.endAction.hint}
            </p>
            {spec.endAction.action}
          </div>
        </section>
      ) : null}
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
  const fit = usePeekRest(open && !isDesktop);
  // The record names the tab once it has loaded — until then the list page's
  // title stands, rather than "Loading…" or "Not found" (SC-996).
  useDocumentTitle(open && spec ? spec.title : null);

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
          side="end"
          className="w-full gap-0 p-0 focus:outline-none sm:max-w-md"
          // Focus the panel, not its first control: Radix would pick the close
          // X and paint a ring on it before the reader did anything. The same
          // move `FormSheet` and `BottomDrawerContent` make (SC-1413).
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          // Same reasoning as `RefineSheet`: `SheetContent` sets
          // `backgroundColor` inline against an unset `--background`, and an
          // inline style beats any utility. `--surface-2` is the sheet rung of
          // the ramp (§5.1).
          style={{ backgroundColor: 'hsl(var(--surface-2))' }}
        >
          {/* `pr-12` clears the shell's own close button. */}
          <div className="shrink-0 border-b border-border px-4 pb-4 pe-12 pt-4">
            <PeekHeader spec={resolved} />
          </div>
          <ScrollBody className="px-4 py-3">{body}</ScrollBody>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <BottomDrawer open={open} onOpenChange={onOpenChange}>
      <BottomDrawerContent
        ref={fit.contentRef}
        snapPoints={fit.snapPoints}
        expandLabel={t('ui.peek.expand')}
        collapseLabel={t('ui.peek.collapse')}
        style={{ backgroundColor: 'hsl(var(--surface-2))' }}
      >
        <BottomDrawerHeader className="border-b border-border pb-4">
          <div ref={fit.headerRef}>
            <PeekHeader spec={resolved} />
          </div>
        </BottomDrawerHeader>
        <BottomDrawerBody className="py-3">
          {body}
          {/* The home indicator sits over the last fact otherwise. */}
          <div ref={fit.safeRef} style={{ height: DRAWER_SAFE_BOTTOM }} />
        </BottomDrawerBody>
      </BottomDrawerContent>
    </BottomDrawer>
  );
}
