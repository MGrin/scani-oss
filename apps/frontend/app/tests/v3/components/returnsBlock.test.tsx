import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReturnsCard } from '../../../src/v3/components/home/ReturnsBlock';
import en from '../../../src/v3/i18n/locales/en.json';
import type { ReturnsView } from '../../../src/v3/lib/returns';

const copy = en.v3.home.returns;

function render(view: ReturnsView | null): string {
  return renderToStaticMarkup(
    <ReturnsCard view={view} windowKey="all" onWindowChange={() => undefined} />
  );
}

const VIEW: ReturnsView = {
  twr: { cumulative: 70.2, annualized: 42.5 },
  xirr: { rate: 44.5, approximate: false },
  fx: null,
  benchmarks: [],
  since: '2025-03-20',
  partial: false,
};

describe('the returns card (SC-1159)', () => {
  test('shows both returns, the yearly rate and where "since" starts', () => {
    const html = render(VIEW);
    expect(html).toContain(copy.twr.label);
    // The markup escapes the apostrophe in "Your money's return".
    expect(html).toContain(copy.xirr.label.replace("'", '&#x27;'));
    expect(html).toContain('70.2');
    expect(html).toContain('42.5');
    expect(html).toContain('44.5');
    expect(html).toContain('Since ');
    expect(html).not.toContain(copy.partial);
  });

  test('an approximate XIRR says so in place of its usual caption', () => {
    const html = render({ ...VIEW, xirr: { rate: 10, approximate: true } });
    expect(html).toContain(copy.xirr.approximate);
    expect(html).not.toContain(copy.xirr.caption);
  });

  test('a partly priced window says so', () => {
    expect(render({ ...VIEW, partial: true })).toContain(copy.partial);
  });

  test('a figure the engine could not produce is a dash, not a zero', () => {
    const html = render({ ...VIEW, xirr: null });
    expect(html).toContain('—');
    // Control: the time-weighted figure beside it still rendered.
    expect(html).toContain('70.2');
  });

  test('the exchange-rate row appears only with a split', () => {
    expect(render(VIEW)).not.toContain(copy.fx.label);
    const html = render({ ...VIEW, fx: { asset: 61.5, currency: 5.4 } });
    expect(html).toContain(copy.fx.label);
    expect(html).toContain('61.5');
    expect(html).toContain('5.4');
  });

  test('the benchmark lines appear only when there are some', () => {
    expect(render(VIEW)).not.toContain(copy.benchmarks.label);
    const html = render({
      ...VIEW,
      benchmarks: [
        { key: 'btc', cumulative: 92.3 },
        { key: 'sp500', cumulative: 13.8 },
      ],
    });
    expect(html).toContain(copy.benchmarks.label);
    expect(html).toContain(copy.benchmarks.btc);
    expect(html).toContain(copy.benchmarks.sp500.replace('&', '&amp;'));
    expect(html).toContain('92.3');
    expect(html).toContain('13.8');
  });
});
