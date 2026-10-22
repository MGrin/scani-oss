import { describe, expect, test } from 'bun:test';
import { extractCounterparty } from '../../src/core/counterparty';

// This runs over every historical `holding_transactions` row during the
// backfill sweep (~1850 rows of unstructured `raw_payload` on first run,
// then every new row going forward). One shape we didn't anticipate must
// yield `{}`, not an exception that aborts the batch — see
// `packages/business/domain/src/services/reviewDetail.ts` for the same
// discipline applied to the review feed.

describe('extractCounterparty — wise', () => {
  // Shape from `WiseStatementTransaction` (packages/clients/providers/src/providers/wise/index.ts):
  // `{ type, date, amount, totalFees?, details?: { type?, description? }, referenceNumber }`.
  // `details.description` is the only free-text field the statement API
  // gives us — Wise has no separate structured payee field in our type.
  test('reads the merchant name off a CARD row', () => {
    const raw = {
      type: 'DEBIT',
      date: '2025-01-20T16:30:00.000Z',
      amount: { value: 35, currency: 'EUR' },
      totalFees: { value: 0, currency: 'EUR' },
      details: { type: 'CARD', description: 'Whole Foods Market' },
      referenceNumber: 'CARD-7',
    };
    expect(extractCounterparty('wise-api', raw)).toEqual({
      counterparty: 'Whole Foods Market',
      description: 'Whole Foods Market',
    });
  });

  test('reads the sender off a DEPOSIT row', () => {
    const raw = {
      type: 'CREDIT',
      date: '2025-01-10T12:00:00.000Z',
      amount: { value: 1000, currency: 'USD' },
      totalFees: { value: 0, currency: 'USD' },
      details: { type: 'DEPOSIT', description: 'ACME Corp Payroll' },
      referenceNumber: 'DEP-1',
    };
    expect(extractCounterparty('wise-api', raw)).toEqual({
      counterparty: 'ACME Corp Payroll',
      description: 'ACME Corp Payroll',
    });
  });

  test('returns {} for a CONVERSION row — no payee, correctly', () => {
    // Real fixture shape (packages/clients/providers/tests/providers/wise.test.ts):
    // CONVERSION rows carry no `description` at all.
    const raw = {
      type: 'CREDIT',
      date: '2025-01-15T08:00:00.000Z',
      amount: { value: 500, currency: 'USD' },
      totalFees: { value: 0, currency: 'USD' },
      details: { type: 'CONVERSION' },
      referenceNumber: 'CONV-1',
    };
    expect(extractCounterparty('wise-api', raw)).toEqual({});
  });

  test('returns {} for the sibling fee row, which carries no details', () => {
    // Emitted by `mapTransaction`'s fee sibling: `{ referenceNumber, totalFees }`.
    const raw = { referenceNumber: 'TRANS-1', totalFees: { value: 2, currency: 'EUR' } };
    expect(extractCounterparty('wise-api', raw)).toEqual({});
  });

  test('also dispatches on the bare "wise" source tag', () => {
    const raw = { details: { type: 'CARD', description: 'Uber' } };
    expect(extractCounterparty('wise', raw)).toEqual({ counterparty: 'Uber', description: 'Uber' });
  });
});

describe('extractCounterparty — airwallex', () => {
  // Shape from `AirwallexFinancialTransaction` (packages/clients/providers/src/providers/airwallex/index.ts):
  // `{ id, amount?, currency?, source_type?, financial_transaction_type?, status?, created_at?, description? }`.
  test('reads the typed description field off a PAYOUT row', () => {
    const raw = {
      id: 'tx-2',
      amount: -200,
      currency: 'EUR',
      source_type: 'PAYOUT',
      created_at: '2025-01-11T12:00:00.000Z',
      description: 'Payment to Acme Supplies Ltd',
    };
    expect(extractCounterparty('airwallex-api', raw)).toEqual({
      counterparty: 'Payment to Acme Supplies Ltd',
      description: 'Payment to Acme Supplies Ltd',
    });
  });

  test('returns {} when description is absent — real rows omit it', () => {
    const raw = {
      id: 'tx-1',
      amount: 1000,
      currency: 'USD',
      source_type: 'DEPOSIT',
      created_at: '2025-01-10T12:00:00.000Z',
    };
    expect(extractCounterparty('airwallex-api', raw)).toEqual({});
  });

  test('trims whitespace-only description to {}', () => {
    const raw = { id: 'tx-9', description: '   ' };
    expect(extractCounterparty('airwallex-api', raw)).toEqual({});
  });
});

