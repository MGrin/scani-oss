import { describe, expect, test } from 'bun:test';
import type { FilterDef } from '@scani/ui/v3/hooks/useDataView';
import {
  GROUP_BY_PARAM,
  readDataViewUrl,
  sameUrlState,
  viewParamName,
  writeDataViewUrl,
} from '@scani/ui/v3/lib/data-view-url';
import { SHEET_PARAM } from '@scani/ui/v3/lib/sheet';
import { ACCOUNT_FILTER_PARAMS } from '@/v3/lib/accounts';
import { HOLDING_FILTER_PARAMS } from '@/v3/lib/holdings';

const defs = (...keys: string[]): FilterDef[] =>
  keys.map((key) => ({ key, label: key, options: [] }));

const HOLDINGS = defs('institution', 'account', 'tokenType', 'group');

describe('viewParamName', () => {
  test('a single-view surface uses the filter key unchanged', () => {
    // The whole point: `?account=<id>` is the link an account's peek emits and
    // the one `resolveActiveTabPath` reads. It must not gain a prefix.
    expect(viewParamName('holdings', 'account')).toBe('account');
  });

  test('a surface that shares its page namespaces by its own half of the key', () => {
    expect(viewParamName('tokens:custom', 'type')).toBe('custom.type');
    expect(viewParamName('tokens:hidden', 'type')).toBe('hidden.type');
  });
});

describe('readDataViewUrl', () => {
  test('reads only the filters the surface declares', () => {
    const url = '?account=a1&tokenType=crypto&somethingElse=x';
    expect(readDataViewUrl(url, 'holdings', HOLDINGS)).toEqual({
      filters: { account: 'a1', tokenType: 'crypto' },
      groupBy: '',
    });
  });

  test('an empty parameter is no filter at all', () => {
    expect(readDataViewUrl('?account=', 'holdings', HOLDINGS).filters).toEqual({});
  });

  test('reads the grouping axis', () => {
    expect(readDataViewUrl('?groupBy=institution', 'holdings', HOLDINGS).groupBy).toBe(
      'institution'
    );
  });

  test('a surface with no filters still reads its grouping', () => {
    expect(readDataViewUrl('?groupBy=kind', 'review', undefined)).toEqual({
      filters: {},
      groupBy: 'kind',
    });
  });
});

describe('writeDataViewUrl', () => {
  test('keeps every parameter it does not own', () => {
    // The refine sheet is `?sheet=refine:holdings` *while* these are being set,
    // so dropping unknown parameters would close the sheet on every change.
    const next = writeDataViewUrl(`?${SHEET_PARAM}=refine:holdings`, 'holdings', HOLDINGS, {
      filters: { tokenType: 'crypto' },
      groupBy: '',
    });
    expect(new URLSearchParams(next).get(SHEET_PARAM)).toBe('refine:holdings');
    expect(new URLSearchParams(next).get('tokenType')).toBe('crypto');
  });

  test('clearing a filter removes its parameter rather than blanking it', () => {
    const next = writeDataViewUrl('?account=a1', 'holdings', HOLDINGS, {
      filters: { account: '' },
      groupBy: '',
    });
    expect(next).toBe('');
  });

  test('two lists on one page write different parameters', () => {
    const first = writeDataViewUrl('', 'tokens:custom', defs('type'), {
      filters: { type: 'equity' },
      groupBy: '',
    });
    const both = writeDataViewUrl(first, 'tokens:hidden', defs('type'), {
      filters: { type: 'crypto' },
      groupBy: '',
    });
    const params = new URLSearchParams(both);
    expect(params.get('custom.type')).toBe('equity');
    expect(params.get('hidden.type')).toBe('crypto');
  });

  test('a round trip is the identity', () => {
    const state = { filters: { account: 'a1', group: 'g2' }, groupBy: 'institution' };
    expect(
      readDataViewUrl(writeDataViewUrl('', 'holdings', HOLDINGS, state), 'holdings', HOLDINGS)
    ).toEqual(state);
  });
});

describe('sameUrlState', () => {
  test('an absent filter and an empty one are the same state', () => {
    expect(sameUrlState({ filters: {}, groupBy: '' }, { filters: { a: '' }, groupBy: '' })).toBe(
      true
    );
  });

  test('a different value is a different state', () => {
    expect(
      sameUrlState({ filters: { a: '1' }, groupBy: '' }, { filters: { a: '2' }, groupBy: '' })
    ).toBe(false);
  });

  test('the grouping axis counts', () => {
    expect(sameUrlState({ filters: {}, groupBy: 'x' }, { filters: {}, groupBy: '' })).toBe(false);
  });
});

/**
 * The contract this whole mechanism rests on. `HOLDING_FILTER_PARAMS` and
 * `ACCOUNT_FILTER_PARAMS` are v2's query-parameter spellings, kept so the
 * version switch carries a narrowed list across; `data-view-url` writes a
 * filter under its own key. If a surface ever declares a filter whose key is
 * not its parameter name, one control would write two pieces of state.
 */
describe('a filter key is its parameter name', () => {
  test('holdings', () => {
    for (const param of HOLDING_FILTER_PARAMS) {
      expect(viewParamName('holdings', param)).toBe(param);
    }
  });

  test('accounts', () => {
    for (const param of ACCOUNT_FILTER_PARAMS) {
      expect(viewParamName('accounts', param)).toBe(param);
    }
  });

  test('the grouping axis cannot collide with a filter named `group`', () => {
    expect(HOLDING_FILTER_PARAMS).toContain('group');
    expect(GROUP_BY_PARAM).not.toBe('group');
  });
});
