import { AMOUNT_MAX_INTEGER_DIGITS } from '@scani/shared';
import * as React from 'react';
import { useUiTranslation } from '../../i18n';
import { cn } from '../../lib/cn';
import { Input } from '../../ui/input';
import {
  type AmountRejection,
  type AmountRules,
  formatAmountForDisplay,
  parseAmountInput,
} from '../lib/amount-input';

/**
 * The one numeric field in v3 — every amount, balance, share, target and count
 * (SC-75). See `lib/amount-input.ts` for the separator rules; this file owns
 * only the two things that need a DOM.
 *
 * **Grouping is a display state, not an edit state.** Focused, the field shows
 * bare digits and whichever separator the reader typed, so nothing on screen
 * can be mistaken for a group separator. Blurred, it shows the canonical
 * reading grouped the way the app prints every other figure — the reader's
 * locale, not `en-US` (SC-415). That swap is the safety property: you type
 * `12,99`, you look away, and the field says `12.99` in English and `12,99` in
 * Russian — the interpretation is on screen rather than in the database.
 *
 * **A rejected character is never allowed to change the magnitude.** Anything
 * the parser refuses simply does not appear, and the digits around it do not
 * close over the gap into a different number.
 *
 * **A refused NUMBER stays on screen and says why** (SC-1527) — an exponent, or
 * more integer digits than any amount has. The value is empty, so nothing can
 * submit it, and `onValueChange` is told it was refused rather than left blank,
 * so a form can tell "not typed yet" from "typed and unreadable". Unlike the
 * notices below it is shown while typing: it is an error, not a reading.
 */

interface AmountInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'>,
    AmountRules {
  /** Canonical value — `-?\d+(\.\d+)?` or `''`. Never a formatted string. */
  value: string;
  /** `rejected` is set when the field holds text it refused to read, and
   *  `value` is then `''` — see `AmountRejection`. */
  onValueChange: (value: string, details: { rejected: AmountRejection | null }) => void;
  /** Appended to the blurred display only, and stripped on the way back in. */
  suffix?: string;
  /** Layout for the element wrapping input + notice. Sizing that used to sit
   *  on the input belongs here whenever the field is a flex child. */
  wrapperClassName?: string;
  /** Shown when a minus is typed into a field that refuses one, so the sign
   *  is never dropped without a word (SC-1530). */
  negativeNotice?: string;
}

export const AmountInput = React.forwardRef<HTMLInputElement, AmountInputProps>(
  (
    {
      value,
      onValueChange,
      decimalScale = 2,
      allowNegative = false,
      maxIntegerDigits = AMOUNT_MAX_INTEGER_DIGITS,
      suffix = '',
      className,
      wrapperClassName,
      negativeNotice,
      onFocus,
      onBlur,
      ...props
    },
    ref
  ) => {
    const { t } = useUiTranslation();
    // Non-null exactly while the field is being edited. Holding the reader's
    // own text here — rather than deriving it from `value` — is what lets a
    // half-typed `12,` survive the render that follows its own keystroke.
    const [draft, setDraft] = React.useState<string | null>(null);
    const [ambiguous, setAmbiguous] = React.useState(false);
    const [truncated, setTruncated] = React.useState(false);
    const [refusal, setRefusal] = React.useState<{ reason: AmountRejection; text: string } | null>(
      null
    );
    const [minusRefused, setMinusRefused] = React.useState(false);
    const noticeId = React.useId();
    const refusalId = React.useId();
    const showRefusal = Boolean(negativeNotice) && minusRefused;

    // Only while the value is still the empty one the refusal produced. A
    // value set from outside afterwards is a reading, and the refusal is over.
    const refused = value === '' ? refusal : null;
    const rules = { decimalScale, allowNegative, maxIntegerDigits };
    // A refused input has no value to echo, so blurring keeps the text the
    // notice is about rather than clearing the field under it.
    const display = draft ?? refused?.text ?? formatAmountForDisplay(value, suffix);
    const notice = refused ? refusalNotice(refused.reason) : readingNotice();

    function refusalNotice(reason: AmountRejection): string {
      return reason === 'exponent'
        ? t('ui.amountInput.exponent')
        : t('ui.amountInput.tooLarge', { max: maxIntegerDigits });
    }

    // Only on blur. Mid-typing they would flash on the way through `1.234` to
    // `1.2345` and teach the reader to ignore them.
    function readingNotice(): string | null {
      if (draft !== null) return null;
      const amount = formatAmountForDisplay(value, suffix);
      if (ambiguous) {
        return decimalScale === 0
          ? t('ui.amountInput.readAsWhole', { amount })
          : t('ui.amountInput.readAsDecimal', { amount });
      }
      if (truncated) return t('ui.amountInput.truncated', { amount });
      return null;
    }

    const settle = (parsed: ReturnType<typeof parseAmountInput>) => {
      setRefusal(parsed.rejected ? { reason: parsed.rejected, text: parsed.text } : null);
      if (parsed.value !== value || parsed.rejected !== (refused?.reason ?? null)) {
        onValueChange(parsed.value, { rejected: parsed.rejected });
      }
    };

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
          aria-describedby={
            [notice ? noticeId : null, showRefusal ? refusalId : null].filter(Boolean).join(' ') ||
            props['aria-describedby']
          }
          aria-invalid={refused ? true : props['aria-invalid']}
          className={cn(className)}
          onFocus={(event) => {
            setDraft(refused ? refused.text : value);
            setAmbiguous(false);
            setTruncated(false);
            setMinusRefused(false);
            onFocus?.(event);
          }}
          onChange={(event) => {
            const parsed = parseAmountInput(event.target.value, rules);
            setDraft(parsed.text);
            setAmbiguous(false);
            setTruncated(false);
            // Sticky until the next edit session: clearing it on the following
            // keystroke would flash it away before it could be read.
            if (parsed.negativeRefused) setMinusRefused(true);
            settle(parsed);
          }}
          onBlur={(event) => {
            // Re-read the settled text rather than trusting the running draft:
            // a paste that arrived as the field lost focus is parsed here too.
            const parsed = parseAmountInput(event.target.value, rules);
            setDraft(null);
            setAmbiguous(parsed.ambiguous);
            setTruncated(parsed.truncated);
            settle(parsed);
            onBlur?.(event);
          }}
        />
        {notice ? (
          <span
            id={noticeId}
            role={refused ? 'alert' : 'status'}
            className={cn('text-caption', refused ? 'text-destructive' : 'text-muted-foreground')}
          >
            {notice}
          </span>
        ) : null}
        {showRefusal ? (
          <span id={refusalId} role="status" className="text-caption text-muted-foreground">
            {negativeNotice}
          </span>
        ) : null}
      </span>
    );
  }
);
AmountInput.displayName = 'AmountInput';
