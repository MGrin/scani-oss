import { describe, expect, test } from 'bun:test';
import {
  buildEnsureAccountInput,
  buildHoldingsBatchInput,
  completedHoldings,
  describeManualEntryBlockers,
  emptyAccountTarget,
  emptyDraft,
  emptyHolding,
  type ManualEntryDraft,
  normalizeWebsite,
} from '@/v3/lib/manual-entry';

function draft(overrides: Partial<ManualEntryDraft> = {}): ManualEntryDraft {
  return {
    ...emptyDraft('row-1'),
    institutionMode: 'existing',
    institutionId: 'inst-1',
    accountMode: 'existing',
    accountId: 'acc-1',
    holdings: [{ uid: 'row-1', tokenId: 'tok-1', tokenLabel: 'BTC — Bitcoin', balance: '0.418' }],
    ...overrides,
  };
}

describe('describeManualEntryBlockers', () => {
  test('a complete draft has nothing missing', () => {
    expect(describeManualEntryBlockers(draft())).toEqual([]);
  });

  test('an untouched form names all three things it needs', () => {
    // The whole point of the list. v2 renders the same state as a grey button
    // and nothing else, so a user who has filled two of three fields is
    // guessing which one is wrong.
    expect(describeManualEntryBlockers(emptyDraft('row-1'))).toEqual([
      'choose where the account is held',
      'choose an account',
      'add a holding with both a token and an amount',
    ]);
  });

  test('a new institution needs a name and a type, not an id', () => {
    expect(
      describeManualEntryBlockers(
        draft({
          institutionMode: 'new',
          institutionId: '',
          newInstitution: { name: '  ', typeId: '', website: '' },
        })
      )
    ).toEqual(['name the new institution', "choose the institution's type"]);
  });

  test('a new account needs a name and a type', () => {
    expect(
      describeManualEntryBlockers(
        draft({ accountMode: 'new', accountId: '', newAccount: { name: 'ISA', typeId: '' } })
      )
    ).toEqual(["choose the account's type"]);
  });

  test('a half-typed holding row is not an error, it is just not finished', () => {
    // A row with a token and no amount is where the user's cursor is. Reporting
    // it would tell them off for typing.
    const partial = draft({
      holdings: [
        { uid: 'a', tokenId: 'tok-1', tokenLabel: 'BTC', balance: '0.418' },
        { uid: 'b', tokenId: 'tok-2', tokenLabel: 'ETH', balance: '' },
      ],
    });
    expect(describeManualEntryBlockers(partial)).toEqual([]);
  });

  test('no completed row at all is reported', () => {
    const none = draft({ holdings: [emptyHolding('a')] });
    expect(describeManualEntryBlockers(none)).toContain(
      'add a holding with both a token and an amount'
    );
  });
});

describe('completedHoldings', () => {
  test('keeps only rows with both a token and a non-blank amount', () => {
    expect(
      completedHoldings([
        { uid: 'a', tokenId: 'tok-1', tokenLabel: '', balance: '1' },
        { uid: 'b', tokenId: '', tokenLabel: '', balance: '2' },
        { uid: 'c', tokenId: 'tok-3', tokenLabel: '', balance: '   ' },
      ]).map((holding) => holding.uid)
    ).toEqual(['a']);
  });
});

describe('normalizeWebsite', () => {
  test('adds a scheme to a bare host', () => {
    expect(normalizeWebsite('revolut.com')).toBe('https://revolut.com');
  });

  test('leaves an existing scheme alone, in either case', () => {
    expect(normalizeWebsite('https://revolut.com')).toBe('https://revolut.com');
    expect(normalizeWebsite('HTTP://revolut.com')).toBe('HTTP://revolut.com');
  });

  test('an empty field is undefined, not an empty string', () => {
    // An empty string would be stored as a website and then rendered as a
    // broken favicon on every row the institution appears in.
    expect(normalizeWebsite('   ')).toBeUndefined();
  });
});

