import {
  BottomDrawer,
  BottomDrawerBody,
  BottomDrawerContent,
  BottomDrawerDescription,
  BottomDrawerHeader,
  BottomDrawerTitle,
} from '@scani/ui/ui/bottom-drawer';
import { Button } from '@scani/ui/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@scani/ui/ui/sheet';
import { useIsDesktop } from '@scani/ui/v3/hooks/useMediaQuery';
import type { ReactNode } from 'react';
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
 * It rests at 92% rather than the drawer default. A menu can rest low and be
 * dragged for more; a form cannot, because the thing below the fold is always
 * the submit button and a form whose button is hidden reads as broken rather
 * than as scrollable.
 *
 * The actions are inside the scrolling body rather than pinned under it. A
 * pinned footer costs the form a fixed strip of the shortest viewport it has,
 * and these forms are six fields at most — the button is one flick away at
 * worst, and `FormActions` is what says whether it can be pressed.
 *
 * Portalling comes from `V3TokenScope`'s `PortalContainerProvider` (V3-22);
 * without it the sheet mounts on `<body>`, outside `data-ui="v3"`, and renders
 * against v2's design system.
 */

/** ~92% — see the note above. Full height on a drag, like every other v3
 *  drawer, so nothing is ever unreachable. */
const FORM_SNAP_POINTS = [0.92, 1] as const;

interface FormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One or two sentences on what the form does to the system. Never
   *  instructions for filling it in — those belong on the fields. */
  description: string;
  children: ReactNode;
}

export function FormSheet({ open, onOpenChange, title, description, children }: FormSheetProps) {
  const { t } = useTranslation();
  const isDesktop = useIsDesktop();

  if (isDesktop) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="end"
          className="w-full gap-0 overflow-y-auto sm:max-w-md"
          // `SheetContent` sets `backgroundColor` inline against an unset
          // `--background`, and an inline style beats any utility.
          style={{ backgroundColor: 'hsl(var(--surface-2))' }}
        >
          <SheetHeader className="pe-8 text-start">
            <SheetTitle className="text-title">{title}</SheetTitle>
            <SheetDescription className="text-caption">{description}</SheetDescription>
          </SheetHeader>
          <div className="pt-4">{children}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <BottomDrawer open={open} onOpenChange={onOpenChange}>
      <BottomDrawerContent
        snapPoints={FORM_SNAP_POINTS}
        expandLabel={t('v3.form.sheet.expand')}
        collapseLabel={t('v3.form.sheet.collapse')}
        closeLabel={t('v3.form.sheet.close')}
        style={{ backgroundColor: 'hsl(var(--surface-2))' }}
      >
        <BottomDrawerHeader>
          <BottomDrawerTitle>{title}</BottomDrawerTitle>
          <BottomDrawerDescription>{description}</BottomDrawerDescription>
        </BottomDrawerHeader>
        <BottomDrawerBody>
          {children}
          {/* The home indicator sits over the submit button otherwise. */}
          <div style={{ height: 'env(safe-area-inset-bottom, 0px)' }} />
        </BottomDrawerBody>
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
    </div>
  );
}
