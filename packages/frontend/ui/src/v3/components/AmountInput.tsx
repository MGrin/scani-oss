import * as React from 'react';

import { cn } from '../../lib/cn';
import { Input } from '../../ui/input';
import { type AmountRules, formatAmountForDisplay, parseAmountInput } from '../lib/amount-input';

/**
 * The one numeric field in v3 — every amount, balance, share, target and count
 * (SC-75). See `lib/amount-input.ts` for the separator rules; this file owns
 * only the two things that need a DOM.
 *
 * **Grouping is a display state, not an edit state.** Focused, the field shows
 * bare digits and whichever separator the reader typed, so nothing on screen
 * can be mistaken for a group separator. Blurred, it shows the canonical
 * reading with `en-US` grouping. That swap is the safety property: you type
 * `12,99`, you look away, and the field says `12.99` — the interpretation is
 * on screen rather than in the database.
 *
 * **A rejected character is never allowed to change the magnitude.** Anything
 * the parser refuses simply does not appear, and the digits around it do not
 * close over the gap into a different number.
 */

interface AmountInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>,
    AmountRules {
  /** Canonical value — `-?\d+(\.\d+)?` or `''`. Never a formatted string. */
  value: string;
  onValueChange: (value: string) => void;
  /** Appended to the blurred display only, and stripped on the way back in. */
  suffix?: string;
  /** Layout for the element wrapping input + notice. Sizing that used to sit
   *  on the input belongs here whenever the field is a flex child. */
  wrapperClassName?: string;
}

export const AmountInput = React.forwardRef<HTMLInputElement, AmountInputProps>(
  (
    {
      value,
      onValueChange,
      decimalScale = 2,
      allowNegative = false,
      suffix = '',
      className,
      wrapperClassName,
      onFocus,
      onBlur,
      ...props
    },
    ref
  ) => {
    // Non-null exactly while the field is being edited. Holding the reader's
    // own text here — rather than deriving it from `value` — is what lets a
    // half-typed `12,` survive the render that follows its own keystroke.
    const [draft, setDraft] = React.useState<string | null>(null);
    const [ambiguous, setAmbiguous] = React.useState(false);
    const noticeId = React.useId();

    const rules = { decimalScale, allowNegative };
    const display = draft ?? formatAmountForDisplay(value, suffix);

    return (
      <span className={cn('flex min-w-0 flex-col gap-1', wrapperClassName)}>
        <Input
          {...props}
          ref={ref}
          // `text`, not `number`: a `number` input hands back `''` for anything
          // the browser dislikes, which loses the keystroke *and* the value.
          type="text"
          inputMode={decimalScale === 0 ? 'numeric' : 'decimal'}
          autoComplete="off"
          value={display}
          aria-describedby={ambiguous ? noticeId : props['aria-describedby']}
          className={cn(className)}
          onFocus={(event) => {
            setDraft(value);
            setAmbiguous(false);
            onFocus?.(event);
          }}
          onChange={(event) => {
            const parsed = parseAmountInput(event.target.value, rules);
            setDraft(parsed.text);
            setAmbiguous(false);
            if (parsed.value !== value) onValueChange(parsed.value);
          }}
          onBlur={(event) => {
            // Re-read the settled text rather than trusting the running draft:
            // a paste that arrived as the field lost focus is parsed here too.
            const parsed = parseAmountInput(event.target.value, rules);
            setDraft(null);
            setAmbiguous(parsed.ambiguous);
            if (parsed.value !== value) onValueChange(parsed.value);
            onBlur?.(event);
          }}
        />
        {ambiguous ? (
          // Only on blur. Mid-typing it would flash on the way through
          // `1.234` to `1.2345` and teach the reader to ignore it.
          <span id={noticeId} role="status" className="text-caption text-muted-foreground">
            Read as {formatAmountForDisplay(value, suffix)}
            {decimalScale === 0
              ? ' — this field takes whole numbers only.'
              : ' — a comma and a full stop both mean a decimal point here. Delete the separator if you meant a thousand.'}
          </span>
        ) : null}
      </span>
    );
  }
);
AmountInput.displayName = 'AmountInput';
