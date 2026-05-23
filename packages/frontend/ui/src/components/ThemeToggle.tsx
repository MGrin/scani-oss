import { Monitor, Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { type Theme, useTheme } from '../contexts/ThemeContext';
import { cn } from '../lib/cn';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

interface ThemeOption {
  value: Theme;
  label: string;
  Icon: typeof Sun;
}

const SYSTEM_OPTION: ThemeOption = { value: 'system', label: 'System', Icon: Monitor };
const OPTIONS: readonly ThemeOption[] = [
  SYSTEM_OPTION,
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
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
  const triggerLabel = `Theme: ${currentOption.label}`;

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
              <span className="truncate">Theme</span>
              <span className="ml-auto text-xs text-muted-foreground/70">
                {currentOption.label}
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
        <div role="listbox" aria-label="Theme" className="flex flex-col">
          {OPTIONS.map(({ value, label, Icon }) => {
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
                <span>{label}</span>
                {selected && (
                  <span aria-hidden="true" className="ml-auto text-xs">
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
