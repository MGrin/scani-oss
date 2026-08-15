import { describe, expect, test } from 'bun:test';
import {
  CAPTURE_SHEET,
  MORE_SHEET,
  parseSheet,
  refineSheet,
  resolveSheetClose,
  sheetClosedSearch,
  sheetOpenSearch,
  sheetOpenState,
} from '@scani/ui/v3/lib/sheet';

describe('reading a sheet off the URL', () => {
  test('no parameter is no sheet', () => {
    expect(parseSheet('')).toBeNull();
    expect(parseSheet('?accountId=acc-1')).toBeNull();
  });

  test('an empty parameter is no sheet either — not a sheet named ""', () => {
    expect(parseSheet('?sheet=')).toBeNull();
  });

  test('reads the sheet beside whatever else the URL carries', () => {
    expect(parseSheet('?accountId=acc-1&sheet=add')).toBe(CAPTURE_SHEET);
  });

  test('a refine sheet is keyed by its surface, so two on one page do not collide', () => {
    const custom = refineSheet('tokens-custom');
    const hidden = refineSheet('tokens-hidden');
    expect(custom).not.toBe(hidden);
    expect(parseSheet(sheetOpenSearch('', custom))).toBe(custom);
    expect(parseSheet(sheetOpenSearch('', custom))).not.toBe(hidden);
  });
});

describe('opening and closing a sheet on the URL', () => {
  // The account filter is what lights the Accounts tab on a narrowed holdings
  // list (V3-40). Dropping it to open a sheet would darken the bar on the way
  // in and light it again on the way out.
  test('opening keeps every other parameter', () => {
    expect(sheetOpenSearch('?accountId=acc-1', MORE_SHEET)).toBe('?accountId=acc-1&sheet=more');
  });

  test('opening a second sheet replaces the first rather than stacking them', () => {
    expect(sheetOpenSearch('?sheet=more', CAPTURE_SHEET)).toBe('?sheet=add');
  });

  test('closing removes only the sheet', () => {
    expect(sheetClosedSearch('?accountId=acc-1&sheet=add')).toBe('?accountId=acc-1');
  });

  test('closing the only parameter leaves no stray question mark', () => {
    expect(sheetClosedSearch('?sheet=add')).toBe('');
  });
});

describe('resolveSheetClose', () => {
  // The whole point of D-6: closing and the back gesture have to be the same
  // act, or opening Refine five times buries the list five entries deep.
  test('pops the entry we pushed', () => {
    expect(
      resolveSheetClose(CAPTURE_SHEET, '/v3/holdings', '?sheet=add', sheetOpenState(CAPTURE_SHEET))
    ).toEqual({ type: 'back' });
  });

  test('a deep link we never pushed is replaced, not popped — back would leave the app', () => {
    expect(resolveSheetClose(CAPTURE_SHEET, '/v3/holdings', '?sheet=add', null)).toEqual({
      type: 'replace',
      to: '/v3/holdings',
    });
  });

  test('replacing keeps the rest of the URL', () => {
    expect(
      resolveSheetClose(CAPTURE_SHEET, '/v3/holdings', '?accountId=acc-1&sheet=add', undefined)
    ).toEqual({ type: 'replace', to: '/v3/holdings?accountId=acc-1' });
  });

  // History state survives a client-side navigation between surfaces, so a
  // flag left by one sheet must not convince the next one its entry is ours.
  test("another sheet's open state does not make this one poppable", () => {
    expect(
      resolveSheetClose(MORE_SHEET, '/v3/holdings', '?sheet=more', sheetOpenState(CAPTURE_SHEET))
    ).toEqual({ type: 'replace', to: '/v3/holdings' });
  });

  test('a refine sheet on one surface does not pop a refine sheet on another', () => {
    expect(
      resolveSheetClose(
        refineSheet('tokens-hidden'),
        '/v3/tokens',
        '?sheet=refine%3Atokens-hidden',
        sheetOpenState(refineSheet('tokens-custom'))
      )
    ).toEqual({ type: 'replace', to: '/v3/tokens' });
  });
});
