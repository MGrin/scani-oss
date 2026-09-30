import {
  BottomDrawer,
  BottomDrawerBody,
  BottomDrawerContent,
  BottomDrawerDescription,
  BottomDrawerHeader,
  BottomDrawerTitle,
  DRAWER_SAFE_BOTTOM,
} from '@scani/ui/ui/bottom-drawer';
import { Button } from '@scani/ui/ui/button';
import { ScrollBody } from '@scani/ui/ui/scroll-body';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@scani/ui/ui/sheet';
import { useIsDesktop } from '@scani/ui/v3/hooks/useMediaQuery';
import { Pencil } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A short form in a modal — v3's answer to v2's `Dialog`.
 *
 * The two-shell split is `PeekSheet`'s and `CaptureSheet`'s, unchanged and for
 * the same reason: below `lg` a bottom drawer, above it a right-side panel.
 * What it replaces is a centred `sm:max-w-md` box, which on a 393px phone is a
 * card floating in the middle of the viewport with its submit button under the
 * software keyboard — the shape every v2 dialog has, because Radix `Dialog` has
 * only that one.
 *
 * It rests at its content's height, at most 92%, rather than the drawer
 * default. A menu can rest low and be dragged for more; a form cannot, because
 * the thing below the fold is always the submit button and a form whose button
 * is hidden reads as broken rather than as scrollable.
 *
 * The actions are pinned under the scrolling body, with the header fixed above
 * it, on every size (SC-1418): Refine's layout, and Peek's and Export's. The
 * earlier choice kept them in the body to save a strip of a phone's viewport,
 * but six of ten callers had already opted into a pinned footer, and on
 * desktop the unpinned kind scrolled the title away with the form.
 *
 * Portalling comes from `V3TokenScope`'s `PortalContainerProvider` (V3-22);
 * without it the sheet mounts on `<body>`, outside `data-ui="v3"`, and renders
 * against v2's design system.
 */

/** ~92% — see the note above. Full height on a drag, like every other v3
 *  drawer, so nothing is ever unreachable. */
const FORM_REST = 0.92;

/**
 * A short form rests at its own height, not at 92% (SC-1413): a two-field
 * sheet held at the tall rest height is 40% empty drawer, which reads as
 * something failed to load. A form taller than that keeps the 92% ceiling.
 *
 * The drawer is a full-height box translated by its snap fraction, so "its
 * own height" is measured: handle, header and footer (whatever the column
 * holds besides the body) plus the body's content at its natural height. It is
 * re-measured when the content changes size, so a field that appears grows the
 * drawer up to the ceiling rather than scrolling in a half-empty sheet.
 */
export function useFitSnapPoints(open: boolean, rest: number = FORM_REST) {
  // Callback refs held in state: a sheet mounted closed and opened later gets
  // its portal content a render after `open` flips, so an effect keyed on
  // `open` alone would find no nodes and never measure.
  const [content, contentRef] = useState<HTMLDivElement | null>(null);
  const [inner, innerRef] = useState<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!open || !content || !inner || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const body = inner.parentElement;
      const column = content.firstElementChild as HTMLElement | null;
      if (!body || !column || content.clientHeight === 0) return;
      const { paddingTop, paddingBottom } = getComputedStyle(body);
      const natural =
        column.clientHeight -
        body.clientHeight +
        inner.offsetHeight +
        Number.parseFloat(paddingTop) +
        Number.parseFloat(paddingBottom);
      setFit(Math.min(rest, natural / content.clientHeight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(inner);
    observer.observe(content);
    return () => observer.disconnect();
  }, [open, content, inner, rest]);

  return { contentRef, innerRef, snapPoints: fit === null ? [rest, 1] : [fit, 1] };
}

interface FormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** "Edit <noun>" or "New <noun>" (UI standard rule 13). */
  title: string;
  /** One or two sentences on what the form does to the system. Never
   *  instructions for filling it in — those belong on the fields — and never
   *  the record's own name, which the first field already shows (SC-1436). */
  description: string;
  children: ReactNode;
  /** The actions, pinned under the scrolling body — usually `FormActions`.
   *  Required so a new sheet cannot put them back inside the body (SC-1418);
   *  `null` only while a sub-form in the body owns the actions itself. */
  footer: ReactNode;
}

