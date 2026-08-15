import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { formatDate } from '@scani/shared';
import { Glob } from 'bun';
import { renderToStaticMarkup } from 'react-dom/server';
import { DateField, localDateFromIso } from '../../../src/v3/components/form/DateField';

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
