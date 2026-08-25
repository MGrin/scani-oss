import { formatDate } from '@scani/shared';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/**
 * A date entry that keeps the platform's picker and takes back the display.
 *
 * `<input type="date">` is three separate defects on iOS and one decision, and
 * the decision drives the shape:
 *
 * - **The picker stays native.** A hand-rolled calendar on a phone is worse
 *   than the wheel every other app on that phone uses, and it is a surface we
 *   would then own forever — keyboard, month paging, locale-ordered weekdays.
 * - **The *value* is ours.** A native date input always renders in the *system*
 *   locale, which is how an English UI came to show `12 авг. 2026 г.` on a
 *   Russian-set phone while the row beneath it read the same date through
 *   `formatDate`. So the input is transparent at rest and a span of our own
 *   carries the value, formatted by exactly the helper every read-only date in
 *   v3 uses. Focus reveals the native control, because that is the moment the
 *   user is talking to the platform and the platform should answer.
 *
 * The other two defects fall out of that. The input is `absolute inset-0`, so
 * its intrinsic width — which is text-driven on iOS and is what pushed both
 * fields past the card's edge at 390px — leaves the flow entirely and can no
 * longer size a grid track. And the value is left-aligned like every other
 * field on the form: our span by default, the native control by
 * `::-webkit-date-and-time-value`, which is the only handle iOS gives on the
 * text it centres.
 */

interface DateFieldProps {
  id: string;
  /** `YYYY-MM-DD`, or `''` for a date that has not been set. */
  value: string;
  onChange: (next: string) => void;
  /** What an unset field reads as. An optional date says what "unset" means —
   *  "Never" — rather than leaving a control that looks like it failed. */
  placeholder?: string;
  /** Offers an explicit way back to unset. Only an optional date has one. */
  clearable?: boolean;
  disabled?: boolean;
  className?: string;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `new Date('2026-08-12')` is UTC midnight, and every timezone west of
 * Greenwich renders that as the 11th. A date-only value carries no time and no
 * zone, so it is built at *local* midnight and never round-trips through UTC.
 * Returns null for anything the input can hold mid-edit but is not a date.
 */
export function localDateFromIso(value: string): Date | null {
  const match = ISO_DATE.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  const rolled =
    date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day;
  return rolled ? null : date;
}

/** Today, in the `YYYY-MM-DD` shape the field holds. */
export function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The instant a date field's value means: **today means now, another day
 * means that day's local midnight** (SC-612).
 *
 * ## Why today is not midnight
 *
 * A field pre-filled with today and left alone is not a claim about the start
 * of the day — it is the absence of a claim, and the truth it approximates is
 * "now". Sending midnight instead back-dates by however much of the day has
 * passed, and east of UTC that instant is the PREVIOUS UTC day. Measured on a
 * dev stack 2026-08-25 on a UTC+12 box: an edit made at 18:44 local sent
 * `2026-08-24T12:00:00Z`, eighteen hours and forty-four minutes early.
 *
 * That is not a cosmetic date. A flow's instant decides which
 * `(previous observation, this observation]` interval it belongs to, and a
 * holding whose APY payout writes an observation every morning always has one
 * from earlier today — so the back-dated row lands in the interval BEFORE the
 * one it was written to explain. Measured in
 * `UpdateHoldingUseCase.test.ts`: with the previous observation 12h old the
 * mis-dated flow manufactures a second balance-gap prompt, and with it 72h old
 * — nothing else changed — that prompt disappears.
 *
 * ## Why a deliberately chosen day is still midnight
 *
 * Somebody who picks the 14th means their 14th, and no better instant exists.
 * `localDateFromIso` is what keeps that from drifting a day west of Greenwich.
 * Nothing here clamps: a person who genuinely says "three weeks ago" gets
 * three weeks ago.
 */
export function dateFieldInstant(value: string): string {
  if (value === todayIso()) return new Date().toISOString();
  return (localDateFromIso(value) ?? new Date()).toISOString();
}

export function DateField({
  id,
  value,
  onChange,
  placeholder,
  clearable = false,
  disabled = false,
  className,
}: DateFieldProps) {
  const { t } = useTranslation();
  const picked = localDateFromIso(value);
  const showClear = clearable && value !== '' && !disabled;

  return (
    <div
      className={cn(
        'relative flex h-11 w-full min-w-0 items-center gap-2 overflow-hidden rounded-md border border-input bg-background px-3',
        'focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background',
        disabled && 'cursor-not-allowed opacity-50',
        className
      )}
    >
      <input
        id={id}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className={cn(
          'peer absolute inset-0 h-full w-full appearance-none bg-transparent px-3 text-body opacity-0 outline-none',
          'focus:opacity-100 [&::-webkit-date-and-time-value]:text-left'
        )}
      />
      <span
        aria-hidden
        className={cn(
          'pointer-events-none min-w-0 flex-1 truncate text-body peer-focus:opacity-0',
          picked ? 'text-foreground' : 'text-muted-foreground'
        )}
      >
        {picked ? formatDate(picked) : (placeholder ?? t('v3.form.dateField.placeholder'))}
      </span>
      {showClear ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={t('v3.form.dateField.clear')}
          className="relative z-10 shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
