import { describe, expect, test } from 'bun:test';
import { flowRoleOf } from '../../../src/lib/returns/flow-classification';
import {
  type InputSourceClass,
  inputSourceClass,
  type LedgerMapping,
  type LegacyEntryFacts,
  mapLegacyEntry,
} from '../../../src/services/foundation/legacy-ledger-kinds';
import { NON_EVM_WALLET_SOURCES } from '../../../src/services/transactions/transaction-source';
import { CEX_SOURCE_TO_INSTITUTION } from '../../../src/services/transactions/transaction-sources';

type Mapped = Extract<LedgerMapping, { excluded: null }>;

function row(facts: Partial<LegacyEntryFacts> & Pick<LegacyEntryFacts, 'kind'>): LegacyEntryFacts {
  return {
    id: 'r1',
    source: 'kraken-api',
    transferGroupId: null,
    swapGroupId: null,
    settlesTransactionId: null,
    priceNative: null,
    priceNativeTokenId: null,
    metadataIncome: null,
    metadataFeeOf: null,
    ...facts,
  };
}

function mapped(overrides: Partial<Mapped>): Mapped {
  return {
    excluded: null,
    ledgerKind: null,
    kindSubtype: null,
    groupId: null,
    feeOf: null,
    executionPrice: null,
    executionPriceTokenId: null,
    kindOrigin: 'source',
    unmappedKind: null,
    ...overrides,
  };
}

describe('mapLegacyEntry: excluded rows', () => {
  test('opening_balance is an opening row, not evidence', () => {
    expect(mapLegacyEntry(row({ kind: 'opening_balance' }))).toEqual({ excluded: 'opening-row' });
  });

  test('correction is a legacy correction row, restated as a snapshot cause', () => {
    expect(mapLegacyEntry(row({ kind: 'correction', source: 'user-balance-correction' }))).toEqual({
      excluded: 'legacy-correction-row',
    });
  });
});

describe('mapLegacyEntry: trade legs', () => {
  test('a buy with no swap and no settle groups on its own id and carries its price', () => {
    expect(
      mapLegacyEntry(
        row({ kind: 'buy', id: 'r1', priceNative: '50000', priceNativeTokenId: 'usd' })
      )
    ).toEqual(
      mapped({
        ledgerKind: 'trade_leg',
        groupId: 'r1',
        executionPrice: '50000',
        executionPriceTokenId: 'usd',
      })
    );
  });

  test('a swap_out groups on its swap group', () => {
    expect(mapLegacyEntry(row({ kind: 'swap_out', swapGroupId: 's1' }))).toEqual(
      mapped({ ledgerKind: 'trade_leg', groupId: 's1' })
    );
  });

  test('the swap group wins over the settled trade, which wins over the id', () => {
    expect(
      mapLegacyEntry(row({ kind: 'sell', swapGroupId: 's1', settlesTransactionId: 't9' }))
    ).toEqual(mapped({ ledgerKind: 'trade_leg', groupId: 's1' }));
    expect(mapLegacyEntry(row({ kind: 'swap_in', settlesTransactionId: 't9' }))).toEqual(
      mapped({ ledgerKind: 'trade_leg', groupId: 't9' })
    );
  });

  test('a settle_out groups on the trade it settles and carries no price', () => {
    expect(
      mapLegacyEntry(
        row({
          kind: 'settle_out',
          settlesTransactionId: 't9',
          priceNative: '50000',
          priceNativeTokenId: 'usd',
        })
      )
    ).toEqual(mapped({ ledgerKind: 'trade_leg', groupId: 't9' }));
  });

  test('a settle_in with nothing to settle has no group', () => {
    expect(mapLegacyEntry(row({ kind: 'settle_in' }))).toEqual(
      mapped({ ledgerKind: 'trade_leg', groupId: null })
    );
  });
});

describe('mapLegacyEntry: fees', () => {
  test('a fee on a settled trade is a fee of that trade', () => {
    expect(mapLegacyEntry(row({ kind: 'fee', settlesTransactionId: 't9' }))).toEqual(
      mapped({ ledgerKind: 'fee', feeOf: 't9' })
    );
  });

  test('a fee alone is standalone', () => {
    expect(mapLegacyEntry(row({ kind: 'fee' }))).toEqual(
      mapped({ ledgerKind: 'fee', feeOf: null })
    );
  });
});

