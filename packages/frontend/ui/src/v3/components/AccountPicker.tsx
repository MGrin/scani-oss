import { accountLabelParts } from '@scani/shared';
import { Search } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { useUiTranslation } from '../../i18n';
import { cn } from '../../lib/cn';
import { Input } from '../../ui/input';
import { TruncatedText } from './TruncatedText';

/**
 * The one control that asks "which account?" (SC-850).
 *
 * There was no shared one. Fourteen surfaces select an account or a holding
 * and each grew its own spelling — a `<Select>` here, a flat `<label><input
 * type="radio">` list there — so the same question looked and behaved
 * differently depending on which screen asked it. This is that control, once.
 *
 * **It is a list, not a combobox, and that is deliberate.** The destination of
 * a transfer is chosen by *comparing* rows: two holdings in one account, same
 * token, same name, telling them apart by a balance. A combobox hides the
 * comparison behind a dropdown that closes on the first choice. Where a caller
 * genuinely wants type-to-pick against a server, `RecordPicker` is that shape
 * and stays that shape.
 *
 * Four rules it enforces rather than documents, each one a defect from the
 * production screenshot this was built from:
 *
 * - **THE INSTITUTION IS NEVER REPEATED INTO THE NAME.** `Airwallex ·
 *   Airwallex` and `Bitcoin Network · Bitcoin Network - bc1q5n…` were what
 *   concatenating the two fields produced. `institution` is its own dim
 *   prefix, and it is dropped when the name already opens with it — so the
 *   second row reads `Bitcoin Network · bc1q5n…` and the identifying half is
 *   the half that survives truncation.
 * - **A ROW WITH NO SUBTITLE IS ONE LINE.** `subtitle` is optional and the
 *   row does not reserve space for one it lacks. The screenshot's subtitle was
 *   the same sentence on every row, which is not information; a caller that
 *   can only say the same thing about every option should say it once, in a
 *   `groupHint`, and leave the rows alone.
 * - **CALLER ORDER IS THE ORDER.** Nothing is re-sorted here. The array is the
 *   relevance ranking, groups appear in the order their first member does, and
 *   a caller that knows a SOL transfer cannot land in a Bitcoin wallet is the
 *   only party that can know it. Sorting alphabetically underneath a caller
 *   who ranked its options is the defect, not the default.
 * - **THE LIST SAYS WHEN IT CONTINUES.** It scrolls inside a sheet whose own
 *   footer is sticky, so the last visible row was being cut with nothing
 *   saying more existed. The scroll region carries a fade at its foot and a
 *   count beneath it.
 *
 * Search appears on its own above `SEARCH_THRESHOLD` options, and stays once a
 * query has narrowed the list below it — a search field that vanishes when it
 * succeeds cannot be cleared.
 */

/** Below this many rows a search field costs more than it saves. */
const SEARCH_THRESHOLD = 8;

export interface AccountPickerOption {
  /** Stable across renders — this is what `value` is compared against. */
  id: string;
  /** The account's own name. Never pre-concatenated with the institution. */
  name: string;
  /** Rendered dim before the name, and dropped when `name` already opens with
   *  it. Null and undefined both mean "no institution". */
  institution?: string | null;
  /** A second line, when there is something to say that differs between rows.
   *  Omit it — a row without one is a single line. */
  subtitle?: string;
  /** A figure on the trailing edge, already formatted by the caller. */
  trailing?: ReactNode;
  /** Matched by search but never rendered — a wallet address, an IBAN. */
  searchText?: string;
  /** The heading this row sits under. Rows carrying no group render first,
   *  with no heading at all. */
  group?: string;
  /** One sentence under the group's heading. Where a fact is true of every row
   *  in the group, it belongs here rather than on each of them. */
  groupHint?: string;
  disabled?: boolean;
}

interface AccountPickerProps {
  options: AccountPickerOption[];
  /** The chosen option's `id`, or null. */
  value: string | null;
  onChange: (option: AccountPickerOption) => void;
  /**
   * The radio group's `name`. Two pickers can be mounted at once — a transfer's
   * own answer and its split editor's — and they must not share a group.
   */
  name: string;
  /** Announces the fieldset. Not rendered. */
  legend: string;
  /** Overrides the default search placeholder. */
  searchPlaceholder?: string;
  /** Shown in place of the list when `options` is empty. */
  emptyLabel: string;
  isLoading?: boolean;
  loadingLabel?: string;
  className?: string;
}

function matches(option: AccountPickerOption, term: string): boolean {
  const haystack = [
    option.name,
    option.institution,
    option.subtitle,
    option.searchText,
    option.group,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(term);
}

/** Groups in the order their first member appears — the caller's ranking. */
function groupsInOrder(
  options: AccountPickerOption[]
): { key: string; label: string | null; hint?: string; rows: AccountPickerOption[] }[] {
  const out: { key: string; label: string | null; hint?: string; rows: AccountPickerOption[] }[] =
    [];
  const index = new Map<string, number>();
  for (const option of options) {
    const key = option.group ?? '';
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, out.length);
      out.push({ key, label: option.group ?? null, hint: option.groupHint, rows: [option] });
    } else {
      const group = out[at];
      if (group) group.rows.push(option);
    }
  }
  return out;
}

