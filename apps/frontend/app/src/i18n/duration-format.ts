import type { i18n as I18n } from 'i18next';

/** The units a server-produced duration may name (SC-434). */
const DURATION_UNITS = new Set(['year', 'month', 'day']);

/**
 * `{{durationCount, duration}}` — a span of time in the reader's language,
 * from CLDR rather than from translation keys (SC-434).
 *
 * A job warning saying a provider "reaches 5 years back and no further" is
 * produced on a server that holds no reader's language, so it travels as a
 * count and a unit and is worded here. Written as keyed sentences instead —
 * one stem per unit, each with the `_one` / `_few` / `_many` variants its
 * language needs — it would be a hand-written table of plural forms in every
 * language we ship and every language we have not written yet.
 * `Intl.NumberFormat` already holds that table: measured across our eight
 * locales it gives `5 лет`, `1 год` and `2 месяца`, agreement that a single
 * `_other` key does not get right. SC-411 deleted a hand-written
 * currency-name table for the same reason.
 *
 * The unit arrives as a sibling param rather than as a literal in the format
 * spec because it varies per provider — five years for one, thirty days for
 * another — so it cannot be written into the locale file.
 *
 * An unrecognised unit renders the bare number. A warning that reads a little
 * thin is a better failure than one that throws inside a render, and this
 * runs on the screen someone opens when their import has already gone wrong.
 *
 * It lives in its own module because two callers register it — the app at
 * boot and `tests/i18n-preload.ts` — and that preload cannot import
 * `src/i18n/index.ts` at all: that module discovers locales with
 * `import.meta.glob`, a Vite build-time API that is `undefined` under
 * `bun test`. Mirroring the registration in both would be one more thing to
 * keep in step, and the drift would show up as a raw `{{…}}` on screen.
 */
export function registerDurationFormatter(i18n: I18n): void {
  i18n.services.formatter?.add('duration', (value, lng, options) => {
    const unit = (options as { durationUnit?: unknown } | undefined)?.durationUnit;
    const count = Number(value);
    if (typeof unit !== 'string' || !DURATION_UNITS.has(unit) || !Number.isFinite(count)) {
      return String(value);
    }
    return new Intl.NumberFormat(lng || 'en', {
      style: 'unit',
      unit,
      unitDisplay: 'long',
    }).format(count);
  });
}
