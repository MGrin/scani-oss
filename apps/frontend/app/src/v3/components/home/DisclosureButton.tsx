import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * "Show the other nine" — the control three home blocks use to keep a list
 * bounded on a phone without moving anything off the screen.
 *
 * It exists because the alternative pattern, a cap plus a "See all" link, needs
 * somewhere to send the reader, and groups and vaults have no v3 screen yet. An
 * inline disclosure has no such dependency: everything the block knows stays
 * inside the block, one tap away, and the default state still fits.
 */

interface DisclosureButtonProps {
  expanded: boolean;
  onToggle: () => void;
  /** What opening it reveals, e.g. "the 14 in Other". Never just "more". */
  label: string;
  className?: string;
}

export function DisclosureButton({ expanded, onToggle, label, className }: DisclosureButtonProps) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      className={cn(
        'inline-flex items-center gap-1 self-start rounded-md py-1 text-caption text-muted-foreground',
        'transition-colors duration-fast ease-emphasized hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        className
      )}
    >
      <ChevronDown
        aria-hidden="true"
        className={cn(
          'size-3.5 transition-transform duration-fast ease-emphasized',
          expanded && 'rotate-180'
        )}
      />
      {/* `label` arrives already translated from the block that owns it —
          "the 14 in Other" is that block's sentence, not this button's. Here it
          is an interpolated value so the verb and the object can swap order.
          (SC-201) */}
      {expanded ? t('v3.home.disclosure.showLess') : t('v3.home.disclosure.show', { label })}
    </button>
  );
}
