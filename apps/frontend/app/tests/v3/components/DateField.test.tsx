import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { formatDate } from '@scani/shared';
import { Glob } from 'bun';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DateField,
  dateFieldInstant,
  localDateFromIso,
  todayIso,
} from '../../../src/v3/components/form/DateField';

/**
 * The three defects this field exists to fix are each invisible to a type
 * check and two of them are invisible on a desktop browser, so they are
 * asserted on the markup: the native control must be out of flow, the value
 * must come from `formatDate` rather than the platform, and nothing may be
 * centred.
 */
function render(props: Partial<Parameters<typeof DateField>[0]> = {}): string {
  return renderToStaticMarkup(
    <DateField id="d" value="2026-08-12" onChange={() => {}} {...props} />
  );
}

describe('localDateFromIso', () => {
  test('builds local midnight, so no timezone can move the day', () => {
    const date = localDateFromIso('2026-08-12');
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(7);
    expect(date?.getDate()).toBe(12);
  });

  test('rejects what the input can hold mid-edit but is not a date', () => {
    expect(localDateFromIso('')).toBeNull();
    expect(localDateFromIso('2026-08')).toBeNull();
    expect(localDateFromIso('2026-13-01')).toBeNull();
    expect(localDateFromIso('2026-02-30')).toBeNull();
  });
});

describe('dateFieldInstant — what an untouched field means (SC-612)', () => {
  /**
   * The failure is timezone-shaped and the runner is not in the timezone that
   * shows it: `bun test` runs in UTC while the app runs in the host's zone.
   * Measured 2026-08-25, the same expression gave `2026-08-24T12:00Z` on a
   * UTC+12 dev stack and `2026-08-25T00:00Z` under this suite — so a test
   * written on a UTC string would assert where it ran. Both tests below
   * therefore assert the RULE, and neither names an absolute instant.
   */
  test('today is the moment of recording, not the start of the day', () => {
    const before = Date.now();
    const sent = new Date(dateFieldInstant(todayIso())).getTime();

    expect(sent).toBeGreaterThanOrEqual(before);
    expect(sent).toBeLessThanOrEqual(Date.now());
    // The must-be-ABSENT half, and the whole of the bug: it is not midnight.
    expect(sent).not.toBe(localDateFromIso(todayIso())?.getTime());
  });

  test('a deliberately chosen other day is that day’s LOCAL midnight', () => {
    // Local, not UTC: somebody who picks the 14th means their 14th, and
    // `new Date('2026-08-14')` is the 13th everywhere west of Greenwich.
    expect(dateFieldInstant('2026-08-14')).toBe(new Date(2026, 7, 14).toISOString());
  });

  test('a half-typed date falls back to now rather than to an Invalid Date', () => {
    // What the native input holds mid-edit. `new Date('2026-08T00:00:00')` is
    // `Invalid Date`, and `.toISOString()` on that THROWS — from an onClick,
    // which is an unhandled rejection in the render path.
    const sent = new Date(dateFieldInstant('2026-08')).getTime();
    expect(Number.isNaN(sent)).toBe(false);
  });
});

describe('the v3 date field', () => {
  test('shows the value through formatDate, not through the platform', () => {
    expect(render()).toContain(formatDate(new Date(2026, 7, 12)));
  });

  test('takes the native input out of flow, so it cannot size its container', () => {
    const markup = render();
    expect(markup).toContain('type="date"');
    expect(markup).toMatch(/class="[^"]*absolute inset-0[^"]*"/);
  });

  test('hides the native value at rest and reveals it on focus', () => {
    const markup = render();
    expect(markup).toMatch(/class="[^"]*opacity-0[^"]*focus:opacity-100/);
    expect(markup).toContain('peer-focus:opacity-0');
  });

  test('left-aligns both layers — iOS centres the native one', () => {
    const markup = render();
    expect(markup).toContain('[&amp;::-webkit-date-and-time-value]:text-left');
    expect(markup).not.toContain('text-center');
  });

  test('an unset optional date reads as empty, not as broken', () => {
    const markup = render({ value: '', placeholder: 'Never', clearable: true });
    expect(markup).toContain('Never');
    expect(markup).toContain('text-muted-foreground');
    // Nothing to clear when there is nothing set.
    expect(markup).not.toContain('Clear date');
  });

  test('offers a way back to unset once an optional date is set', () => {
    expect(render({ clearable: true })).toContain('Clear date');
    expect(render()).not.toContain('Clear date');
  });

  test('a disabled field offers no clear', () => {
    expect(render({ clearable: true, disabled: true })).not.toContain('Clear date');
  });
});

/**
 * The decision recorded in the brief is "everywhere a date is entered", and the
 * failure mode is a second form reaching for `type="date"` because it renders
 * fine on the laptop it was written on.
 */
test('no v3 file outside DateField enters a date natively', async () => {
  const root = join(import.meta.dir, '..', '..', '..', 'src', 'v3');
  const offenders: string[] = [];
  for await (const relative of new Glob('**/*.{ts,tsx}').scan(root)) {
    if (relative.endsWith('form/DateField.tsx')) continue;
    const source = await Bun.file(join(root, relative)).text();
    // Prose naming the attribute is how each of these fixes explains itself.
    const code = source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
    if (code.some((line) => /type=["']date["']/.test(line))) offenders.push(relative);
  }
  expect(offenders).toEqual([]);
});

/**
 * The sibling of `no v3 file outside DateField enters a date natively`, and it
 * exists for the same reason: two surfaces ask for a date, and a third will.
 *
 * `new Date(`${day}T00:00:00`)` is local midnight, which is the correct
 * conversion for a day somebody CHOSE and the wrong one for a field they never
 * touched — that is SC-612, and it shipped twice before anyone noticed once.
 * A file that writes the conversion itself has silently opted out of
 * `dateFieldInstant`'s rule, and nothing else in the build would say so: the
 * form renders identically, the types agree, and the wrong number appears in
 * a ledger a day later.
 */
test('no v3 file outside DateField converts a day to an instant itself', async () => {
  const root = join(import.meta.dir, '..', '..', '..', 'src', 'v3');
  const midnightLiteral = /T00:00:00(?!Z)/;
  // Must-be-FOUND: the probe can see the expression it is looking for. Without
  // this an empty list means "clean" and "the regex matches nothing" alike.
  expect(midnightLiteral.test('new Date(day + "T00:00:00")')).toBe(true);
  // Must-be-ABSENT: an explicit UTC instant in a fixture is not this defect.
  expect(midnightLiteral.test("'2026-08-14T00:00:00Z'")).toBe(false);

  const offenders: string[] = [];
  let scanned = 0;
  for await (const relative of new Glob('**/*.{ts,tsx}').scan(root)) {
    scanned += 1;
    const source = await Bun.file(join(root, relative)).text();
    const code = source.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
    if (code.some((line) => midnightLiteral.test(line))) offenders.push(relative);
  }
  expect(scanned).toBeGreaterThan(100);
  expect(offenders).toEqual([]);
});
