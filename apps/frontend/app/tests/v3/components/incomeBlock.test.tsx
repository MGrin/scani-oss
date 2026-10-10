import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RouterOutputs } from '../../../src/lib/trpc';
import { IncomeCard } from '../../../src/v3/components/home/IncomeBlock';
import en from '../../../src/v3/i18n/locales/en.json';
import { toIncomeView } from '../../../src/v3/lib/income';

/**
 * Income RECEIVED on Home (SC-1644), kept apart from the Money page's income
 * EXPECTED: the two differ in certainty and are never shown as one (V3-47).
 */

type IncomeSummary = NonNullable<RouterOutputs['portfolio']['getIncome']['income']>;

const BASE: IncomeSummary = {
  baseCurrencyId: 'eur',
  window: { from: '2025-10-10T00:00:00.000Z', to: '2026-10-09T23:59:59.999Z' },
  months: [
    {
      month: '2026-03',
      groups: {
        dividend: { gross: '9', withheld: '1.35', net: '7.65' },
        interest: { gross: '1.8', withheld: '0', net: '1.8' },
      },
    },
  ],
  totals: {
    dividend: { gross: '9', withheld: '1.35', net: '7.65' },
    interest: { gross: '1.8', withheld: '0', net: '1.8' },
  },
  dividendsBySecurity: [
    {
      isin: 'ZZ0000000017',
      symbol: 'ACME',
      payments: 2,
      amounts: { gross: '9', withheld: '1.35', net: '7.65' },
    },
  ],
  unpricedCount: 0,
  unmatchedWithholdingCount: 0,
};

function render(summary: IncomeSummary): string {
  const view = toIncomeView(summary);
  if (!view) throw new Error('expected a view');
  return renderToStaticMarkup(<IncomeCard view={view} currency="€" />);
}

describe('Investment income on Home (SC-1644)', () => {
  test('renders nothing when there is no income', () => {
    expect(toIncomeView({ ...BASE, months: [], totals: {}, dividendsBySecurity: [] })).toBeNull();
    expect(toIncomeView(null)).toBeNull();
    expect(toIncomeView(undefined)).toBeNull();
  });

  test('shows gross, withheld and net for dividends', () => {
    const html = render(BASE);
    expect(html).toContain(en.v3.home.income.group.dividend);
    expect(html).toContain('9.00');
    expect(html).toContain('1.35');
    expect(html).toContain('7.65');
  });

  test('hides withheld when none was withheld', () => {
    const html = render({
      ...BASE,
      months: [
        { month: '2026-03', groups: { interest: { gross: '1.8', withheld: '0', net: '1.8' } } },
      ],
      totals: { interest: { gross: '1.8', withheld: '0', net: '1.8' } },
      dividendsBySecurity: [],
    });
    expect(html).toContain(en.v3.home.income.group.interest);
    expect(html).not.toContain(en.v3.home.income.withheld);
  });

  test('lists securities when present, omits the list otherwise', () => {
    const listed = render(BASE);
    expect(listed).toContain(en.v3.home.income.bySecurity);
    expect(listed).toContain('ACME');
    const none = render({ ...BASE, dividendsBySecurity: [] });
    expect(none).not.toContain(en.v3.home.income.bySecurity);
  });

  test('names unpriced rows', () => {
    const html = render({ ...BASE, unpricedCount: 2 });
    expect(html).toContain(en.v3.home.income.unpriced_other.replace('{{count}}', '2'));
    expect(render(BASE)).not.toContain(
      en.v3.home.income.unpriced_other.split('{{count}}')[1] ?? ''
    );
  });

  test('each group carries the colour of its bar', () => {
    // Four stacked colours with nothing naming them cannot be read; the swatch
    // beside each group's name is the legend.
    const html = render(BASE);
    expect(html).toMatch(/data-income-swatch="dividend"[^>]*hsl\(var\(--chart-1\)\)/);
    expect(html).toMatch(/data-income-swatch="interest"[^>]*hsl\(var\(--chart-2\)\)/);
  });

  test('income that could not be valued still shows the card, naming it', () => {
    const view = toIncomeView({
      ...BASE,
      months: [],
      totals: {},
      dividendsBySecurity: [],
      unpricedCount: 3,
    });
    expect(view).not.toBeNull();
    const html = renderToStaticMarkup(
      <IncomeCard view={view as NonNullable<typeof view>} currency="€" />
    );
    expect(html).toContain(en.v3.home.income.unpriced_other.replace('{{count}}', '3'));
  });

  test('the window is named by its UTC calendar days', () => {
    // The window ends 23:59:59.999Z. Formatted as an instant, that is already
    // tomorrow anywhere east of UTC, and the caption named a day not measured.
    expect(toIncomeView(BASE)?.window).toEqual({ from: '2025-10-10', to: '2026-10-09' });
  });

  test('the title says received, where Upcoming says expected', () => {
    // Both figures sit on Home (operator, bus #23642): the titles carry the
    // difference between a record and a forecast at a glance.
    expect(en.v3.home.income.title).toBe('Investment income received');
    expect(en.v3.home.upcoming.incomeExpected_other).toMatch(/expected/i);
  });

  test('never says expected', () => {
    const html = render(BASE);
    expect(html).not.toContain('expected');
    expect(html).not.toContain(en.v3.money.expectedIncome.title_other.split('{{count}}')[0] ?? '');
  });

  test('IncomeBlock does not wait on the returns engine', async () => {
    const source = await Bun.file(
      'apps/frontend/app/src/v3/components/home/IncomeBlock.tsx'
    ).text();
    expect(source).toInclude('trpc.portfolio.getIncome.useQuery');
    // The title moved to the card's header with SC-1668; it is still this one.
    expect(source).toInclude("title={t('v3.home.income.title')}");
    expect(source).not.toInclude('portfolio.getReturns');
    expect(source).not.toInclude('portfolio.hasReturns');
  });
});
