import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type OwnershipBucket,
  OwnershipTotals,
} from '../../../src/v3/components/ownership/OwnershipTotals';

/**
 * The ownership boundary, asserted on the figures a person actually reads
 * (SC-463).
 *
 * The invariant is `entity A + entity B + unassigned === combined`, and the
 * two ways to break it — per-entity totals that double-count, a combined view
 * that under-reports — are both silent. So these assertions parse the money
 * back out of the rendered markup rather than reading the props: a repository
 * that is right and a screen that drops a bucket produce the same passing test
 * if you assert one step short of the pixels.
 */

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(node);
}

/**
 * The figure at a testid, as displayed — `$4,200.55`. Throws rather than
 * returning null when the row is absent, because a missing bucket is the
 * failure this file exists to catch and `undefined` would quietly sum as
 * nothing.
 */
function displayed(html: string, testid: string): string {
  const match = html.match(new RegExp(`data-testid="${testid}"[^>]*>(?:<[^>]+>)*([^<]+)`));
  if (!match?.[1]) throw new Error(`no figure rendered at data-testid="${testid}"`);
  return match[1];
}

/** `$4,200.55` -> 4200.55. The screen's own string, read the way a person reads it. */
function asNumber(figure: string): number {
  return Number(figure.replace(/[^0-9.-]/g, ''));
}

const BUCKETS: OwnershipBucket[] = [
  {
    entityId: 'e-personal',
    name: 'Personal',
    value: '600',
    holdingsCounted: 1,
    unpricedSymbols: [],
  },
  {
    entityId: 'e-company',
    name: 'My Company Ltd',
    value: '4200.55',
    holdingsCounted: 1,
    unpricedSymbols: [],
  },
  {
    entityId: 'unassigned',
    name: 'Unassigned',
    value: '108.2',
    holdingsCounted: 1,
    unpricedSymbols: [],
  },
];

describe('OwnershipTotals — the figures on the screen', () => {
  /**
   * The whole ticket, on the rendered numbers. A holding in each set of books,
   * and what the screen shows for the two has to come to what it shows for the
   * combined view.
   */
  test('entity A + entity B + unassigned equals the combined figure, as displayed', () => {
    const html = render(
      <OwnershipTotals buckets={BUCKETS} totalValue="4908.75" baseCurrency="USD" />
    );

    // The exact strings, so a formatting change that drops the cents is a
    // failure rather than something the arithmetic below rounds away.
    expect(displayed(html, 'ownership-value-e-personal')).toBe('$600.00');
    expect(displayed(html, 'ownership-value-e-company')).toBe('$4,200.55');
    expect(displayed(html, 'ownership-value-unassigned')).toBe('$108.20');
    expect(displayed(html, 'ownership-value-combined')).toBe('$4,908.75');

    const parts =
      asNumber(displayed(html, 'ownership-value-e-personal')) +
      asNumber(displayed(html, 'ownership-value-e-company')) +
      asNumber(displayed(html, 'ownership-value-unassigned'));

    expect(parts).toBeCloseTo(asNumber(displayed(html, 'ownership-value-combined')), 2);
  });

  /**
   * The component must not repair a disagreement it is handed.
   *
   * If it summed the rows to produce the combined figure, this screen would be
   * self-consistent by construction — and the one job it has is to be the
   * place where a real disagreement between the parts and the whole becomes
   * visible. A test that only ever feeds it consistent input could never tell
   * the two implementations apart, so this feeds it inconsistent input on
   * purpose and requires the inconsistency to survive to the screen.
   */
  test('renders the combined figure it was given, so a mismatch is visible rather than repaired', () => {
    const html = render(
      // Parts come to 4908.75; the server says 9999.99. A real one of these
      // would be a bug somewhere else, and this screen has to show it.
      <OwnershipTotals buckets={BUCKETS} totalValue="9999.99" baseCurrency="USD" />
    );

    expect(displayed(html, 'ownership-value-combined')).toBe('$9,999.99');
  });

  /**
   * The unassigned row is rendered at zero rather than hidden. Hiding an empty
   * bucket would mean the moment it stops being empty — an account arriving
   * from a new import, outside both boundaries — is the moment a row appears
   * that nobody was watching for.
   */
  test('shows the unassigned bucket even when it holds nothing', () => {
    const html = render(
      <OwnershipTotals
        buckets={[
          {
            entityId: 'e-personal',
            name: 'Personal',
            value: '600',
            holdingsCounted: 1,
            unpricedSymbols: [],
          },
          {
            entityId: 'unassigned',
            name: 'Unassigned',
            value: '0',
            holdingsCounted: 0,
            unpricedSymbols: [],
          },
        ]}
        totalValue="600"
        baseCurrency="USD"
      />
    );

    expect(displayed(html, 'ownership-value-unassigned')).toBe('$0.00');
  });

  /** An unpriceable position is unknown, not zero, and the row has to say so
   *  beside its own total — otherwise a boundary silently understates. */
  test('names an unpriceable symbol beside the boundary it belongs to', () => {
    const html = render(
      <OwnershipTotals
        buckets={[
          {
            entityId: 'e-company',
            name: 'My Company Ltd',
            value: '100',
            holdingsCounted: 1,
            unpricedSymbols: ['MYSTERY'],
          },
        ]}
        totalValue="100"
        baseCurrency="USD"
      />
    );

    expect(html).toContain('MYSTERY');
  });
});
