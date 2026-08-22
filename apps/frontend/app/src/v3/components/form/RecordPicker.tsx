import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import { Loader2, Plus, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * One combobox, used for both of the payment form's searched fields — the
 * vendor and the currency.
 *
 * v2 has two of these (`VendorPicker`, `TokenSearchInput`), each about 160
 * lines, each with its own click-outside effect, its own dropdown geometry and
 * its own idea of how a selected value is shown. They differ in what they
 * search, which is the one thing a prop can carry. So the search is the
 * caller's — this owns the control.
 *
 * Deliberately not `Command` inside a `Popover`: both of these search a server
 * (one filters a small local list, one debounces into `tokens.search`), and
 * `Command`'s value is its own client-side filtering, which would then have to
 * be disabled. A `<div>` under an `<input>` is the honest shape.
 *
 * Every row is `py-3` rather than `min-h-tap`: the token layer supplies 44px
 * under a coarse pointer and the utility is inert on a button inside v3
 * (V3-25), so padding is what actually makes a row reachable with a thumb.
 */

interface PickerOption {
  id: string;
  label: string;
  /** Secondary text on the right of the row — a token's name, a category. */
  hint?: string;
  /** A favicon or logo. */
  leading?: React.ReactNode;
}

interface RecordPickerProps {
  /** The chosen record, shown in place of the search field. */
  value: { id: string; label: string } | null;
  onSelect: (id: string, label: string) => void;
  onClear: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: PickerOption[];
  isLoading?: boolean;
  placeholder: string;
  /** Announces the search field, since `<Field>`'s label sits on the control
   *  this replaces once something is chosen. */
  ariaLabel: string;
  /** Shown when the query matches nothing. */
  emptyLabel: string;
  /**
   * Records the query resembles without matching. Rendered ABOVE the create
   * row under `suggestionsLabel`, because a near-duplicate the user can't see
   * until after they've created its twin is the duplicate.
   */
  suggestions?: PickerOption[];
  suggestionsLabel?: string;
  /** Enables the inline "create" row at the FOOT of the list — see the note
   *  at its render site for why it is never first. */
  createLabel?: (query: string) => string;
  onCreate?: (query: string) => void;
  isCreating?: boolean;
  disabled?: boolean;
  inputId?: string;
}

const ROW =
  'flex w-full items-center gap-2 px-3 py-3 text-left text-body transition-colors duration-fast ease-emphasized hover:bg-surface-hover focus-visible:outline-none focus-visible:bg-surface-hover disabled:opacity-50';

export function RecordPicker({
  value,
  onSelect,
  onClear,
  query,
  onQueryChange,
  open,
  onOpenChange,
  options,
  isLoading,
  placeholder,
  ariaLabel,
  emptyLabel,
  suggestions,
  suggestionsLabel,
  createLabel,
  onCreate,
  isCreating,
  disabled,
  inputId,
}: RecordPickerProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const loadingPhase = useDelayedLoading(Boolean(isLoading));

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open, onOpenChange]);

  if (value) {
    return (
      <div className="flex items-center gap-2">
        {/* `--surface-hover`, not `--surface-2`: this sits *on* the block, and
            on the white light page surface-2 is the same white. */}
        <p className="flex min-w-0 flex-1 items-center rounded-md border border-border-strong bg-surface-hover px-3 py-2.5 text-body">
          <span className="truncate">{value.label}</span>
        </p>
        <Button
          variant="ghost"
          disabled={disabled}
          onClick={onClear}
          aria-label={t('v3.form.recordPicker.change', { label: ariaLabel })}
        >
          <X className="mr-1.5 h-4 w-4" aria-hidden="true" />
          {t('v3.form.recordPicker.changeAction')}
        </Button>
      </div>
    );
  }

  const canCreate = Boolean(createLabel && onCreate);

  return (
    <div className="relative" ref={containerRef}>
      <Input
        id={inputId}
        value={query}
        aria-label={ariaLabel}
        onChange={(event) => {
          onQueryChange(event.target.value);
          onOpenChange(true);
        }}
        onFocus={() => onOpenChange(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onOpenChange(false);
        }}
        placeholder={placeholder}
        className="text-body"
        disabled={disabled}
      />

      {open ? (
        // z-20: above the surface, below the sheets and drawers at 100 (§6 of
        // the design brief).
        <div className="absolute z-20 mt-1 max-h-[280px] w-full overflow-y-auto rounded-md border border-border-strong bg-popover shadow-md">
          {suggestions && suggestions.length > 0 ? (
            <div className="border-b border-border bg-surface-hover">
              {suggestionsLabel ? (
                <p className="px-3 pt-2 text-caption text-muted-foreground">{suggestionsLabel}</p>
              ) : null}
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.id}
                  type="button"
                  className={ROW}
                  onClick={() => {
                    onSelect(suggestion.id, suggestion.label);
                    onQueryChange('');
                    onOpenChange(false);
                  }}
                >
                  {suggestion.leading}
                  <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
                  {suggestion.hint ? (
                    <span className="shrink-0 truncate text-caption text-muted-foreground">
                      {suggestion.hint}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {/* §2.5's first band: a vendor list already in cache resolves well
              inside 300ms, and a "Searching…" row that appears and vanishes
              between two keystrokes reads as the picker malfunctioning. The
              row itself is the whole indicator here — a popover is small
              enough that a skeleton of it would be the same size. */}
          {isLoading && loadingPhase !== 'idle' ? (
            <p
              role="status"
              className="flex items-center gap-2 px-3 py-3 text-body text-muted-foreground"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {t('v3.form.recordPicker.searching')}
            </p>
          ) : null}

          {!isLoading &&
            options.map((option) => (
              <button
                key={option.id}
                type="button"
                className={ROW}
                onClick={() => {
                  onSelect(option.id, option.label);
                  onQueryChange('');
                  onOpenChange(false);
                }}
              >
                {option.leading}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint ? (
                  <span className="shrink-0 truncate text-caption text-muted-foreground">
                    {option.hint}
                  </span>
                ) : null}
              </button>
            ))}

          {/* "Nothing by that name" would contradict the near-duplicate sitting
              directly above it — the search did find something, just not under
              the name that was typed. */}
          {!isLoading && options.length === 0 && !suggestions?.length ? (
            <p className="px-3 py-3 text-body text-muted-foreground">{emptyLabel}</p>
          ) : null}

          {/* LAST, under the matches — never first (SC-69 1.4). A dropdown
              opens directly under the finger that is still on the field, so
              the top row is the cheapest thing in the list to hit by accident.
              With create there, typing "netf" put `+ Create "netf"` above
              `Netflix` and typing "krak" put `+ Add "krak"` above `Kraken`:
              the easiest mis-tap wrote a junk vendor or institution into the
              account, and the record it duplicated was the row underneath it.
              Creating is also the rarer intent and the only irreversible one
              here, so it is the one that should cost a deliberate reach. */}
          {canCreate && createLabel && onCreate ? (
            <button
              type="button"
              className={cn(ROW, 'border-t border-border text-primary')}
              disabled={!query.trim() || isCreating}
              onClick={() => onCreate(query.trim())}
            >
              {isCreating ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="h-4 w-4 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">{createLabel(query.trim())}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
