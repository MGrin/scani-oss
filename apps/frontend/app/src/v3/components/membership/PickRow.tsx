import { cn } from '@scani/ui/lib/cn';
import { Checkbox } from '@scani/ui/ui/checkbox';
import type { ReactNode } from 'react';

interface PickRowProps {
  id: string;
  label: string;
  sublabel: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Right-hand zone: a figure or what is still free. Never truncated. */
  trailing?: ReactNode;
  /** Why the row cannot be ticked. Its own line under the sublabel, so it never
   *  squeezes the identity the way a trailing note does. */
  disabledReason?: string;
}

/** One tickable row in an add sheet. The whole row is the label, so a tap
 *  anywhere toggles it — the tap floor is the row, not the 16px box. */
export function PickRow({
  id,
  label,
  sublabel,
  checked,
  onCheckedChange,
  trailing,
  disabledReason,
}: PickRowProps) {
  const disabled = Boolean(disabledReason);
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex min-h-11 items-center gap-3 rounded-md px-3 py-2',
        disabled ? 'opacity-60' : 'cursor-pointer hover:bg-surface-3'
      )}
    >
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label">{label}</span>
        <span className="truncate text-caption text-muted-foreground">{sublabel}</span>
        {disabledReason ? (
          <span className="text-caption text-muted-foreground">{disabledReason}</span>
        ) : null}
      </span>
      {trailing && !disabledReason ? (
        <span className="shrink-0 text-end text-caption text-muted-foreground">{trailing}</span>
      ) : null}
    </label>
  );
}