describe('mapLegacyEntry: a withholding linked to its dividend (SC-1644)', () => {
  const dividend = '00000000-0000-4000-8000-0000000000d1';

  test('a fee reads its fee_of from the linked fact', () => {
    expect(mapLegacyEntry(row({ kind: 'fee', metadataFeeOf: dividend }))).toEqual(
      mapped({ ledgerKind: 'fee', feeOf: dividend })
    );
  });

  test('a settled trade still wins over the fact', () => {
    expect(
      mapLegacyEntry(row({ kind: 'fee', settlesTransactionId: 't9', metadataFeeOf: dividend }))
    ).toEqual(mapped({ ledgerKind: 'fee', feeOf: 't9' }));
  });

  test('a fact that is not a row id is ignored, so it cannot fail the uuid cast', () => {
    expect(mapLegacyEntry(row({ kind: 'fee', metadataFeeOf: 'not-a-uuid' }))).toEqual(
      mapped({ ledgerKind: 'fee', feeOf: null })
    );
  });

  test('only a fee row reads the fact', () => {
    expect(mapLegacyEntry(row({ kind: 'reward', metadataFeeOf: dividend }))).toEqual(
      mapped({ ledgerKind: 'income', kindSubtype: 'reward' })
    );
  });
});

describe('mapLegacyEntry: deposits, withdrawals and transfers', () => {
  test('a grouped deposit is a transfer in', () => {
    expect(mapLegacyEntry(row({ kind: 'deposit', transferGroupId: 'g1' }))).toEqual(
      mapped({ ledgerKind: 'transfer_in', groupId: 'g1' })
    );
  });

  test('a deposit alone is an inflow', () => {
    expect(mapLegacyEntry(row({ kind: 'deposit' }))).toEqual(mapped({ ledgerKind: 'inflow' }));
  });

  test('a grouped withdraw is a transfer out', () => {
    expect(mapLegacyEntry(row({ kind: 'withdraw', transferGroupId: 'g2' }))).toEqual(
      mapped({ ledgerKind: 'transfer_out', groupId: 'g2' })
    );
  });

  test('a withdraw alone is an outflow', () => {
    expect(mapLegacyEntry(row({ kind: 'withdraw' }))).toEqual(mapped({ ledgerKind: 'outflow' }));
  });

  test('transfer_in and transfer_out keep their kind, grouped when paired', () => {
    expect(mapLegacyEntry(row({ kind: 'transfer_in', transferGroupId: 'g3' }))).toEqual(
      mapped({ ledgerKind: 'transfer_in', groupId: 'g3' })
    );
    expect(mapLegacyEntry(row({ kind: 'transfer_out' }))).toEqual(
      mapped({ ledgerKind: 'transfer_out', groupId: null })
    );
  });
});

describe('mapLegacyEntry: income and pnl', () => {
  test('interest written by an APY payout is apy income, authored by the person', () => {
    expect(mapLegacyEntry(row({ kind: 'interest', source: 'apy-payout' }))).toEqual(
      mapped({ ledgerKind: 'income', kindSubtype: 'apy', kindOrigin: 'person' })
    );
  });

  test('interest from any other source is interest income from the source', () => {
    expect(mapLegacyEntry(row({ kind: 'interest', source: 'kraken-api' }))).toEqual(
      mapped({ ledgerKind: 'income', kindSubtype: 'interest', kindOrigin: 'source' })
    );
  });

  test('reward and airdrop are income of that subtype', () => {
    expect(mapLegacyEntry(row({ kind: 'reward' }))).toEqual(
      mapped({ ledgerKind: 'income', kindSubtype: 'reward' })
    );
    expect(mapLegacyEntry(row({ kind: 'airdrop' }))).toEqual(
      mapped({ ledgerKind: 'income', kindSubtype: 'airdrop' })
    );
  });

  test('a reward the source names a dividend is dividend income (SC-1644)', () => {
    expect(mapLegacyEntry(row({ kind: 'reward', metadataIncome: 'dividend' }))).toEqual(
      mapped({ ledgerKind: 'income', kindSubtype: 'dividend' })
    );
  });

  test('the dividend fact names a subtype of reward only', () => {
    expect(mapLegacyEntry(row({ kind: 'interest', metadataIncome: 'dividend' }))).toEqual(
      mapped({ ledgerKind: 'income', kindSubtype: 'interest' })
    );
    expect(mapLegacyEntry(row({ kind: 'reward', metadataIncome: 'coupon' }))).toEqual(
      mapped({ ledgerKind: 'income', kindSubtype: 'reward' })
    );
  });

  test('a dividend keeps the legacy kind reward, so returns count it as a return, not a contribution', () => {
    expect(flowRoleOf('reward')).toBe('return');
  });

  test('realized_pnl is derivative pnl', () => {
    expect(mapLegacyEntry(row({ kind: 'realized_pnl', source: 'ibkr-api' }))).toEqual(
      mapped({ ledgerKind: 'derivative_pnl' })
    );
  });
});

