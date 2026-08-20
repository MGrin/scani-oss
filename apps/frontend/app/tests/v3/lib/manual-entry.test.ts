import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import {
  buildEnsureAccountInput,
  buildHoldingsBatchInput,
  completedHoldings,
  contestedHoldingTokenIds,
  describeManualEntryBlockers,
  emptyAccountTarget,
  emptyDraft,
  emptyHolding,
  type ManualEntryDraft,
  normalizeWebsite,
  repeatedHoldingTokenIds,
} from '@/v3/lib/manual-entry';

// Resolved through the real instance against the shipped `en.json`.
const t = i18n.t.bind(i18n);

function draft(overrides: Partial<ManualEntryDraft> = {}): ManualEntryDraft {
  return {
    ...emptyDraft('row-1'),
    institutionMode: 'existing',
    institutionId: 'inst-1',
    accountMode: 'existing',
    accountId: 'acc-1',
    holdings: [
      { uid: 'row-1', tokenId: 'tok-1', tokenLabel: 'BTC — Bitcoin', balance: '0.418', label: '' },
    ],
    ...overrides,
  };
}

describe('describeManualEntryBlockers', () => {
  test('a complete draft has nothing missing', () => {
    expect(describeManualEntryBlockers(t, draft())).toEqual([]);
  });

  test('an untouched form names all three things it needs', () => {
    // The whole point of the list. v2 renders the same state as a grey button
    // and nothing else, so a user who has filled two of three fields is
    // guessing which one is wrong.
    expect(describeManualEntryBlockers(t, emptyDraft('row-1'))).toEqual([
      'choose where the account is held',
      'choose an account',
      'add a holding with both a token and an amount',
    ]);
  });

  test('a new institution needs a name and a type, not an id', () => {
    expect(
      describeManualEntryBlockers(
        t,
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
        t,
        draft({ accountMode: 'new', accountId: '', newAccount: { name: 'ISA', typeId: '' } })
      )
    ).toEqual(["choose the account's type"]);
  });

  test('a half-typed holding row is not an error, it is just not finished', () => {
    // A row with a token and no amount is where the user's cursor is. Reporting
    // it would tell them off for typing.
    const partial = draft({
      holdings: [
        { uid: 'a', tokenId: 'tok-1', tokenLabel: 'BTC', balance: '0.418', label: '' },
        { uid: 'b', tokenId: 'tok-2', tokenLabel: 'ETH', balance: '', label: '' },
      ],
    });
    expect(describeManualEntryBlockers(t, partial)).toEqual([]);
  });

  test('no completed row at all is reported', () => {
    const none = draft({ holdings: [emptyHolding('a')] });
    expect(describeManualEntryBlockers(t, none)).toContain(
      'add a holding with both a token and an amount'
    );
  });
});

