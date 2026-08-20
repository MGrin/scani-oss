import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { getQueryKey } from '@trpc/react-query';
import i18n from 'i18next';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { trpc } from '../../../src/lib/trpc';
import { DataQualitySettings } from '../../../src/v3/components/settings/DataQualitySettings';
import { DATA_QUALITY_KINDS } from '../../../src/v3/lib/dataQuality';
import type { DataQualityReport } from '../../../src/v3/lib/settings';

/**
 * SC-268, then SC-293. Every warning row said **"Look into this"** and not one
 * of them was a control — measured in a real browser at 393×852, the first
 * element child of all nine `<li>`s was a `DIV`. The panel instructed an
 * action and offered no way to take it, and on a phone tapping is the obvious
 * response.
 *
 * SC-268 removed the instruction, because no flagged row had a destination
 * that existed. SC-293 built the destinations: the report now returns the
 * holding IDS behind each flagged counter, so a row's number is the size of a
 * set and the row links to `/holdings?quality=<kind>`, which is that set.
 *
 * What has to stay true is the RULE, not the outcome of applying it once:
 *
 *  - a row is a link **iff** it is flagged and the server named a non-empty
 *    set for it. Both halves are tested, in both directions.
 *  - the delta zone still states a FINDING and never an instruction. "Flagged"
 *    survives; the affordance is the row being a link, not a sentence telling
 *    the reader to tap it.
 *  - a report with no `flagged` — an older API — links nothing at all, rather
 *    than pointing seven rows at a list that will come back empty.
 *
 * The panel is rendered for real, with the report seeded into the query cache
 * — SSR runs no effects, so an unseeded query would render the skeleton and
 * every assertion below would pass against a panel with no rows in it.
 */

/** Ids are opaque to this screen, so the fixture only has to make the LENGTHS
 *  right — the number a row shows is `flagged[kind].length`. */
function ids(n: number, prefix: string): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

function report(overrides: Partial<DataQualityReport> = {}): DataQualityReport {
  return {
    // Every counter over its threshold, so all seven flag at once. A report
    // with one flagged row would let a regression through on the other six.
    flagged: {
      duplicateSymbol: ids(2, 'dup'),
      lookalike: ids(1, 'look'),
      zeroBalance: ids(9, 'zero'),
      noRecentPrice: ids(4, 'unpriced'),
      noPriceSource: ids(1, 'nosource'),
      negativeOpening: ids(3, 'neg'),
      noCoverage: ids(5, 'nocov'),
    },
    duplicateTokens: [{ symbol: 'USDC', count: 2 }],
    unroutableTokens: [{ symbol: 'TRUMP', segment: null }],
    lookalikeTokens: [{ symbol: 'UЅDС', lookalikeOf: 'USDC' }],
    holdings: {
      visible: 42,
      total: 60,
      zeroVisible: 9,
      zeroVisibleStale: 2,
      unpricedVisible: 4,
      unpriceableVisible: 1,
      negativeOpening: 3,
      missingCoverage: 5,
    },
    thresholds: { staleClosedDays: 30 },
    ...overrides,
  } as DataQualityReport;
}

