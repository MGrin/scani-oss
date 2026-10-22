import '../../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { StatementsCard } from '../../../../src/v3/components/accounts/StatementsBlock';
import en from '../../../../src/v3/i18n/locales/en.json';
import { type AccountStatementsSummary, toStatementsView } from '../../../../src/v3/lib/statements';

const BASE: AccountStatementsSummary = {
  statements: [
    {
      windowId: 'w-3',
      from: '2026-03-01',
      to: '2026-03-31',
      readAt: '2026-04-02T10:00:00.000Z',
      document: { id: 'd-3', filename: 'march.csv', downloadable: true },
    },
    {
      windowId: 'w-1',
      from: '2026-01-01',
      to: '2026-01-31',
      readAt: '2026-02-02T10:00:00.000Z',
      document: null,
    },
  ],
  gaps: ['2026-02', '2026-04'],
};

function render(summary: AccountStatementsSummary): string {
  const view = toStatementsView(summary);
  if (!view) throw new Error('expected a view');
  return renderToStaticMarkup(
    <MemoryRouter>
      <StatementsCard view={view} />
    </MemoryRouter>
  );
}

describe('Statements in the account details (SC-1656)', () => {
  test('an account with no statements gets no section', () => {
    expect(toStatementsView({ statements: [], gaps: [] })).toBeNull();
    expect(toStatementsView(undefined)).toBeNull();
  });

  test('each statement reads as its period, and each gap as its month, in the locale', () => {
    const view = toStatementsView(BASE);
    // Day-first through the shared formatter, as Bills and Home write dates
    // (design, bus #24519). ICU spaces the range dash differently per runtime.
    expect(view?.rows.map((row) => row.period.replace(/\s*–\s*/g, '–'))).toEqual([
      '1–31 Mar 2026',
      '1–31 Jan 2026',
    ]);
    expect(view?.gaps).toEqual(['Feb 2026', 'Apr 2026']);
  });

  test('a statement links to its file; one with no file says so', () => {
    const html = render(BASE);
    expect(html).toContain('march.csv');
    expect(html).toContain('href="/documents/d-3"');
    expect(html).toContain(en.v3.statements.fileNotKept);
    // Only the row with a file is a link, like a Files row; the other is inert.
    expect(html.match(/<a /g)?.length).toBe(1);
  });

  test('the months no statement covers are named; with none, the section says so', () => {
    expect(render(BASE)).toContain('Feb 2026, Apr 2026');
    expect(render({ ...BASE, gaps: [] })).toContain(en.v3.statements.noGaps);
  });
});
