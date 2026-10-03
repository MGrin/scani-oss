import { describe, expect, it } from 'bun:test';
import type { ParsedTransaction, ParseResult } from '@scani/file-import';
import {
  type StatementIngesterResult,
  StatementTransactionIngester,
  statementWarnings,
} from '../src/StatementTransactionIngester';

const makeParseResult = (
  transactions: ParsedTransaction[],
  overrides: Partial<ParseResult> = {}
): ParseResult => ({
  transactions,
  holdings: [],
  format: 'csv',
  warnings: [],
  ...overrides,
});

const ingest = (
  transactions: ParsedTransaction[],
  overrides: Partial<ParseResult> = {},
  defaultCurrency?: string
) =>
  new StatementTransactionIngester().ingest({
    accountId: 'a1',
    parseResult: makeParseResult(transactions, overrides),
    defaultCurrency,
  });

/** Each line as its currency and the external ids of its rows; a skipped one as its warning. */
const shapeOf = (result: StatementIngesterResult) =>
  result.lines.map((line) =>
    'skipped' in line ? line.skipped : [line.currency, line.rows.map((row) => row.externalId)]
  );

const rowsOf = (result: StatementIngesterResult) =>
  result.lines.flatMap((line) => ('skipped' in line ? [] : line.rows));

describe('StatementTransactionIngester', () => {
  it('returns empty result when ParseResult has no transactions', () => {
    const result = ingest([]);
    expect(result.lines).toEqual([]);
    expect(result.closes).toEqual([]);
  });

  it('keys each row by its currency, upper-cased, and tags its source by format', () => {
    const result = ingest(
      [
        { date: new Date('2024-03-15'), description: 'Coffee', amount: -5, currency: 'usd' },
        { date: new Date('2024-03-16'), description: 'Salary', amount: 1000, currency: ' USD ' },
        { date: new Date('2024-03-17'), description: 'Lunch', amount: -12, currency: 'EUR' },
      ],
      { format: 'csv', bankTemplate: 'wise' }
    );
    expect(result.lines.map((line) => ('skipped' in line ? null : line.currency))).toEqual([
      'USD',
      'USD',
      'EUR',
    ]);
    expect(rowsOf(result).map((row) => row.source)).toEqual([
      'statement-csv',
      'statement-csv',
      'statement-csv',
    ]);
    expect({ format: result.format, bankTemplate: result.bankTemplate }).toEqual({
      format: 'csv',
      bankTemplate: 'wise',
    });
  });

  it('names no holding and no token: the write path resolves both from the currency', () => {
    const [row] = rowsOf(
      ingest([{ date: new Date('2024-03-15'), description: 'x', amount: 1, currency: 'USD' }])
    );
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'counterparty',
      'externalId',
      'kind',
      'occurredAt',
      'quantity',
      'rawPayload',
      'source',
      'sourceMetadata',
    ]);
  });

  it('maps positive amounts to deposit and negative to withdraw', () => {
    const result = ingest([
      { date: new Date('2024-03-15'), description: 'pos', amount: 50, currency: 'EUR' },
      { date: new Date('2024-03-15'), description: 'neg', amount: -25, currency: 'EUR' },
    ]);
    expect(rowsOf(result).map((row) => [row.kind, row.quantity])).toEqual([
      ['deposit', '50'],
      ['withdraw', '-25'],
    ]);
  });

  it('falls back to defaultCurrency, then detectedCurrency, when a row has no currency', () => {
    const txs: ParsedTransaction[] = [
      { date: new Date('2024-03-15'), description: 'no-currency', amount: 10, currency: '' },
    ];
    const currencies = (result: StatementIngesterResult) =>
      result.lines.map((line) => ('skipped' in line ? null : line.currency));

    expect(currencies(ingest(txs, { detectedCurrency: 'GBP' }))).toEqual(['GBP']);
    expect(currencies(ingest(txs, {}, 'chf'))).toEqual(['CHF']);
    // The currency a person picked wins over the one the parser detected.
    expect(currencies(ingest(txs, { detectedCurrency: 'GBP' }, 'CHF'))).toEqual(['CHF']);
  });

  it('skips a row no currency can be derived for, with a warning in its place', () => {
    const result = ingest([
      { date: new Date('2024-03-15'), description: 'kept', amount: 10, currency: 'EUR' },
      { date: new Date('2024-03-16'), description: 'orphan', amount: 10, currency: '' },
    ]);
    expect(shapeOf(result)).toEqual([
      ['EUR', ['synthetic:2024-03-15T00:00:00:10:kept:1']],
      'Transaction without currency at 2024-03-16T00:00:00.000Z — skipped (consider setting defaultCurrency on the account)',
    ]);
    // It keeps its date: the statement covered that day whether or not the row was imported.
    expect(result.lines[1]).toMatchObject({ at: new Date('2024-03-16') });
  });

  it('emits a closing balance when the last row has one', () => {
    const result = ingest([
      { date: new Date('2024-03-15'), description: 'a', amount: 100, currency: 'USD' },
      { date: new Date('2024-03-16'), description: 'b', amount: -25, currency: 'usd', balance: 75 },
    ]);
    expect(result.closes).toEqual([{ currency: 'USD', at: new Date('2024-03-16'), balance: '75' }]);
  });

  it('takes the close from the last row by date, whatever its place in the file', () => {
    const result = ingest([
      {
        date: new Date('2024-03-17'),
        description: 'newest',
        amount: -1,
        currency: 'EUR',
        balance: 9,
      },
      {
        date: new Date('2024-03-15'),
        description: 'oldest',
        amount: 10,
        currency: 'USD',
        balance: 10,
      },
    ]);
    expect(result.closes).toEqual([{ currency: 'EUR', at: new Date('2024-03-17'), balance: '9' }]);
  });

  it('does not emit a closing balance when the last row lacks one, or lacks a currency', () => {
    expect(
      ingest([{ date: new Date('2024-03-15'), description: 'a', amount: 100, currency: 'USD' }])
        .closes
    ).toEqual([]);
    expect(
      ingest([
        { date: new Date('2024-03-15'), description: 'a', amount: 100, currency: '', balance: 100 },
      ]).closes
    ).toEqual([]);
  });

  it('uses natural external-id when raw payload exposes one', () => {
    const result = ingest(
      [
        {
          date: new Date('2024-03-15'),
          description: 'tagged',
          amount: 10,
          currency: 'USD',
          raw: { fitid: 'OFX-12345' },
        },
      ],
      { format: 'ofx' }
    );
    expect(rowsOf(result)[0]?.externalId).toBe('natural:OFX-12345');
  });

  it('synthesizes external-id from (date, amount, description, ordinal) otherwise', () => {
    const [first, second] = rowsOf(
      ingest([
        {
          date: new Date('2024-03-15T10:00:00Z'),
          description: 'first',
          amount: 1,
          currency: 'USD',
        },
        {
          date: new Date('2024-03-15T10:00:00Z'),
          description: 'second',
          amount: 2,
          currency: 'USD',
        },
      ])
    );
    expect(first?.externalId).toMatch(/^synthetic:.*:1:first:1$/);
    expect(second?.externalId).toMatch(/^synthetic:.*:2:second:2$/);
    // Distinct external_ids guarantee re-uploads dedup row-by-row.
    expect(first?.externalId).not.toBe(second?.externalId);
  });
});

