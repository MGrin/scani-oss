import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Sheet } from '@scani/ui/ui/sheet';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { PeekBody, PeekHeader } from '@scani/ui/v3/components/PeekSheet';
import type { PeekSpec } from '@scani/ui/v3/lib/peek';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * `PeekSheet` itself renders nothing under `renderToStaticMarkup`: it is a
 * Radix portal, and Radix's `Portal` returns null until it has mounted. So the
 * two halves it composes are exported and tested here — which is also the
 * split the ticket is about, `PeekHeader` being what has to be readable at the
 * sheet's ~50% rest height and `PeekBody` being what dragging up reveals.
 *
 * The `<Sheet open>` wrapper is Radix's dialog context, which `SheetTitle`,
 * `SheetDescription` and the close button all read. It renders no DOM of its
 * own — nothing below is markup the wrapper contributed.
 */
function render(node: ReactElement): string {
  return renderToStaticMarkup(<Sheet open>{node}</Sheet>);
}

/** The drawer half of `PeekSheet` is a Radix portal, so the only place its
 *  chrome can be asserted on is the source. */
const PEEK_SOURCE = await Bun.file(
  join(import.meta.dir, '../../../src/v3/components/PeekSheet.tsx')
).text();

const SPEC: PeekSpec = {
  title: 'wstETH',
  subtitle: 'Wrapped Staked Ether · Kraken',
  value: <Numeric value={15_974.71} currency="USD" />,
  delta: <Numeric value={11.9} format="percent" delta indicator="sign" />,
  actions: <button type="button">Refresh price</button>,
  primary: [
    { label: 'Units', value: <Numeric value={4.6012} format="plain" /> },
    { label: 'Price', value: <Numeric value={3471.88} currency="USD" /> },
  ],
  sections: [
    {
      title: 'Source',
      facts: [
        { label: 'Account', value: 'Kraken · Main' },
        { label: 'Last priced', value: '14 minutes ago' },
      ],
    },
  ],
};

describe('PeekHeader — what survives at the 50% rest height', () => {
  test('carries the identity, the figure and the actions', () => {
    const html = render(<PeekHeader spec={SPEC} />);
    expect(html).toInclude('wstETH');
    expect(html).toInclude('Wrapped Staked Ether · Kraken');
    expect(html).toInclude('15,974.71');
    expect(html).toInclude('11.9');
    expect(html).toInclude('Refresh price');
  });

  // The whole point of the split: these live in the drawer's fixed header, so
  // they are on screen at every snap point rather than only when the sheet is
  // dragged up.
  test('carries none of the depth', () => {
    const html = render(<PeekHeader spec={SPEC} />);
    expect(html).not.toInclude('Last priced');
    expect(html).not.toInclude('Source');
  });

  test('the figure is set at display size, which is the sheet’s one hero', () => {
    expect(render(<PeekHeader spec={SPEC} />)).toInclude('text-display');
  });

  test('a long identity truncates rather than growing the header', () => {
    const html = render(
      <PeekHeader
        spec={{ ...SPEC, title: 'Wrapped Staked Ether held in the long-term staking position' }}
      />
    );
    expect(html).toInclude('truncate');
    // `truncate` only truncates inside a flex child that is allowed to be
    // narrower than its content.
    expect(html).toInclude('min-w-0');
  });

  // Both shells already draw a close of their own — the desktop `Sheet`
  // always has, and `BottomDrawer` gained one beside the grab handle in the
  // SC-39 safe-area fix. The header adding a second put two × icons on every
  // phone peek (SC-53). The shell's is the one that survives: it is first in
  // the DOM for Tab and VoiceOver, it is what a dismissing drag clicks, and
  // it is there at every snap point.
  test('the header draws no close of its own, in either shell', () => {
    expect(render(<PeekHeader spec={SPEC} />)).not.toInclude('aria-label="Close"');
    expect(PEEK_SOURCE).not.toContain('BottomDrawerClose');
  });

  test('describes itself even when the record has no subtitle', () => {
    const html = render(<PeekHeader spec={{ title: 'CASH', primary: [] }} />);
    expect(html).toInclude('sr-only');
  });
});

describe('PeekBody — the depth', () => {
  test('primary facts come before the titled sections', () => {
    const html = render(<PeekBody spec={SPEC} />);
    expect(html.indexOf('Units')).toBeGreaterThan(-1);
    expect(html.indexOf('Units')).toBeLessThan(html.indexOf('Source'));
    expect(html.indexOf('Source')).toBeLessThan(html.indexOf('Account'));
  });

  test('facts are a definition list, so the label and its value are paired', () => {
    const html = render(<PeekBody spec={SPEC} />);
    expect(html).toInclude('<dl');
    expect(html).toInclude('<dt');
    expect(html).toInclude('<dd');
  });

  // A wallet address is the reason someone opened the sheet. Truncating it
  // would make the detail view the one place the detail is not.
  test('a long value wraps rather than truncating', () => {
    const html = render(
      <PeekBody
        spec={{
          title: 'x',
          primary: [{ label: 'Identifier', value: '0x7f2c9a4b1d8e6f30a2c5b7e9d1f4a68c0b3e5d72' }],
        }}
      />
    );
    expect(html).toInclude('0x7f2c9a4b1d8e6f30a2c5b7e9d1f4a68c0b3e5d72');
    expect(html).toInclude('break-words');
    expect(html).not.toInclude('truncate');
  });

  test('a record with nothing but primary facts renders no empty section', () => {
    const html = render(
      <PeekBody spec={{ title: 'CASH', primary: [{ label: 'A', value: '1' }] }} />
    );
    expect(html).toInclude('A');
    expect(html).not.toInclude('<h3');
  });
});
