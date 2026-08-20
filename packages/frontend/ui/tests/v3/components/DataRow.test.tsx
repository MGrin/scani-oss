import { describe, expect, test } from 'bun:test';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// `StaticRouter`, not `MemoryRouter`: a linked row needs a router context, and
// the memory one floods server rendering with `useLayoutEffect` warnings.
import { StaticRouter } from 'react-router-dom/server';

function renderRow(element: ReactElement) {
  return renderToStaticMarkup(
    <StaticRouter location="/">
      <DataRowList>{element}</DataRowList>
    </StaticRouter>
  );
}

describe('DataRow — the three zones', () => {
  test('renders identity, value and delta in that order', () => {
    const html = renderRow(
      <DataRow label="Bitcoin" sublabel="Kraken · 0.42 BTC" value="$18,204.55" delta="+2.1%" />
    );
    expect(html.indexOf('Bitcoin')).toBeLessThan(html.indexOf('$18,204.55'));
    expect(html.indexOf('$18,204.55')).toBeLessThan(html.indexOf('+2.1%'));
  });

  test('identity is the zone that gives way', () => {
    const html = renderRow(<DataRow label="A very long token name" value="$1.00" />);
    expect(html).toInclude('min-w-0');
    expect(html).toInclude('truncate');
  });

  // A truncated figure is worse than no figure, so the value zone is nowrap and
  // never carries `truncate` — the identity column absorbs the shortfall.
  test('the value zone never truncates', () => {
    const html = renderRow(
      <DataRow label="Bitcoin" sublabel="Kraken" value="$18,204,550.55" delta="−$1,204.00" />
    );
    expect(html).toInclude('whitespace-nowrap');
    // Exactly the two identity lines carry it, and nothing in the value zone.
    expect(html.match(/truncate/g)).toHaveLength(2);
  });

  test('the delta zone is omitted entirely when there is no delta', () => {
    const html = renderRow(<DataRow label="Cash" value="$500.00" />);
    expect(html).not.toInclude('text-caption');
  });

  test('the sublabel is optional', () => {
    const html = renderRow(<DataRow label="Cash" value="$500.00" />);
    expect(html.match(/truncate/g)).toHaveLength(1);
  });
});

/**
 * SC-200. Reported from a phone: every data-quality row whose label ran past
 * the viewport lost its ending, and the ending is where the meaning is —
 * "Shown positions with no recent pri…", "An import that did not reach back
 * bef…". A clipped name is still recognisable and `TruncatedText` hands the
 * rest back on hover; a clipped sentence is neither, and on a phone there is
 * no hover at all.
 */
describe('DataRow — wrapIdentity', () => {
  test('the identity zone wraps instead of clipping', () => {
    const html = renderRow(
      <DataRow wrapIdentity label="Shown positions with no recent price" value="3" />
    );
    expect(html).not.toInclude('truncate');
    expect(html).toInclude('text-pretty');
  });

  test('both identity lines wrap, not just the label', () => {
    // The hint is the half that carried the duplicate-token chips, where a
    // Cyrillic lookalike of USDC would be (SC-197).
    const html = renderRow(
      <DataRow
        wrapIdentity
        label="Duplicate token rows"
        sublabel="DOG×3, USDC×3, WETH×3"
        value="11"
      />
    );
    expect(html).not.toInclude('truncate');
    expect(html.match(/text-pretty/g)).toHaveLength(2);
  });

  test('the value zone still never gives way — the row contract is unchanged', () => {
    const html = renderRow(
      <DataRow wrapIdentity label="Negative synthesised opening balance" value="$18,204,550.55" />
    );
    expect(html).toInclude('whitespace-nowrap');
  });

  test('the figure sits at the top of a wrapped identity, not floating in its middle', () => {
    const html = renderRow(
      <DataRow wrapIdentity label="A sentence long enough to wrap" value="7" />
    );
    expect(html).toInclude('self-start');
  });

  test('opt-in: clipping stays the default, because it is right for a list of names', () => {
    // The regression that would matter most — holdings, vendors and accounts
    // all rely on the identity column giving way by width.
    const html = renderRow(
      <DataRow label="Orbital Systems Ltd" sublabel="JPMorgan Chase" value="$1" />
    );
    expect(html.match(/truncate/g)).toHaveLength(2);
    expect(html).not.toInclude('text-pretty');
    expect(html).not.toInclude('self-start');
  });
});

describe('DataRow — the grid', () => {
  // An `auto` leading track that renders empty still pays the gap between it
  // and the identity, which is 12px of dead space on every row of a list that
  // has no icons.
  test('the leading track only exists when there is something in it', () => {
    expect(renderRow(<DataRow label="Cash" value="$1.00" />)).toInclude(
      'grid-cols-[minmax(0,1fr)_auto]'
    );
    expect(renderRow(<DataRow label="Cash" value="$1.00" leading={<span>icon</span>} />)).toInclude(
      'grid-cols-[auto_minmax(0,1fr)_auto]'
    );
  });

  // V3-23 neutralised the unscoped 44px `min-height` inside v3 and re-applies
  // it behind `pointer: coarse`. A `min-h-*` utility here would land in
  // `@layer utilities` and beat that base-layer rule, making every row 44px on
  // a mouse too — which is the row-height inflation V3-23 exists to undo. The
  // 44px comes from the token layer matching the `button`, not from this file.
  test('no row hardcodes a height, so the pointer-coarse rule stays in charge', () => {
    expect(renderRow(<DataRow label="Cash" value="$1.00" />)).not.toInclude('min-h-');
    expect(renderRow(<DataRow label="Cash" value="$1.00" onClick={() => {}} />)).not.toInclude(
      'min-h-'
    );
  });
});

