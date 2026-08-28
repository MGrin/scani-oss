import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { type Theme, useTheme } from '../contexts/ThemeContext';
import { uiT } from '../i18n';
import { cn } from '../lib/cn';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

interface ThemeOption {
  value: Theme;
  labelKey: string;
  Icon: typeof Sun;
}

const SYSTEM_OPTION: ThemeOption = {
  value: 'system',
  labelKey: 'ui.theme.system',
  Icon: Monitor,
};
const OPTIONS: readonly ThemeOption[] = [
  SYSTEM_OPTION,
  { value: 'light', labelKey: 'ui.theme.light', Icon: Sun },
  { value: 'dark', labelKey: 'ui.theme.dark', Icon: Moon },
];

export interface ThemeToggleProps {
  /** Render the trigger as a full-width row (label + icon) instead of an icon-only square. */
  variant?: 'icon' | 'row';
  /** Hide the textual label — used when the surrounding chrome is collapsed. */
  hideLabel?: boolean;
  /** Override the trigger's class names. */
  className?: string;
  /** Popover side; defaults to 'top' so the menu opens upward inside footers/sheets. */
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Popover alignment; defaults to 'start'. */
  align?: 'start' | 'center' | 'end';
}

export function ThemeToggle({
  variant = 'icon',
  hideLabel = false,
  className,
  side = 'top',
  align = 'start',
}: ThemeToggleProps) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [open, setOpen] = useState(false);

  const TriggerIcon = theme === 'system' ? Monitor : resolvedTheme === 'dark' ? Moon : Sun;
  const currentOption = OPTIONS.find((o) => o.value === theme) ?? SYSTEM_OPTION;
  const triggerLabel = uiT('ui.theme.trigger', { theme: uiT(currentOption.labelKey) });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={triggerLabel}
          title={triggerLabel}
          className={cn(
            'inline-flex items-center gap-2.5 rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            variant === 'row' ? 'w-full px-2 py-1.5 text-[13px]' : 'h-9 w-9 justify-center p-1.5',
            className
          )}
        >
          <TriggerIcon
            className={cn(variant === 'row' ? 'h-4 w-4 shrink-0' : 'h-5 w-5 shrink-0')}
            aria-hidden="true"
          />
          {variant === 'row' && !hideLabel && (
            <>
              <span className="truncate">{uiT('ui.theme.label')}</span>
              {/* Full-opacity `--muted-foreground`, not `/70`. The token
                  clears 4.5:1 on its own; taking 70% of it drops the current
                  theme's name to 3.4:1 in light, which is §2.6's "the opacity
                  modifier is the bug" row, found by the v3 axe gate.

                  13px, matching the row's own size rather than `text-xs`: at
                  12px this was the smallest text in the More drawer and below
                  v3's caption floor (SC-71 6.1). It is the *answer* to the
                  label beside it, so it has no business being smaller. */}
              <span className="ms-auto text-[13px] text-muted-foreground">
                {uiT(currentOption.labelKey)}
              </span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className="w-44 p-1"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <div role="listbox" aria-label={uiT('ui.theme.label')} className="flex flex-col">
          {OPTIONS.map(({ value, labelKey, Icon }) => {
            const selected = theme === value;
            return (
              <button
                key={value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  setTheme(value);
                  setOpen(false);
                }}
                className={cn(
                  'flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors',
                  selected
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>{uiT(labelKey)}</span>
                {selected && (
                  <span aria-hidden="true" className="ms-auto text-xs">
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
