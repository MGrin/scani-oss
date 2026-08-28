import { Input } from '@scani/ui/ui/input';
import { Check } from 'lucide-react';
import { useId, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { filterMergeCandidates, type MergeCandidate } from '../../lib/money';

/**
 * Which vendor gets deleted — chosen in place, at a size a thumb can hit
 * (SC-78 §4).
 *
 * This replaces a `Select`. On a real iPhone that control opened its option
 * list **upward, over the sheet's own header and out onto the dimmed page**,
 * with rows measured at a 32pt pitch across 21 adjacent vendors. Two separate
 * failures, on the one action in the vendor surface that deletes a record:
 *
 * - **Under the touch floor.** The 44px minimum v3 relies on comes from the
 *   token layer matching `button` under a coarse pointer; a Radix
 *   `SelectItem` renders `div[role="option"]`, so it is not matched and the
 *   rows came out at whatever the type set them to. The same exclusion bit
 *   `GroupColorChoice`'s radio. Rows here are real `<button>`s with `py-3`,
 *   which is what `RecordPicker` does and what actually makes a row reachable.
 * - **It hid its own destination.** While the list was open it covered the
 *   sheet header naming the vendor being merged *into*, so the reader picked a
 *   deletion target without being able to see what it was being folded into.
 *   Nothing here floats: the list is laid out in the flow of the confirmation
 *   block, and the survivor's name is a sticky caption inside the scroll box,
 *   so the destination is on screen for every row the reader considers.
 *
 * The search field appears only past `SEARCH_THRESHOLD`. Below it the list is
 * shorter than the keyboard it would raise.
 */

/** Under this, scanning is faster than typing — and on a phone a search field
 *  costs half the viewport to the keyboard. */
const SEARCH_THRESHOLD = 8;

/** Tall enough for four 44px rows, so the list is visibly scrollable rather
 *  than looking like it ends. */
const LIST_MAX_HEIGHT = 'max-h-[13rem]';

interface DuplicateVendorPickerProps {
  /** The vendor that survives. Named above every row. */
  survivorName: string;
  candidates: MergeCandidate[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export function DuplicateVendorPicker({
  survivorName,
  candidates,
  value,
  onChange,
  disabled,
}: DuplicateVendorPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const searchId = useId();
  const listId = useId();

  const matches = filterMergeCandidates(candidates, query);
  const showSearch = candidates.length > SEARCH_THRESHOLD;

  return (
    <div className="space-y-2">
      {showSearch ? (
        <Input
          id={searchId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('v3.money.duplicatePicker.searchPlaceholder')}
          aria-label={t('v3.money.duplicatePicker.searchLabel')}
          aria-controls={listId}
          disabled={disabled}
          className="text-body"
        />
      ) : null}

      <div
        className={cn(
          'overflow-y-auto rounded-md border border-border-strong bg-surface-hover',
          LIST_MAX_HEIGHT
        )}
      >
        {/* Sticky, not merely above: the whole defect was a picker that hid
            what the reader was merging into. */}
        <p className="sticky top-0 z-10 border-b border-border bg-surface-hover px-3 py-2 text-caption text-muted-foreground">
          {/* `<Trans>` rather than `t()`: the survivor's name is a rendered
              node inside the sentence. Splitting it into two keys either side
              of the span fixes the word order in English and breaks it
              everywhere else. */}
          <Trans
            i18nKey="v3.money.duplicatePicker.intro"
            values={{ vendor: survivorName }}
            components={{ survivor: <span className="font-medium text-foreground" /> }}
          />
        </p>

        <div
          id={listId}
          role="radiogroup"
          aria-label={t('v3.money.duplicatePicker.optionLabel', { vendor: survivorName })}
        >
          {matches.map((candidate) => {
            const selected = candidate.id === value;
            return (
              // biome-ignore lint/a11y/useSemanticElements: a native input[type=radio] is excluded from the token layer's coarse-pointer 44px rule (v3-tokens.css keys it off `button`), and a row under the touch floor is the exact defect this component fixes
              <button
                key={candidate.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => onChange(candidate.id)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-3 text-start text-body transition-colors duration-fast ease-emphasized',
                  'hover:bg-surface focus-visible:bg-surface focus-visible:outline-none disabled:opacity-50',
                  selected && 'bg-surface font-medium'
                )}
              >
                <Check
                  className={cn('h-4 w-4 shrink-0', selected ? 'opacity-100' : 'opacity-0')}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate">{candidate.displayName}</span>
              </button>
            );
          })}

          {matches.length === 0 ? (
            <p className="px-3 py-3 text-body text-muted-foreground">
              {t('v3.money.duplicatePicker.noMatch', { query: query.trim() })}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
