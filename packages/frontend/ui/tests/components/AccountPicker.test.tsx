import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountPicker, type AccountPickerOption } from '../../src/v3/components/AccountPicker';

/**
 * The seven defects in SC-850's production screenshot, as assertions.
 *
 * Rendered with `renderToStaticMarkup` — the harness every component test in
 * this package uses. That covers the initial render, which is where six of the
 * seven live: what the rows say, what they omit, what order they arrive in and
 * whether the list admits it continues. It does NOT cover typing into the
 * search field, and nothing here pretends to; what search *matches* is
 * exercised by the shape of the options, not by a keystroke.
 */

function markup(props: Partial<Parameters<typeof AccountPicker>[0]> = {}): string {
  const options: AccountPickerOption[] = props.options ?? [
    {
      id: 'a',
      name: 'Airwallex',
      institution: 'Airwallex',
      subtitle: '1,201.50 USD · import_airwallex',
      group: 'Already holds USD',
    },
    {
      id: 'b',
      name: 'Bitcoin Network - bc1q5n8k3v',
      institution: 'Bitcoin Network',
      group: 'Your other accounts',
      groupHint: 'No USD tracked here yet — a holding will be created',
    },
  ];
  return renderToStaticMarkup(
    <AccountPicker
      options={options}
      value={props.value ?? null}
      onChange={() => {}}
      name="destination"
      legend="Where this money went"
      emptyLabel="You have no other account to move this to."
      {...props}
    />
  );
}

/** Rows in the order they appear, by their radio input's `value`-carrying id. */
function groupHeadingOrder(html: string): string[] {
  return [...html.matchAll(/class="text-label font-medium text-muted-foreground">([^<]*)</g)].map(
    (m) => m[1] ?? ''
  );
}

describe('AccountPicker', () => {
  test('never says the institution twice', () => {
    // `Airwallex · Airwallex` and `Bitcoin Network · Bitcoin Network -
    // bc1q5n…` are what concatenating the two fields produced in production.
    const html = markup();
    expect(html).not.toContain('Airwallex · Airwallex');
    expect(html).not.toContain('Bitcoin Network · Bitcoin Network');
    // …and the identifying half of the wallet name survives.
    expect(html).toContain('bc1q5n8k3v');
  });

  test('a row with no subtitle renders one line, not an empty second one', () => {
    // The screenshot had the SAME sentence under every row. A caller with
    // nothing row-specific to say passes no subtitle, and the row must not
    // reserve space for one — the reserved-but-empty line is what clipped the
    // sentences that did carry information.
    const html = markup();
    expect(html).toContain('1,201.50 USD · import_airwallex');
    expect(html.match(/text-caption text-muted-foreground">/g) ?? []).toHaveLength(
      // The one real subtitle, plus the one group hint. Not one per row.
      2
    );
  });

  test('renders groups in the caller order, never re-sorted', () => {
    // Caller order IS the relevance ranking. The picker sorting alphabetically
    // underneath a caller that ranked its options is the defect: production
    // offered an Airwallex fiat account above every Solana wallet for a SOL
    // transfer because `Airwallex` < `Solana`.
    expect(
      groupHeadingOrder(
        markup({
          options: [
            { id: 'z', name: 'Zephyr wallet', group: 'On the same network' },
            { id: 'a', name: 'Airwallex', group: 'Your other accounts' },
          ],
        })
      )
    ).toEqual(['On the same network', 'Your other accounts']);
  });

  test('interleaved rows of one group are gathered under its single heading', () => {
    const html = markup({
      options: [
        { id: '1', name: 'One', group: 'First' },
        { id: '2', name: 'Two', group: 'Second' },
        { id: '3', name: 'Three', group: 'First' },
      ],
    });
    expect(groupHeadingOrder(html)).toEqual(['First', 'Second']);
    // The regrouped row keeps its place under the heading it belongs to rather
    // than opening a second copy of it.
    expect(html.indexOf('Three')).toBeLessThan(html.indexOf('Two'));
  });

  test('says a repeated fact once, over the group, not on every row', () => {
    const html = markup();
    expect(html.match(/No USD tracked here yet/g) ?? []).toHaveLength(1);
  });

  test('a long list fades at its foot, so a cut row reads as "there is more"', () => {
    // The list scrolls inside a sheet with a sticky footer, and the last
    // visible row was being cut with no affordance saying anything followed.
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `${i}`, name: `Account ${i}` }));
    expect(markup({ options: many })).toContain('mask-image');
    // A list that fits needs no fade — a gradient over four rows would claim
    // there is more when there is not.
    expect(markup()).not.toContain('mask-image');
  });

  test('offers search once the list is long enough to scroll, and not before', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, name: `Account ${i}` }));
    expect(markup({ options: many })).toContain('type="search"');
    expect(markup()).not.toContain('type="search"');
  });

  test('the whole row is the radio, and the selected one is marked', () => {
    // A 20px dot beside the text is a mis-tap that changes where money went,
    // so the hit area is the `<label>` and the input is visually hidden.
    const html = markup({ value: 'a' });
    expect(html).toContain('type="radio"');
    expect(html).toContain('name="destination"');
    expect(html.match(/checked=""/g) ?? []).toHaveLength(1);
  });

  test('an empty list says so instead of rendering a bare fieldset', () => {
    expect(markup({ options: [] })).toContain('You have no other account to move this to.');
  });

  test('loading is a status, not an empty list that looks like "you have none"', () => {
    const html = markup({ isLoading: true, loadingLabel: 'Loading your accounts…' });
    expect(html).toContain('role="status"');
    expect(html).toContain('Loading your accounts…');
    expect(html).not.toContain('type="radio"');
  });

  test('renders real copy with no i18next provider anywhere (SC-250)', () => {
    // This package owns its own i18next instance. Three of the four consuming
    // apps have never initialised one, and a bare `useTranslation()` there
    // renders the key.
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `${i}`, name: `Account ${i}` }));
    const html = markup({ options: many });
    expect(html).not.toContain('ui.accountPicker');
    expect(html).toContain('Search accounts');
  });
});