describe('DataRow — interaction', () => {
  test('a row with no handler is not a control', () => {
    const html = renderRow(<DataRow label="Cash" value="$1.00" />);
    expect(html).not.toInclude('<button');
  });

  test('a tappable row is one button covering the whole row', () => {
    const html = renderRow(<DataRow label="Cash" value="$1.00" onClick={() => {}} />);
    expect(html).toInclude('<button type="button"');
    expect(html).toInclude('w-full');
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  test('a tappable row ships hover, active and focus-visible states', () => {
    const html = renderRow(<DataRow label="Cash" value="$1.00" onClick={() => {}} />);
    // `--surface-hover`, not `--surface-2`: the latter is pure white in the
    // V3-23 light theme, so a hover fill built on it would be invisible.
    expect(html).toInclude('hover:bg-surface-hover');
    expect(html).toInclude('active:bg-surface-hover');
    expect(html).not.toInclude('bg-surface-2');
    expect(html).toInclude('focus-visible:ring-2');
  });

  /**
   * A row whose record has a URL is a link, not a button that calls
   * `navigate()` (SC-74). Both are keyboard-reachable and both take the same
   * focus ring; what only the link gives is the URL — hover preview, open in a
   * new tab, copy, middle click — and the "link" role a screen reader reads out.
   */
  test('a row with a destination is a link, and it looks and behaves like the button', () => {
    const html = renderRow(<DataRow label="Emergency fund" value="$1.00" href="/vaults/v1" />);
    expect(html).toInclude('<a');
    expect(html).toInclude('href="/vaults/v1"');
    expect(html).not.toInclude('<button');
    expect(html).toInclude('hover:bg-surface-hover');
    expect(html).toInclude('focus-visible:ring-2');
    expect(html).toInclude('focus-visible:ring-inset');
  });

  // The floor comes from the token layer matching `a[href]` under
  // `pointer: coarse` (V3-23), which a `min-h-*` utility would beat — putting
  // 44px on every row on a mouse too.
  test('a linked row hardcodes no height either', () => {
    expect(renderRow(<DataRow label="Cash" value="$1.00" href="/vaults/v1" />)).not.toInclude(
      'min-h-'
    );
  });

  test('the destination wins over a handler, so a row can never be both', () => {
    const html = renderRow(
      <DataRow label="Cash" value="$1.00" href="/vaults/v1" onClick={() => {}} />
    );
    expect(html).not.toInclude('<button');
  });

  test('accepts an accessible name for when the label is not a plain string', () => {
    const html = renderRow(
      <DataRow
        label={<strong>BTC</strong>}
        value="$1.00"
        onClick={() => {}}
        aria-label="Bitcoin, $1.00"
      />
    );
    expect(html).toInclude('aria-label="Bitcoin, $1.00"');
  });
});

describe('DataRowList', () => {
  // §4.3: a run of 200 rows is one surface with 199 rules in it — no card per
  // row, no gap per row, no shadow.
  test('owns the hairlines so no row draws its own edge', () => {
    const html = renderToStaticMarkup(
      <DataRowList>
        <DataRow label="A" value="$1.00" />
        <DataRow label="B" value="$2.00" />
      </DataRowList>
    );
    // Full-strength `--border`: since V3-23 that token is the decorative
    // hairline, and `--border-strong` is the one for control edges.
    expect(html).toInclude('divide-y divide-border');
    expect(html).not.toInclude('divide-border/');
    expect(html).not.toInclude('shadow');
    expect(html).not.toInclude('rounded');
  });

  test('rows are list items of the list', () => {
    const html = renderToStaticMarkup(
      <DataRowList aria-label="Holdings">
        <DataRow label="A" value="$1.00" />
      </DataRowList>
    );
    expect(html).toStartWith('<ul');
    expect(html).toInclude('aria-label="Holdings"');
    expect(html).toInclude('<li>');
  });
});

describe('DataRow with Numeric — the composition the list surface uses', () => {
  test('a holding row reads as identity, value, delta', () => {
    const html = renderRow(
      <DataRow
        label="Bitcoin"
        sublabel="Kraken"
        value={<Numeric value={18204.55} currency="USD" />}
        delta={<Numeric value={-421.3} currency="USD" delta indicator="sign" />}
        onClick={() => {}}
      />
    );
    expect(html).toInclude('$18,204.55');
    expect(html).toInclude('text-loss');
    expect(html).toInclude('−$421.30');
    expect(html).toInclude('tabular-nums');
  });
});