describe('statementWarnings', () => {
  const unknown = (currency: string) =>
    `Unknown currency '${currency}' — statement rows for this currency skipped`;
  const result = ingest(
    [
      { date: new Date('2024-03-15'), description: 'a', amount: 1, currency: 'XYZ' },
      { date: new Date('2024-03-16'), description: 'b', amount: 2, currency: '' },
      { date: new Date('2024-03-17'), description: 'c', amount: 3, currency: 'EUR' },
      { date: new Date('2024-03-18'), description: 'd', amount: 4, currency: 'XYZ', fee: 1 },
      { date: new Date('2024-03-19'), description: 'e', amount: 5, currency: 'QQQ', balance: 15 },
    ],
    { warnings: ['Column mapping detected by AI'] }
  );
  const orphan =
    'Transaction without currency at 2024-03-16T00:00:00.000Z — skipped (consider setting defaultCurrency on the account)';

  it("lists the parser's warnings, then one per transaction in file order, then the close's", () => {
    expect(statementWarnings(result, new Set(['XYZ', 'QQQ']))).toEqual([
      'Column mapping detected by AI',
      unknown('XYZ'),
      orphan,
      // Once for the transaction, though it wrote a row and a fee row.
      unknown('XYZ'),
      unknown('QQQ'),
      // And once more for the close in that currency.
      unknown('QQQ'),
    ]);
  });

  it('says nothing of a currency the write path placed', () => {
    expect(statementWarnings(result, new Set())).toEqual(['Column mapping detected by AI', orphan]);
    expect(statementWarnings(result, new Set(['QQQ']))).toEqual([
      'Column mapping detected by AI',
      orphan,
      unknown('QQQ'),
      unknown('QQQ'),
    ]);
  });
});