/** The one spacing every form body has, so no sheet picks its own (SC-1436). */
function FormBody({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}

/**
 * A titled group of fields inside a `FormSheet` (UI standard rule 13).
 *
 * Flat, with a rule above it whenever anything precedes it — never a `Block` card:
 * a card inside a sheet is a box in a box, and it made the bill form the one
 * edit panel that looked unlike the others (SC-1436).
 */
export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 [*+&]:border-t [*+&]:border-border [*+&]:pt-4">
      <h3 className="text-label text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * The one way into editing a record (UI standard rule 13): an outline "Edit"
 * with a pencil, first in the peek's actions or in the record page's summary.
 * It opens the record's `FormSheet`; nothing edits in place.
 */
export function EditAction({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button variant="outline" onClick={onClick}>
      <Pencil className="me-2 size-4" aria-hidden="true" />
      {t('v3.form.edit')}
    </Button>
  );
}

function PinnedFooter({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3"
      style={{ paddingBottom: `calc(0.75rem + ${DRAWER_SAFE_BOTTOM})` }}
    >
      {children}
    </div>
  );
}

export function FormSheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: FormSheetProps) {
  const { t } = useTranslation();
  const isDesktop = useIsDesktop();
  const fit = useFitSnapPoints(open && !isDesktop);

  if (isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="end"
          className="w-full gap-0 p-0 focus:outline-none sm:max-w-md"
          // Focus the panel, not its first control: Radix would pick the close
          // X and paint a ring on it before the reader did anything (SC-1414).
          // The same move `BottomDrawerContent` makes on a phone.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus();
          }}
          // `SheetContent` sets `backgroundColor` inline against an unset
          // `--background`, and an inline style beats any utility.
          style={{ backgroundColor: 'hsl(var(--surface-2))' }}
        >
          <SheetHeader className="shrink-0 border-b border-border px-4 pt-4 pb-4 pe-12 text-start">
            <SheetTitle className="text-title">{title}</SheetTitle>
            <SheetDescription className="text-caption">{description}</SheetDescription>
          </SheetHeader>
          <ScrollBody className="px-4 py-3">
            <FormBody>{children}</FormBody>
          </ScrollBody>
          {footer ? <PinnedFooter>{footer}</PinnedFooter> : null}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <BottomDrawer open={open} onOpenChange={onOpenChange}>
      <BottomDrawerContent
        ref={fit.contentRef}
        snapPoints={fit.snapPoints}
        expandLabel={t('v3.form.sheet.expand')}
        collapseLabel={t('v3.form.sheet.collapse')}
        closeLabel={t('v3.form.sheet.close')}
        style={{ backgroundColor: 'hsl(var(--surface-2))' }}
      >
        <BottomDrawerHeader>
          <BottomDrawerTitle>{title}</BottomDrawerTitle>
          <BottomDrawerDescription>{description}</BottomDrawerDescription>
        </BottomDrawerHeader>
        {footer ? (
          <>
            <BottomDrawerBody className="py-3">
              <div ref={fit.innerRef}>
                <FormBody>{children}</FormBody>
              </div>
            </BottomDrawerBody>
            <PinnedFooter>{footer}</PinnedFooter>
          </>
        ) : (
          <BottomDrawerBody>
            <div ref={fit.innerRef}>
              <FormBody>{children}</FormBody>
              {/* The home indicator sits over the submit button otherwise. */}
              <div style={{ height: DRAWER_SAFE_BOTTOM }} />
            </div>
          </BottomDrawerBody>
        )}
      </BottomDrawerContent>
    </BottomDrawer>
  );
}

interface FormActionsProps {
  submitLabel: string;
  /** Shown in place of the label while the mutation is in flight. */
  pendingLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  /** What is still missing, as phrases that complete "To continue: …". Empty
   *  means the form may be submitted. */
  blockers: string[];
  pending: boolean;
  /** One sentence about the last failed attempt, already in the reader's
   *  language — `describeQueryError().detail` or a keyed string. */
  error: string | null;
}

/**
 * The bottom of a `FormSheet`: the two buttons, what is still missing, and what
 * went wrong last time.
 *
 * **A disabled button always says why** — the capture forms' rule (§2.5),
 * carried across because the two token dialogs break it in exactly the way that
 * rule was written for: v2's "Create token" greys out behind a five-clause
 * boolean and the form gives the reader no way to find out which clause.
 *
 * The failure line is here rather than in a toast, and the toast is gone rather
 * than kept beside it. `showError` opens with "Something went wrong", which is
 * the one sentence §2.5 forbids outright, and it shows for four seconds over
 * the tab bar — so the reader who looked back at the field they were about to
 * fix has no way to see what it said.
 */
export function FormActions({
  submitLabel,
  pendingLabel,
  onSubmit,
  onCancel,
  blockers,
  pending,
  error,
}: FormActionsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2">
      {/* What is missing and what failed sit ABOVE the buttons, as the group
          Add sheet's summary does: read before the choice, not after it (SC-1414). */}
      {blockers.length > 0 ? (
        <p className="text-caption text-muted-foreground lg:text-end">
          {t('v3.form.blockers', { blockers: blockers.join(', ') })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption text-destructive lg:text-end">
          {error}
        </p>
      ) : null}
      {/* `flex-col-reverse` below `lg`: the primary action is the one under the
          thumb, so it sits at the bottom of the stack and at the right of the
          row. */}
      <div className="flex flex-col-reverse gap-2 lg:flex-row lg:justify-end">
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          {t('v3.form.cancel')}
        </Button>
        <Button onClick={onSubmit} disabled={pending || blockers.length > 0}>
          {pending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </div>
  );
}