function Harness({ children, client }: { children: ReactNode; client: QueryClient }) {
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  return (
    <trpc.Provider client={trpcClient} queryClient={client}>
      <QueryClientProvider client={client}>
        <StaticRouter location="/settings">{children}</StaticRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

/** Just the rows. The legend names the marker too (SC-269), so a whole-panel
 *  assertion about the marker word can no longer distinguish the two. */
function rowsOf(html: string): string {
  return html.match(/<ul[^>]*>[\s\S]*<\/ul>/)?.[0] ?? '';
}

function renderPanel(data: DataQualityReport = report()): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(getQueryKey(trpc.portfolio.getDataQualityReport, undefined, 'query'), data);
  return renderToStaticMarkup(
    <Harness client={client}>
      <DataQualitySettings />
    </Harness>
  );
}

/** Every `href` the panel rendered, in row order. */
function hrefs(html: string): string[] {
  return [...rowsOf(html).matchAll(/href="([^"]+)"/g)].map((match) => match[1] as string);
}

const EMPTY_HOLDINGS: DataQualityReport['holdings'] = {
  visible: 42,
  total: 60,
  zeroVisible: 0,
  zeroVisibleStale: 0,
  unpricedVisible: 0,
  unpriceableVisible: 0,
  negativeOpening: 0,
  missingCoverage: 0,
};

describe('data-quality panel', () => {
  test('renders its rows (guards every assertion below)', () => {
    const html = renderPanel();
    // Without this the seeding could silently fail and leave the skeleton,
    // against which "contains no <a>" is trivially true.
    expect(html).toContain(i18n.t('v3.settings.dataQuality.duplicateRows'));
    expect(html).toContain(i18n.t('v3.settings.dataQuality.negativeOpening'));
  });

  test('flags the rows that are over threshold', () => {
    const html = renderPanel();
    const flag = i18n.t('v3.settings.dataQuality.flagged');
    // Seven, not the six the ticket listed: SC-271 added the lookalike row
    // after it was written. The literal count is the point — a row that stops
    // flagging is exactly the regression this panel exists to prevent.
    expect(rowsOf(html).split(flag).length - 1).toBe(7);
  });

  test('every flagged row links to the holdings behind it', () => {
    const html = renderPanel();
    // One link per flagged row, and each names a kind the filter understands.
    expect(hrefs(html)).toEqual(DATA_QUALITY_KINDS.map((kind) => `/holdings?quality=${kind}`));
  });

  test('a row the server named no set for is not a link', () => {
    // The two coverage counters arrive as bare numbers, the way every counter
    // did before SC-293. They still flag, and they still say Flagged — what
    // they must not do is point at a filter that would select nothing.
    const html = renderPanel(
      report({
        flagged: {
          duplicateSymbol: ids(2, 'dup'),
          lookalike: ids(1, 'look'),
          zeroBalance: ids(9, 'zero'),
          noRecentPrice: ids(4, 'unpriced'),
          noPriceSource: ids(1, 'nosource'),
        },
      })
    );
    const flag = i18n.t('v3.settings.dataQuality.flagged');
    expect(rowsOf(html).split(flag).length - 1).toBe(7);
    expect(hrefs(html)).not.toContain('/holdings?quality=negativeOpening');
    expect(hrefs(html)).not.toContain('/holdings?quality=noCoverage');
  });

  test('an API with no ids at all links nothing', () => {
    // The fallback SC-268 left behind, and it has to stay reachable: an inert
    // honest panel is better than seven links to empty lists.
    const html = renderPanel(report({ flagged: undefined }));
    expect(rowsOf(html)).toContain(i18n.t('v3.settings.dataQuality.flagged'));
    expect(hrefs(html)).toEqual([]);
  });

  test('an unflagged row is never a link, even when its set is named', () => {
    // "Zero-balance holdings still shown" warns above five. At four it is a
    // fact rather than a finding — the reader is told, and not sent anywhere.
    const html = renderPanel(
      report({
        flagged: { zeroBalance: ids(4, 'zero') },
        holdings: { ...EMPTY_HOLDINGS, zeroVisible: 4 },
        duplicateTokens: [],
        unroutableTokens: [],
        lookalikeTokens: [],
      })
    );
    expect(rowsOf(html)).toContain(i18n.t('v3.settings.dataQuality.zeroBalanceShown'));
    expect(hrefs(html)).toEqual([]);
  });

  test('does not instruct an action, it offers one', () => {
    const html = renderPanel();
    // The delta zone states a finding. These are the words that turn it back
    // into a command, which is what SC-268 removed and what a link makes
    // unnecessary rather than acceptable.
    for (const imperative of ['Look into this', 'Click', 'Tap', 'Fix ']) {
      expect(rowsOf(html)).not.toContain(imperative);
    }
    // And the affordance a row now really has.
    expect(rowsOf(html)).toContain('focus-visible:ring');
  });

  test('a linked row is named by where it goes', () => {
    const html = renderPanel();
    // The row's own content is a label, a figure and the word "Flagged" —
    // read out whole it never says following it opens the Holdings list.
    expect(rowsOf(html)).toContain(
      i18n.t('v3.settings.dataQuality.rowLink', {
        label: i18n.t('v3.settings.dataQuality.missingCoverage'),
        count: 5,
      })
    );
  });

  test('the legend names the marker by rendering it, not by restating it', () => {
    const html = renderPanel();
    const flag = i18n.t('v3.settings.dataQuality.flagged');

    // SC-269. The legend read "Anything in amber is worth looking into" while
    // v3 had no amber, and by the time anyone noticed it had outlived two
    // cues — the colour, then "Look into this". It survives now because it
    // interpolates the row's own key instead of repeating the word, so the
    // two cannot disagree.
    //
    // This asserts the OUTCOME, not the mechanism: the rendered legend
    // contains whatever the rows are currently marked with. Change the marker
    // and this stays green only if the sentence moved with it.
    const legend = html.match(/<p[^>]*>([^<]*)<\/p>/)?.[1] ?? '';
    expect(legend).toContain('Recounted on every visit');
    expect(legend).toContain(flag);

    // The claim it used to make, and the colour it named, are both gone.
    expect(html).not.toContain('amber');
  });

  test('a row with nothing over threshold carries no flag', () => {
    const html = renderPanel(
      report({
        flagged: {},
        duplicateTokens: [],
        unroutableTokens: [],
        lookalikeTokens: [],
        holdings: EMPTY_HOLDINGS,
      })
    );
    expect(html).toContain(i18n.t('v3.settings.dataQuality.duplicateRows'));
    expect(rowsOf(html)).not.toContain(i18n.t('v3.settings.dataQuality.flagged'));
    expect(hrefs(html)).toEqual([]);
  });
});
