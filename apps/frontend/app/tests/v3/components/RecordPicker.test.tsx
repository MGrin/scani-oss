import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RECORD_PICKER_MAX_ROWS, RecordPicker } from '../../../src/v3/components/form/RecordPicker';

/**
 * The list says when it continues (SC-862).
 *
 * Four fields each held their own `.slice(0, 20)` and none of them said
 * anything, so a reader with twenty-one accounts saw twenty and a screen
 * indistinguishable from one showing every account there is. The twenty-first
 * was reachable only by guessing that typing more would help.
 *
 * The cap is not the defect and is not removed — five hundred rows in a
 * dropdown is a worse screen. The SILENCE is the defect, so what is asserted
 * here is that the cut announces itself and says what to do about it.
 *
 * Every assertion below has its opposite beside it: a footer that always
 * rendered would pass the first test and prove nothing, so the short-list case
 * is what shows the check can come back the other way.
 */

function html(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

function options(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `id-${index}`,
    label: `Account ${index}`,
  }));
}

function picker(count: number, maxRows?: number): string {
  return html(
    <RecordPicker
      value={null}
      onSelect={() => {}}
      onClear={() => {}}
      query=""
      onQueryChange={() => {}}
      open
      onOpenChange={() => {}}
      options={options(count)}
      maxRows={maxRows}
      ariaLabel="account"
      placeholder="Search accounts"
      emptyLabel="No account by that name"
    />
  );
}

describe('a capped list says so', () => {
  const overflowing = picker(RECORD_PICKER_MAX_ROWS + 5);

  test('the rows it can show are shown', () => {
    expect(overflowing).toInclude(`Account ${RECORD_PICKER_MAX_ROWS - 1}`);
  });

  test('the rows past the cap are not, which is what makes the count worth printing', () => {
    expect(overflowing).not.toInclude(`Account ${RECORD_PICKER_MAX_ROWS}`);
  });

  test('and it says how many of how many — both numbers, not just that there are more', () => {
    expect(overflowing).toInclude(
      `Showing ${RECORD_PICKER_MAX_ROWS} of ${RECORD_PICKER_MAX_ROWS + 5}`
    );
  });

  test('it says what to do about it, because the way past the cap is a narrower query', () => {
    expect(overflowing).toInclude('keep typing to narrow');
  });

  /**
   * The control. A list that fits says nothing at all — otherwise every
   * assertion above passes on a footer that is simply always there, and the
   * check could never come back red.
   */
  test('a list that fits says nothing', () => {
    const short = picker(3);
    expect(short).toInclude('Account 2');
    expect(short).not.toInclude('keep typing to narrow');
    expect(short).not.toInclude('Showing');
  });
});

/**
 * `FiatCurrencyField` is scrolled, not narrowed — 69 seeded currencies, and
 * somebody choosing a base currency often knows "Swiss Franc" and not `CHF`.
 * Capping it would be a design change wearing a bug fix, so it opts out.
 *
 * An uncapped list cannot produce the defect the cap announces: a list showing
 * everything is not short about it, so there is nothing to say and it says
 * nothing.
 */
describe('a field that may not be cut opts out', () => {
  const uncapped = picker(RECORD_PICKER_MAX_ROWS + 5, Number.POSITIVE_INFINITY);

  test('every row is rendered, including the ones past the shared cap', () => {
    expect(uncapped).toInclude(`Account ${RECORD_PICKER_MAX_ROWS + 4}`);
  });

  test('and it says nothing, because nothing was withheld', () => {
    expect(uncapped).not.toInclude('keep typing to narrow');
  });
});

/**
 * The list announces itself (SC-999).
 *
 * Typing into the institution field made `Add "Kraken"` appear with nothing
 * written to any live region, so a screen-reader user had no way to know the
 * create row existed. The region is read out of the markup by its attributes,
 * and each case that must speak has a case beside it that must stay silent — a
 * region that always held text would pass the first and prove nothing.
 */
describe('the picker tells a screen reader what appeared', () => {
  function announced(props: Partial<Parameters<typeof RecordPicker>[0]>): string {
    const markup = html(
      <RecordPicker
        value={null}
        onSelect={() => {}}
        onClear={() => {}}
        query="Kraken"
        onQueryChange={() => {}}
        open
        onOpenChange={() => {}}
        options={[]}
        ariaLabel="institution"
        placeholder="Search institutions"
        emptyLabel="No institution by that name"
        createLabel={(q) => `Add "${q}"`}
        onCreate={() => {}}
        {...props}
      />
    );
    const m = markup.match(/<p role="status" aria-live="polite" class="sr-only">([^<]*)<\/p>/);
    if (!m) throw new Error('the live region is not in the markup at all');
    return (m[1] as string).replaceAll('&quot;', '"');
  }

  test('no match: the empty state and the create row are both announced', () => {
    expect(announced({})).toBe('No institution by that name. Add "Kraken"');
  });

  test('a label that already ends its sentence is not given a second full stop', () => {
    // Found in the browser, not by the case above: the real empty label is
    // "Nothing by that name yet." and the first join announced "yet.." (SC-999).
    expect(announced({ emptyLabel: 'Nothing by that name yet.' })).toBe(
      'Nothing by that name yet. Add "Kraken"'
    );
  });

  test('matches are counted, and the create row still follows them', () => {
    expect(announced({ options: options(2) })).toBe('2 matches. Add "Kraken"');
    expect(announced({ options: options(1), createLabel: undefined, onCreate: undefined })).toBe(
      '1 match'
    );
  });

  test('a near-duplicate is announced instead of the empty state it contradicts', () => {
    expect(announced({ suggestions: options(1) })).toBe('1 similar record. Add "Kraken"');
  });

  test('the region is mounted but silent while closed, loading or untyped', () => {
    expect(announced({ open: false })).toBe('');
    expect(announced({ isLoading: true })).toBe('');
    expect(announced({ query: '   ' })).toBe('');
  });
});
