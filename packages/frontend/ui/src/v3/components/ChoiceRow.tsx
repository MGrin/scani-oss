import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * One option in a list of radio rows where a choice moves money (SC-977).
 *
 * `AccountPicker` asks "which account?" and the transfer review asks "which
 * transaction is the other half?" — different questions over different
 * records, so neither can take the other's component. What they share is the
 * ROW, and until this existed each carried its own byte-identical copy of it,
 * so a change to the touch target, the selected state or the focus ring on one
 * would not have reached the other.
 *
 * A real `<input type="radio">` inside a `<label>`, not a button with
 * `role="radio"`: the native control brings arrow-key movement within the
 * group and the right screen-reader announcement, and the label makes the
 * whole row the hit area. `min-h-11` is the 44px touch target, and the whole
 * row is the hit area because a 20px dot beside the text is a mis-tap that
 * changes where money went.
 */
export function ChoiceRow({
  name,
  checked,
  onSelect,
  children,
}: {
  /** The radio group's `name`. */
  name: string;
  checked: boolean;
  onSelect: () => void;
  /** What the option says. Laid out as a column beside the dot. */
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        'flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-lg border p-3 text-start transition-colors focus-within:ring-2 focus-within:ring-ring',
        checked
          ? 'border-primary bg-primary/5'
          : 'border-border bg-surface-1 hover:bg-surface-hover'
      )}
    >
      <input type="radio" name={name} checked={checked} onChange={onSelect} className="sr-only" />
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
          checked ? 'border-primary bg-primary' : 'border-border'
        )}
      >
        {checked ? <span className="size-2 rounded-full bg-primary-foreground" /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</span>
    </label>
  );
}
