import '../../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WrapperGainsCard } from '../../../../src/v3/components/home/WrapperGainsBlock';
import en from '../../../../src/v3/i18n/locales/en.json';
import { toWrapperGainsView, type WrapperGainsSummary } from '../../../../src/v3/lib/wrapper-gains';

const BASE: WrapperGainsSummary = {
  status: 'ok',
  anyWrapped: true,
  carriedHoldings: 0,
  buckets: [
    { treatment: 'general', realized: '30', unrealized: '-10', accountCount: 1 },
    { treatment: 'deferred', realized: '0', unrealized: '0', accountCount: 0 },
    { treatment: 'exempt', realized: '150', unrealized: '40', accountCount: 2 },
    { treatment: 'advantaged', realized: '0', unrealized: '0', accountCount: 0 },
  ],
};

function render(summary: WrapperGainsSummary): string {
  const view = toWrapperGainsView(summary);
  if (!view) throw new Error('expected a view');
  return renderToStaticMarkup(<WrapperGainsCard view={view} currency="£" />);
}

describe('Gains by account wrapper on Home (SC-1645)', () => {
  test('a user with no wrapper anywhere gets no tile, not "100% General"', () => {
    expect(toWrapperGainsView({ ...BASE, anyWrapped: false })).toBeNull();
    expect(toWrapperGainsView(null)).toBeNull();
    expect(toWrapperGainsView(undefined)).toBeNull();
  });

  test("the peek lists wrapped buckets in the tile's order, General apart (design, bus #24476)", () => {
    const view = toWrapperGainsView(BASE);
    expect(view?.rows.map((row) => row.treatment)).toEqual(['exempt']);
    expect(view?.general?.total).toBe(20);
  });

  test('General comes last, under the note that the tile leaves it out', () => {
    const html = render(BASE);
    const note = html.indexOf(en.v3.wrappers.block.tileSums);
    expect(note).toBeGreaterThan(html.indexOf(en.v3.wrappers.bucket.exempt));
    expect(html.indexOf(`>${en.v3.wrappers.bucket.general}<`)).toBeGreaterThan(note);
  });

  test("the tile's figure is the gain inside wrapped accounts, General left out", () => {
    const view = toWrapperGainsView(BASE);
    expect(view?.wrappedGain).toBe(190);
    expect(view?.wrappedTreatments).toEqual(['exempt']);
  });

  test('the tile names the wrapped buckets largest first (design, bus #24473)', () => {
    const view = toWrapperGainsView({
      ...BASE,
      buckets:
        BASE.status === 'ok'
          ? BASE.buckets.map((b) =>
              b.treatment === 'deferred'
                ? { ...b, realized: '-500', unrealized: '0', accountCount: 1 }
                : b
            )
          : [],
    });
    expect(view?.wrappedTreatments).toEqual(['deferred', 'exempt']);
    expect(view?.rows.find((row) => row.treatment === 'exempt')?.total).toBe(190);
  });

  test('a figure never wraps away from its label or its sign', () => {
    const html = render(BASE);
    for (const label of [en.v3.wrappers.block.realized, en.v3.wrappers.block.unrealized]) {
      expect(html).toMatch(new RegExp(`<span class="whitespace-nowrap">${label} <`));
    }
  });

  test('the peek says the tile leaves General out', () => {
    expect(render(BASE)).toContain(en.v3.wrappers.block.tileSums);
  });

  test('each bucket shows its signed total, and signed realized and unrealized', () => {
    const html = render(BASE);
    expect(html).toMatch(/\+£\s?190\.00/);
    expect(html).toMatch(/\+£\s?150\.00/);
    expect(html).toMatch(/−£\s?10\.00/);
  });

  test('each row names its bucket and shows realized and unrealized', () => {
    const html = render(BASE);
    expect(html).toContain(en.v3.wrappers.bucket.exempt);
    expect(html).toContain(en.v3.wrappers.bucket.general);
    expect(html).not.toContain(en.v3.wrappers.bucket.deferred);
    expect(html).toContain(en.v3.wrappers.block.realized);
    expect(html).toContain(en.v3.wrappers.block.unrealized);
    expect(html).toContain('150.00');
    expect(html).toContain('40.00');
  });

  test("the note says the grouping is by each account's wrapper today", () => {
    expect(render(BASE).replaceAll('&#x27;', "'")).toContain(en.v3.wrappers.block.note);
  });

  test('a history rebuild withholds the figures and says why, as Returns does', () => {
    const view = toWrapperGainsView({ status: 'rebuilding', anyWrapped: true });
    expect(view?.withheld).toBe(true);
    expect(view?.wrappedGain).toBeNull();
    expect(view?.rows).toEqual([]);
    const html = renderToStaticMarkup(view ? <WrapperGainsCard view={view} currency="£" /> : null);
    expect(html).toContain(en.v3.home.returns.eligibility['rebuilding-history']);
    expect(html).not.toContain(en.v3.wrappers.block.realized);
  });

  test('a rebuild with no wrapper anywhere still shows no tile', () => {
    expect(toWrapperGainsView({ status: 'rebuilding', anyWrapped: false })).toBeNull();
  });

  test('holdings carried from an earlier priced day are counted under the figures', () => {
    const html = render({ ...BASE, carriedHoldings: 2 });
    expect(html).toContain(en.v3.wrappers.block.carried_other.replace('{{count}}', '2'));
    expect(render(BASE)).not.toContain(
      en.v3.wrappers.block.carried_other.replace('{{count}}', '0')
    );
  });
});
