import { Label } from '@scani/ui/ui/label';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One labelled control, and the v3 form conventions made structural.
 *
 * The conventions are two, and both are things v2's forms get wrong in every
 * file rather than in one:
 *
 * - **The label is 14px, the control is 16px.** v2 labels every field
 *   `text-xs` (12px) and every input `text-sm` (14px), and Safari on iOS zooms
 *   the page on focusing any control below 16px. That zoom reads as "the app
 *   jumped" and is never filed as a bug, so it never gets fixed.
 * - **The hint sits under the control, not inside the label.** v2's payment
 *   form pushes "Estimated amount (optional)" into the label text, which is
 *   what makes two adjacent labels wrap to different heights and their inputs
 *   fall off a shared baseline.
 *
 * The 44px hit floor is *not* here: the token layer already supplies it under
 * `pointer: coarse` (V3-23), and `min-h-tap` is inert on a control inside v3
 * (V3-25). Controls get their height from their own padding.
 */

interface FieldProps {
  label: string;
  /** Ties the label to the control. Omit for a control that is not a single
   *  focusable element — a segmented control labels itself. */
  htmlFor?: string;
  /** One line under the control. Never a sentence about how to fill it in. */
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Field({ label, htmlFor, hint, children, className }: FieldProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor} className="text-label">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-caption text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * Two or three fields that are one decision, side by side above `lg`.
 *
 * A phone has room for one field per line and nothing else, so the vertical
 * stack there is not a compromise — it is the only layout. A 1400px window is
 * the opposite case: "every 4 weeks" split across two lines a full field-height
 * apart reads as two unrelated questions, and the form becomes a 560px ribbon
 * down the middle of an empty screen. Pairing them puts the decision back
 * together *and* halves the scroll.
 *
 * Only for fields that are genuinely one thought — interval and its unit,
 * amount and its currency, a start and its end. Two unrelated fields sharing a
 * line is just a narrower form.
 *
 * `items-start`, because a field with a hint under it is taller than one
 * without and the two controls have to stay on a shared baseline regardless.
 */
export function FieldRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid grid-cols-1 items-start gap-3 lg:grid-cols-2', className)}>
      {children}
    </div>
  );
}

/** A titled group of fields. The form's own section rule — `<Block>` draws the
 *  surface, this draws the heading and the spacing inside it. */
export function FieldSet({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-3 p-4', className)}>
      <h2 className="text-label text-muted-foreground">{title}</h2>
      {children}
    </div>
  );
}
