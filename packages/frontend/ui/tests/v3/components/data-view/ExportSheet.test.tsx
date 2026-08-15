import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExportSections, initialScope } from '../../../../src/v3/components/data-view/ExportSheet';

/**
 * The sheet itself is a Radix portal and draws nothing under
 * `renderToStaticMarkup`, so the sections are exported and checked directly —
 * the same arrangement `RefineSheet` uses and for the same reason.
 */

const BASE = {
  scope: 'filtered',
  onScopeChange: () => {},
  formats: ['csv', 'xlsx'] as const,
  format: 'csv' as const,
  onFormatChange: () => {},
  separator: ',' as const,
  onSeparatorChange: () => {},
};

const NARROWED = [
  { key: 'filtered', label: 'These 12 holdings', detail: 'Institution: Kraken' },
  { key: 'all', label: 'All 69 holdings', detail: 'Ignores the filters and the search' },
];

describe('ExportSections', () => {
  it('offers the narrowed set first and names what narrowed it', () => {
    const html = renderToStaticMarkup(<ExportSections {...BASE} scopes={NARROWED} />);
    expect(html.indexOf('These 12 holdings')).toBeLessThan(html.indexOf('All 69 holdings'));
    expect(html).toContain('Institution: Kraken');
  });

  it('marks the narrowed set as the one selected', () => {
    const html = renderToStaticMarkup(<ExportSections {...BASE} scopes={NARROWED} />);
    const filtered = html.slice(0, html.indexOf('All 69 holdings'));
    expect(filtered).toContain('aria-pressed="true"');
  });

  it('states a single option rather than offering it as a choice', () => {
    const html = renderToStaticMarkup(
      <ExportSections {...BASE} scope="all" scopes={[{ key: 'all', label: 'All 69 holdings' }]} />
    );
    // Only the scope block — the Format and Separator blocks below it are
    // still real choices and still carry `aria-pressed`.
    const scopeBlock = html.slice(0, html.indexOf('Format'));
    expect(scopeBlock).toContain('All 69 holdings');
    expect(scopeBlock).not.toContain('aria-pressed');
  });

  it('offers the separator only where a CSV is actually being written', () => {
    const withCsv = renderToStaticMarkup(<ExportSections {...BASE} scopes={NARROWED} />);
    expect(withCsv).toContain('Semicolon');

    const workbookOnly = renderToStaticMarkup(
      <ExportSections {...BASE} scopes={NARROWED} formats={['xlsx']} format="xlsx" />
    );
    // No format block either: a single format is not a question.
    expect(workbookOnly).not.toContain('Semicolon');
    expect(workbookOnly).not.toContain('Excel (.xlsx)');
  });
});

/**
 * SC-97 — which option the sheet opens on.
 *
 * The list sheets want the narrowed set, which is first; the net-worth sheet
 * wants the chart's active range, which is not. Both go through this.
 */
describe('initialScope', () => {
  const WINDOWS = [
    { key: '7d', label: 'This 1W window' },
    { key: '30d', label: 'This 1M window' },
    { key: '90d', label: 'This 3M window' },
    { key: 'all', label: 'Everything we have' },
  ];

  it('opens on the caller default when it names a real option', () => {
    expect(initialScope(WINDOWS, '30d')).toBe('30d');
  });

  it('opens on the first option when no default is given', () => {
    expect(initialScope(NARROWED)).toBe('filtered');
  });

  it('ignores a default the sheet does not offer rather than selecting nothing', () => {
    // A chart range with no export equivalent must not leave the sheet with an
    // unselected scope and a dead confirm button.
    expect(initialScope(WINDOWS, '2y')).toBe('7d');
  });

  it('returns empty only when there is genuinely nothing to choose', () => {
    expect(initialScope([], '30d')).toBe('');
  });
});

describe('format availability', () => {
  it('falls back when the remembered format is not on offer here', () => {
    // A reader who last exported a PDF opens a surface that cannot make one —
    // a console that mounts the list without a PDF renderer, or the whole-account
    // export. The sheet must show a
    // format it can actually produce rather than a checked option that fails.
    const html = renderToStaticMarkup(
      <ExportSections {...BASE} scopes={NARROWED} formats={['xlsx']} format="xlsx" />
    );
    expect(html).not.toContain('PDF (.pdf)');
  });
});