describe('mapLegacyEntry: unclassified rows', () => {
  test('unknown stays unclassified, with no origin, and is not counted as unmapped', () => {
    expect(mapLegacyEntry(row({ kind: 'unknown' }))).toEqual(
      mapped({ ledgerKind: null, kindOrigin: null, unmappedKind: null })
    );
  });

  test('a kind the table does not name is unclassified, with no origin, and counted by its name', () => {
    expect(mapLegacyEntry(row({ kind: 'rebase' }))).toEqual(
      mapped({ ledgerKind: null, kindOrigin: null, unmappedKind: 'rebase' })
    );
  });

  test('a person-authored row that is not classified has no origin either', () => {
    expect(mapLegacyEntry(row({ kind: 'unknown', source: 'user-entered' }))).toEqual(
      mapped({ ledgerKind: null, kindOrigin: null, unmappedKind: null })
    );
    expect(mapLegacyEntry(row({ kind: 'rebase', source: 'apy-payout' }))).toEqual(
      mapped({ ledgerKind: null, kindOrigin: null, unmappedKind: 'rebase' })
    );
  });
});

describe('mapLegacyEntry: kind origin', () => {
  test('a row a person typed is person-origin', () => {
    expect(mapLegacyEntry(row({ kind: 'deposit', source: 'user-entered' }))).toEqual(
      mapped({ ledgerKind: 'inflow', kindOrigin: 'person' })
    );
  });

  test.each([
    'user-entered',
    'user-balance-edit',
    'user-balance-correction',
    'transfer-review',
    'apy-payout',
  ])('%s is a person source', (source) => {
    const result = mapLegacyEntry(row({ kind: 'deposit', source }));
    expect(result.excluded === null && result.kindOrigin).toBe('person');
  });

  test.each(['kraken-api', 'etherscan', 'statement-csv', 'reconciliation-opening', 'screenshot'])(
    '%s is a source-origin row',
    (source) => {
      const result = mapLegacyEntry(row({ kind: 'withdraw', source }));
      expect(result.excluded === null && result.kindOrigin).toBe('source');
    }
  );
});

describe('inputSourceClass', () => {
  const cases: Array<[string, InputSourceClass]> = [
    ['kraken-api', 'provider'],
    ['statement-csv', 'statement'],
    ['budget-ynab', 'statement'],
    ['budget-actual', 'statement'],
    ['etherscan', 'wallet'],
    ['solana', 'wallet'],
    ['user-balance-edit', 'none'],
    ['reconciliation-opening', 'none'],
    ['transfer-review', 'none'],
    ['screenshot', 'none'],
    ['demo-dataset', 'none'],
    ['user-entered', 'none'],
    ['apy-payout', 'none'],
    ['rule', 'none'],
    ['some-tag-nobody-writes', 'none'],
  ];

  test.each(cases)('%s → %s', (source, expected) => {
    expect(inputSourceClass(source)).toBe(expected);
  });

  test('every CEX ledger source is a provider source', () => {
    for (const source of Object.keys(CEX_SOURCE_TO_INSTITUTION)) {
      expect(inputSourceClass(source)).toBe('provider');
    }
  });

  test('every non-EVM wallet source is a wallet source', () => {
    expect(NON_EVM_WALLET_SOURCES.size).toBeGreaterThan(0);
    for (const source of NON_EVM_WALLET_SOURCES) {
      expect(inputSourceClass(source)).toBe('wallet');
    }
  });

  test('the sources a feed input is planned under classify as that input', () => {
    expect(inputSourceClass('statement')).toBe('statement');
    expect(inputSourceClass('wallet')).toBe('wallet');
    expect(inputSourceClass('provider:wise')).toBe('provider');
  });
});