export function AccountPicker({
  options,
  value,
  onChange,
  name,
  legend,
  searchPlaceholder,
  emptyLabel,
  isLoading,
  loadingLabel,
  className,
}: AccountPickerProps) {
  const { t } = useUiTranslation();
  const searchId = useId();
  const [query, setQuery] = useState('');

  const term = query.trim().toLowerCase();
  const visible = useMemo(
    () => (term ? options.filter((option) => matches(option, term)) : options),
    [options, term]
  );
  const groups = useMemo(() => groupsInOrder(visible), [visible]);

  if (isLoading) {
    return (
      <p role="status" className="text-caption text-muted-foreground">
        {loadingLabel ?? t('ui.accountPicker.loading')}
      </p>
    );
  }

  if (options.length === 0) {
    return <p className="text-body text-muted-foreground">{emptyLabel}</p>;
  }

  // Once a query has narrowed the list the field must stay, or there is no way
  // back to the rows it hid.
  const showSearch = options.length >= SEARCH_THRESHOLD || query.length > 0;

  return (
    <fieldset className={cn('flex flex-col gap-2', className)}>
      <legend className="sr-only">{legend}</legend>

      {showSearch ? (
        <div className="relative">
          <Search
            className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchPlaceholder ?? t('ui.accountPicker.searchPlaceholder')}
            aria-label={searchPlaceholder ?? t('ui.accountPicker.searchPlaceholder')}
            className="ps-9 text-body"
          />
        </div>
      ) : null}

      {/* The fade is the affordance the sheet's sticky footer took away: the
          list ends in a gradient rather than at a hard edge mid-row, so a cut
          row reads as "there is more" instead of as the end. `mask-image` and
          not an overlay div — an overlay would sit above the rows and eat the
          taps aimed at the last one.

          `pb-8` IS PART OF THE FADE, not spacing. The mask is fixed to the
          container's bottom edge, so without it the LAST row sits under the
          gradient once you scroll to it — trading "cut with no affordance" for
          "the final option is unreadable", which is the same defect wearing a
          nicer costume. The padding parks the content 2rem clear of the edge at
          full scroll, so rows fade on their way past and the end of the list is
          plainly the end. No measurement, no scroll listener: a fade that
          depends on `scrollTop` is a frame of wrong state on every list. */}
      <div
        className={cn(
          'flex max-h-72 flex-col gap-2 overflow-y-auto',
          visible.length > 4 &&
            'pb-8 [mask-image:linear-gradient(to_bottom,black_calc(100%-2rem),transparent)]'
        )}
      >
        {visible.length === 0 ? (
          <p className="px-1 py-3 text-body text-muted-foreground">
            {t('ui.accountPicker.noMatch', { query: query.trim() })}
          </p>
        ) : null}

        {groups.map((group) => (
          <div key={group.key} className="flex flex-col gap-2">
            {group.label ? (
              <div className="flex flex-col gap-0.5 px-1 pt-1">
                <span className="text-label font-medium text-muted-foreground">{group.label}</span>
                {group.hint ? (
                  <span className="text-caption text-muted-foreground">{group.hint}</span>
                ) : null}
              </div>
            ) : null}

            {group.rows.map((option) => {
              const isSelected = option.id === value;
              const label = accountLabelParts(option.name, option.institution);
              return (
                <label
                  key={option.id}
                  // `min-h-11` is the 44px touch target, and the whole row is
                  // the hit area: a 20px dot beside the text is a mis-tap that
                  // changes where money went.
                  className={cn(
                    'flex min-h-11 w-full items-start gap-3 rounded-lg border p-3 text-start transition-colors focus-within:ring-2 focus-within:ring-ring',
                    option.disabled
                      ? 'cursor-not-allowed border-border bg-surface-1 opacity-50'
                      : 'cursor-pointer',
                    !option.disabled && isSelected
                      ? 'border-primary bg-primary/5'
                      : !option.disabled && 'border-border bg-surface-1 hover:bg-surface-hover'
                  )}
                >
                  <input
                    type="radio"
                    name={name}
                    checked={isSelected}
                    disabled={option.disabled}
                    onChange={() => onChange(option)}
                    className="sr-only"
                  />
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
                      isSelected ? 'border-primary bg-primary' : 'border-border'
                    )}
                  >
                    {isSelected ? (
                      <span className="size-2 rounded-full bg-primary-foreground" />
                    ) : null}
                  </span>

                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <TruncatedText className="truncate text-body font-medium">
                      {label.institution ? (
                        <span className="font-normal text-muted-foreground">
                          {label.institution} ·{' '}
                        </span>
                      ) : null}
                      {label.name}
                    </TruncatedText>
                    {/* Only when there is one. A row that has nothing to add
                        does not reserve a line for it. */}
                    {option.subtitle ? (
                      <TruncatedText className="truncate text-caption text-muted-foreground">
                        {option.subtitle}
                      </TruncatedText>
                    ) : null}
                  </span>

                  {option.trailing ? (
                    <span className="shrink-0 text-caption text-muted-foreground">
                      {option.trailing}
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        ))}
      </div>

      {/* Under the fade, outside the scroll region, so it is readable at every
          scroll position — the count is what says the list did not end where
          the gradient did. */}
      {term && visible.length > 0 ? (
        <p className="px-1 text-caption text-muted-foreground">
          {t('ui.accountPicker.shownOf', { shown: visible.length, total: options.length })}
        </p>
      ) : null}
    </fieldset>
  );
}