describe('extractCounterparty — bunq', () => {
  // Shape: the trimmed `Payment` the bunq provider stores (SC-1729), whose
  // fields are the sandbox's own names.
  test('keeps the payee and the statement line apart, since bunq names both', () => {
    const raw = {
      id: 35793980,
      description: 'Coffee',
      counterparty_alias: { display_name: 'Sugar Daddy', iban: 'NL00BUNQ0000000002' },
    };
    expect(extractCounterparty('bunq-api', raw)).toEqual({
      counterparty: 'Sugar Daddy',
      description: 'Coffee',
    });
  });

  test('a payment with no description still names its payee', () => {
    const raw = { id: 1, counterparty_alias: { display_name: 'Sugar Daddy' } };
    expect(extractCounterparty('bunq', raw)).toEqual({ counterparty: 'Sugar Daddy' });
  });

  for (const value of [null, {}, { counterparty_alias: null }, { description: 42 }]) {
    test(`${JSON.stringify(value)} returns {} rather than throwing`, () => {
      expect(extractCounterparty('bunq-api', value)).toEqual({});
    });
  }
});

describe('extractCounterparty — investec', () => {
  // Shape: the trimmed transaction the Investec provider stores (SC-1731),
  // whose fields are the sandbox's own names.
  test('uses the statement line for both, since Investec gives nothing else', () => {
    const raw = { uuid: '87446202607140010600', description: 'CORNER CAFE CAPE TOWN ZA' };
    expect(extractCounterparty('investec-api', raw)).toEqual({
      counterparty: 'CORNER CAFE CAPE TOWN ZA',
      description: 'CORNER CAFE CAPE TOWN ZA',
    });
  });

  for (const value of [null, {}, { description: '' }, { description: 42 }]) {
    test(`${JSON.stringify(value)} returns {} rather than throwing`, () => {
      expect(extractCounterparty('investec', value)).toEqual({});
    });
  }
});

describe('extractCounterparty — fio', () => {
  // Shape: the trimmed movement the Fio provider stores (SC-1732).
  test('keeps the other party and the message apart, since Fio names both', () => {
    const raw = { id: 1148734530, counterpartyName: 'Pavel, Novák', message: 'Nájem' };
    expect(extractCounterparty('fio-api', raw)).toEqual({
      counterparty: 'Pavel, Novák',
      description: 'Nájem',
    });
  });

  test('the account number stands in for a missing name', () => {
    const raw = { id: 1, counterpartyAccount: '2900233333', comment: 'Rent' };
    expect(extractCounterparty('fio', raw)).toEqual({
      counterparty: '2900233333',
      description: 'Rent',
    });
  });

  for (const value of [null, {}, { counterpartyName: '' }, { message: 42 }]) {
    test(`${JSON.stringify(value)} returns {} rather than throwing`, () => {
      expect(extractCounterparty('fio-api', value)).toEqual({});
    });
  }
});

describe('extractCounterparty — asset-centric sources have no payee, by design', () => {
  // Crypto exchange trades and chain swaps have no counterparty to find —
  // returning {} for them is correct, not a gap. No extractor is
  // registered for these sources; the Record lookup itself is the "no".
  const assetCentricSources = [
    'kraken-api',
    'binance-api',
    'coinbase-api',
    'etherscan',
    'solana',
    'ibkr-api',
  ];

  for (const source of assetCentricSources) {
    test(`${source} yields {} even with a rich raw_payload`, () => {
      expect(
        extractCounterparty(source, { pair: 'BTC/USD', type: 'buy', description: 'irrelevant' })
      ).toEqual({});
    });
  }
});

describe('extractCounterparty — must never throw on an unexpected shape', () => {
  const junk: unknown[] = [
    null,
    undefined,
    {},
    [],
    'a string',
    42,
    true,
    { details: null },
    { details: undefined },
    { details: 'not-an-object' },
    { details: [] },
    { details: 42 },
    { details: {} },
    { details: { description: null } },
    { details: { description: 42 } },
    { details: { description: {} } },
    { details: { description: [] } },
    { description: null },
    { description: 42 },
    { description: {} },
    { description: [] },
  ];

  for (const source of ['wise-api', 'wise', 'airwallex-api', 'airwallex']) {
    for (const [i, value] of junk.entries()) {
      test(`${source} shape ${i} returns {} rather than throwing`, () => {
        let out: ReturnType<typeof extractCounterparty> | undefined;
        expect(() => {
          out = extractCounterparty(source, value);
        }).not.toThrow();
        expect(out).toEqual({});
      });
    }
  }

  test('an unknown source yields {} rather than a guess', () => {
    expect(extractCounterparty('some-future-provider', { description: 'Acme' })).toEqual({});
  });
});