describe('buildHoldingsBatchInput', () => {
  test('an incomplete draft builds nothing', () => {
    expect(buildHoldingsBatchInput(emptyDraft('row-1'), 'req-1')).toBeNull();
  });

  test('existing institution and account send ids and no records to create', () => {
    const input = buildHoldingsBatchInput(draft(), 'req-1');
    expect(input).toEqual({
      requestId: 'req-1',
      institution: undefined,
      accountId: 'acc-1',
      account: undefined,
      newHoldings: [{ tokenId: 'tok-1', balance: '0.418' }],
      updateHoldings: [],
    });
  });

  test('a new account under an existing institution carries that institution', () => {
    const input = buildHoldingsBatchInput(
      draft({
        accountMode: 'new',
        accountId: '',
        newAccount: { name: '  Trading  ', typeId: 'type-1' },
      }),
      'req-1'
    );
    expect(input?.accountId).toBeUndefined();
    expect(input?.account).toEqual({
      name: 'Trading',
      typeId: 'type-1',
      institutionId: 'inst-1',
    });
  });

  test('a new account under a new institution carries no institution id', () => {
    // The institution does not exist yet — the worker creates it first and
    // binds the account to it. Sending an id here would send one for a row
    // that has never been written.
    const input = buildHoldingsBatchInput(
      draft({
        institutionMode: 'new',
        institutionId: '',
        newInstitution: { name: 'Revolut', typeId: 'bank', website: 'revolut.com' },
        accountMode: 'new',
        accountId: '',
        newAccount: { name: 'Savings', typeId: 'type-1' },
      }),
      'req-1'
    );
    expect(input?.institution).toEqual({
      name: 'Revolut',
      typeId: 'bank',
      website: 'https://revolut.com',
    });
    expect(input?.account?.institutionId).toBeUndefined();
  });

  test('unfinished rows never reach the wire', () => {
    const input = buildHoldingsBatchInput(
      draft({
        holdings: [
          { uid: 'a', tokenId: 'tok-1', tokenLabel: '', balance: ' 0.418 ' },
          { uid: 'b', tokenId: '', tokenLabel: '', balance: '9' },
        ],
      }),
      'req-1'
    );
    expect(input?.newHoldings).toEqual([{ tokenId: 'tok-1', balance: '0.418' }]);
  });

  test('never sends an update — this form only ever adds', () => {
    expect(buildHoldingsBatchInput(draft(), 'req-1')?.updateHoldings).toEqual([]);
  });
});

/**
 * The account the file import resolves before it will send a file (V3-44). It
 * is the same "where" draft this form fills in, which is why it lives here —
 * two forms asking one question must send one payload.
 */
describe('resolving the account a capture lands in', () => {
  test('an existing account is already an id, so nothing needs creating', () => {
    expect(
      buildEnsureAccountInput({
        ...emptyAccountTarget(),
        institutionId: 'inst-1',
        accountId: 'acc-1',
      })
    ).toEqual({ accountId: 'acc-1' });
  });

  test('a new account under an existing institution carries that institution id', () => {
    expect(
      buildEnsureAccountInput({
        ...emptyAccountTarget(),
        institutionId: 'inst-1',
        accountMode: 'new',
        newAccount: { name: ' Savings ', typeId: 'type-1' },
      })
    ).toEqual({
      institution: undefined,
      account: { name: 'Savings', typeId: 'type-1', institutionId: 'inst-1' },
    });
  });

  test('a new account under a new institution sends no institution id at all', () => {
    // The institution does not exist yet — the worker creates it first and
    // binds the account to it, so an id here would be one that is not real.
    const input = buildEnsureAccountInput({
      ...emptyAccountTarget(),
      institutionMode: 'new',
      newInstitution: { name: 'Revolut', typeId: 'bank', website: 'revolut.com' },
      accountMode: 'new',
      newAccount: { name: 'Savings', typeId: 'type-1' },
    });
    expect(input?.institution).toEqual({
      name: 'Revolut',
      typeId: 'bank',
      website: 'https://revolut.com',
    });
    expect(input?.account?.institutionId).toBeUndefined();
  });

  test('an unfinished target resolves to nothing rather than to a partial write', () => {
    expect(buildEnsureAccountInput(emptyAccountTarget())).toBeNull();
  });
});
