import { HOLDING_LABEL_MAX_LENGTH } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * The pot's name, editable in place.
 *
 * `holdings.label` shipped with SC-330 — the column, the list sublabel, this
 * fact and the create-time write. What never shipped was any way to set one on
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 *
 * Same interaction as `HoldingAmountFact` on purpose. The two facts a reader
 * corrects on a hand-tracked holding are what it holds and what it is called,
 * and putting one behind a pencil in the sheet and the other behind a form
 * would make the pair read as different kinds of thing.
 *
 * `text-body` (16px) on the input for the reason that component gives: iOS
 * zooms the page on focusing anything smaller, and a sheet that jumps when you
 * tap its one input reads as broken without ever being filed as a bug.
 */

interface HoldingLabelFactProps {
  /** The stored name, or `null` on a row that has never had one. */
  label: string | null;
  /** What the pot holds — only for the control's accessible name, so a screen
   *  reader hears which of four RUB rows this pencil opens. */
  symbol: string;
  /**
   * `null` clears the name. The server refuses a name another row in the same
   * account already wears, so this can fail — the peek surfaces that as a
   * toast rather than inline, because by then the sheet may be closed.
   */
  onSave: (label: string | null) => void;
}

export function HoldingLabelFact({ label, symbol, onSave }: HoldingLabelFactProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);

  if (draft === null) {
    return (
      <span className="flex min-w-0 items-center justify-end gap-2">
        {label ? (
          <span className="truncate">{label}</span>
        ) : (
          // The prompt is the value, not a placeholder on an input that is not
          // there. A row reading "Pot: —" says nothing; this one says what the
          // pencil beside it would do.
          <span className="truncate text-muted-foreground">
            {t('v3.holdings.labelFact.unnamed')}
          </span>
        )}
        <button
          type="button"
          onClick={() => setDraft(label ?? '')}
          aria-label={t('v3.holdings.labelFact.edit', { symbol })}
          className="-my-1 rounded-md p-1 text-muted-foreground transition-colors duration-fast ease-emphasized hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Pencil className="size-4" aria-hidden="true" />
        </button>
      </span>
    );
  }

  const commit = () => {
    const next = draft.trim() ? draft.trim() : null;
    // Nothing to write when the reader opened the editor and closed it again.
    // Trimmed on both sides, so re-saving " Savings " over "Savings" is also
    // nothing — the server would store the same string either way.
    if (next !== (label ?? null)) onSave(next);
    setDraft(null);
  };

  return (
    <span className="flex items-center justify-end gap-2">
      <Input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        maxLength={HOLDING_LABEL_MAX_LENGTH}
        placeholder={t('v3.holdings.labelFact.placeholder')}
        className="h-9 w-40 text-body"
        aria-label={t('v3.holdings.labelFact.name')}
        autoFocus
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') setDraft(null);
        }}
      />
      <Button size="sm" onClick={commit}>
        {t('v3.holdings.labelFact.save')}
      </Button>
    </span>
  );
}