describe('completedHoldings', () => {
  test('keeps only rows with both a token and a non-blank amount', () => {
    expect(
      completedHoldings([
        { uid: 'a', tokenId: 'tok-1', tokenLabel: '', balance: '1', label: '' },
        { uid: 'b', tokenId: '', tokenLabel: '', balance: '2', label: '' },
        { uid: 'c', tokenId: 'tok-3', tokenLabel: '', balance: '   ', label: '' },
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

describe('repeatedHoldingTokenIds', () => {
  test('one row per token is clean', () => {
    expect(repeatedHoldingTokenIds(draft().holdings)).toEqual([]);
  });

  test('the Tinkoff shape — four rows, one token — reports it once', () => {
    // `updateHoldings` is always empty here, so each of these becomes its own
    // INSERT and the account ends up with four holdings for one token
    // (SC-303). Four RUB rows is the exact payload that did it in production.
    const rows = ['a', 'b', 'c', 'd'].map((uid) => ({
      uid,
      tokenId: 'tok-rub',
      tokenLabel: 'RUB — Russian Ruble',
      balance: '100',
      label: '',
    }));
    expect(repeatedHoldingTokenIds(rows)).toEqual(['tok-rub']);
  });

  // SC-330. The naming rule itself is pinned in `@scani/shared`'s
  // batch.test.ts. What is v3's own is that the FORM asks, unblocks, and sends
  // what it asked for.
  test('naming the pots clears the submit blocker', () => {
    const pots = [
      { uid: 'a', tokenId: 'tok-rub', tokenLabel: 'RUB', balance: '3053.60', label: 'Current' },
      { uid: 'b', tokenId: 'tok-rub', tokenLabel: 'RUB', balance: '54121.34', label: 'Savings' },
      { uid: 'c', tokenId: 'tok-rub', tokenLabel: 'RUB', balance: '69428.89', label: 'Deposit' },
      ***REMOVED***
    ];
    expect(describeManualEntryBlockers(t, draft({ holdings: pots }))).toEqual([]);
  });

  test('the name field is asked for on repeated tokens and nowhere else', () => {
    const rows = [
      { uid: 'a', tokenId: 'tok-rub', tokenLabel: 'RUB', balance: '1', label: 'Savings' },
      { uid: 'b', tokenId: 'tok-rub', tokenLabel: 'RUB', balance: '2', label: 'Deposit' },
      { uid: 'c', tokenId: 'tok-usd', tokenLabel: 'USD', balance: '3', label: '' },
    ];
    const contested = contestedHoldingTokenIds(rows);
    expect(contested.has('tok-rub')).toBe(true);
    // A question everyone sees is a question nobody reads (SC-63, SC-73).
    expect(contested.has('tok-usd')).toBe(false);
  });

  test('a half-filled row is not contested — it is the row being typed', () => {
    const rows = [
      { uid: 'a', tokenId: 'tok-rub', tokenLabel: 'RUB', balance: '1', label: '' },
      { uid: 'b', tokenId: 'tok-rub', tokenLabel: 'RUB', balance: '  ', label: '' },
    ];
    expect(contestedHoldingTokenIds(rows).has('tok-rub')).toBe(false);
  });

  test('named pots reach the payload; a stray name on a lone row does not', () => {
    const input = buildHoldingsBatchInput(
      draft({
        holdings: [
          { uid: 'a', tokenId: 'tok-rub', tokenLabel: 'RUB', balance: '1', label: 'Savings' },
          { uid: 'b', tokenId: 'tok-rub', tokenLabel: 'RUB', balance: '2', label: 'Deposit' },
          { uid: 'c', tokenId: 'tok-usd', tokenLabel: 'USD', balance: '3', label: 'Leftover' },
        ],
      }),
      'req-1'
    );
    expect(input?.newHoldings).toEqual([
      { tokenId: 'tok-rub', label: 'Savings', balance: '1' },
      { tokenId: 'tok-rub', label: 'Deposit', balance: '2' },
      // Never asked for, so never sent — otherwise a name typed while the rows
      // still collided would survive on a holding that ends up alone.
      { tokenId: 'tok-usd', label: undefined, balance: '3' },
    ]);
  });

  test('a half-filled second row is still being typed, not a duplicate', () => {
    const rows = [
      { uid: 'a', tokenId: 'tok-1', tokenLabel: 'BTC', balance: '1', label: '' },
      { uid: 'b', tokenId: 'tok-1', tokenLabel: 'BTC', balance: '  ', label: '' },
    ];
    expect(repeatedHoldingTokenIds(rows)).toEqual([]);
  });

  test('a repeated token blocks submission with copy that says what to do', () => {
    const blocked = describeManualEntryBlockers(
      t,
      draft({
        holdings: [
          { uid: 'a', tokenId: 'tok-1', tokenLabel: 'BTC', balance: '1', label: '' },
          { uid: 'b', tokenId: 'tok-1', tokenLabel: 'BTC', balance: '2', label: '' },
        ],
      })
    );
    expect(blocked).toContain(
      'give each row that names the same token its own name, or merge them'
    );
    expect(
      buildHoldingsBatchInput(
        draft({
          holdings: [
            { uid: 'a', tokenId: 'tok-1', tokenLabel: 'BTC', balance: '1', label: '' },
            { uid: 'b', tokenId: 'tok-1', tokenLabel: 'BTC', balance: '2', label: '' },
          ],
        }),
        'req-1'
      )
    ).toBeNull();
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
          { uid: 'a', tokenId: 'tok-1', tokenLabel: '', balance: ' 0.418 ', label: '' },
          { uid: 'b', tokenId: '', tokenLabel: '', balance: '9', label: '' },
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
