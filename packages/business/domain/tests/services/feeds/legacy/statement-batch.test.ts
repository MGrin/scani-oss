import { describe, expect, test } from 'bun:test';
import type { StatementIngesterResult, StatementRow } from '@scani/ingesters';
import { validateBatch } from '../../../../src/services/feeds/blocks/validate-batch';
import type { AssetRef } from '../../../../src/services/feeds/feed-batch';
import { legacyStatementBatch } from '../../../../src/services/feeds/legacy/statement-batch';

const D1 = new Date('2026-08-01T10:00:00Z');
const D2 = new Date('2026-08-02T09:00:00Z');
const D3 = new Date('2026-08-06T18:00:00Z');
const FETCHED = new Date('2026-08-12T09:00:00Z');
const NOW = new Date('2026-09-01T00:00:00Z');

const row = (fields: Partial<StatementRow> & Pick<StatementRow, 'externalId'>): StatementRow => ({
  kind: 'deposit',
  quantity: '10',
  occurredAt: D1,
  source: 'statement-csv',
  counterparty: null,
  sourceMetadata: { description: 'a row', bankTemplate: 'revolut', format: 'csv' },
  rawPayload: null,
  ...fields,
});

const statement = (fields: Partial<StatementIngesterResult> = {}): StatementIngesterResult => ({
  format: 'csv',
  bankTemplate: 'revolut',
  lines: [
    {
      currency: 'EUR',
      rows: [row({ externalId: 'e1', quantity: '1000', counterparty: 'ACME' })],
    },
    {
      skipped: 'Transaction without currency at 2026-08-01T12:00:00.000Z — skipped',
      at: new Date('2026-08-01T12:00:00Z'),
    },
    {
      currency: 'EUR',
      rows: [
        row({
          externalId: 'e2',
          kind: 'withdraw',
          quantity: '-120',
          occurredAt: D2,
          rawPayload: { Amount: '-120.00' },
        }),
        row({ externalId: 'e2:fee', kind: 'fee', quantity: '-1.5', occurredAt: D2 }),
      ],
    },
    {
      currency: 'USD',
      rows: [row({ externalId: 'u1', kind: 'withdraw', quantity: '-3.5', occurredAt: D3 })],
    },
  ],
  closes: [{ currency: 'USD', at: D3, balance: '855' }],
  positions: [],
  warnings: [],
  ...fields,
});

const batchOf = (result: StatementIngesterResult) =>
  legacyStatementBatch({
    userId: 'user-1',
    accountId: 'account-1',
    result,
    uploadRef: 'temp/file-import/user-1/upload.csv',
    fetchedAt: FETCHED,
  });

const catalog = (symbol: string): AssetRef => ({
  identity: { symbol, name: symbol },
  typeCode: 'fiat',
  lookup: 'catalog-symbol',
});

describe('legacyStatementBatch', () => {
  test("a statement becomes one batch on the account's statement input, valid as it stands", () => {
    const batch = batchOf(statement());

    expect({
      userId: batch.userId,
      input: batch.input,
      fetchedAt: batch.fetchedAt,
      absences: batch.absences,
      notices: batch.notices,
    }).toEqual({
      userId: 'user-1',
      input: { accountId: 'account-1', source: 'statement', credentialId: null, walletId: null },
      fetchedAt: FETCHED,
      absences: [],
      notices: [],
    });
    expect(validateBatch(batch, NOW)).toEqual([]);
  });

  test('each row is an entry in its currency, found in the catalog by symbol, with the columns the statement wrote', () => {
    expect(batchOf(statement()).entries).toEqual([
      {
        externalId: 'e1',
        asset: catalog('EUR'),
        amount: '1000',
        occurredAt: D1,
        counterparty: 'ACME',
        legacy: {
          kind: 'deposit',
          source: 'statement-csv',
          sourceMetadata: { description: 'a row', bankTemplate: 'revolut', format: 'csv' },
          rawPayload: null,
        },
      },
      {
        externalId: 'e2',
        asset: catalog('EUR'),
        amount: '-120',
        occurredAt: D2,
        legacy: {
          kind: 'withdraw',
          source: 'statement-csv',
          sourceMetadata: { description: 'a row', bankTemplate: 'revolut', format: 'csv' },
          rawPayload: { Amount: '-120.00' },
        },
      },
      {
        externalId: 'e2:fee',
        asset: catalog('EUR'),
        amount: '-1.5',
        occurredAt: D2,
        legacy: {
          kind: 'fee',
          source: 'statement-csv',
          sourceMetadata: { description: 'a row', bankTemplate: 'revolut', format: 'csv' },
          rawPayload: null,
        },
      },
      {
        externalId: 'u1',
        asset: catalog('USD'),
        amount: '-3.5',
        occurredAt: D3,
        legacy: {
          kind: 'withdraw',
          source: 'statement-csv',
          sourceMetadata: { description: 'a row', bankTemplate: 'revolut', format: 'csv' },
          rawPayload: null,
        },
      },
    ]);
  });

  test('the window runs from the first row to the last and carries the upload', () => {
    expect(batchOf(statement()).window).toEqual({
      shape: 'statement-upload',
      from: D1,
      to: D3,
      complete: false,
      uploadRef: 'temp/file-import/user-1/upload.csv',
    });
  });

  test('the close is a statement checkpoint written as the statement-close row was', () => {
    expect(batchOf(statement()).checkpoints).toEqual([
      {
        asset: catalog('USD'),
        at: D3,
        amount: '855',
        authority: 'statement',
        legacySource: 'statement-close',
        legacyMeta: { format: 'csv', bankTemplate: 'revolut' },
      },
    ]);
    expect(batchOf(statement({ closes: [], bankTemplate: null })).checkpoints).toEqual([]);
  });

  test("the options are the file import's: account-token matching, the cache from the close or the rows, and no balance copy", () => {
    expect(batchOf(statement()).legacy).toEqual({
      holdingMatch: 'account-token',
      holdingPolicy: 'create',
      holdingSource: 'statement-import',
      arrival: 'user_confirmed',
      writesCache: true,
      createdWithoutCheckpoint: 'sum-of-entries',
      derivesTradeLegs: false,
      holdingFailure: 'fail-batch',
      absence: null,
      clearsAbsenceTally: false,
      createdCheckpointMeta: null,
      unchangedCheckpoint: 'append',
      zeroOpensHolding: true,
    });
  });

  // The window is what the file covered, not what could be imported (ruling R25).
  test('a row with no currency bounds the window, though it is no entry', () => {
    const before = new Date('2026-07-30T08:00:00Z');
    const after = new Date('2026-08-09T20:00:00Z');
    const batch = batchOf(
      statement({
        lines: [
          { skipped: 'no currency', at: after },
          { currency: 'EUR', rows: [row({ externalId: 'e1', occurredAt: D2 })] },
          { skipped: 'no currency', at: before },
        ],
        closes: [],
      })
    );

    expect({
      window: batch.window,
      entries: batch.entries.map((entry) => entry.externalId),
    }).toEqual({
      window: {
        shape: 'statement-upload',
        from: before,
        to: after,
        complete: false,
        uploadRef: 'temp/file-import/user-1/upload.csv',
      },
      entries: ['e1'],
    });
    expect(validateBatch(batch, NOW)).toEqual([]);
  });

  // SC-1529, an exception to D-1 by the feeds owner's ruling: a positions
  // statement's holdings become statement checkpoints, a security found by its
  // ticker within the stock type, and its date alone bounds the window.
  test('a positions statement: ending cash and securities are statement checkpoints at the period end', () => {
    const asOf = new Date('2026-04-15T23:59:59.999Z');
    const batch = batchOf(
      statement({
        format: 'ib-csv',
        bankTemplate: 'interactive-brokers',
        lines: [],
        closes: [{ currency: 'USD', at: asOf, balance: '10901.12' }],
        positions: [{ symbol: 'AAPL', at: asOf, quantity: '10.0545' }],
      })
    );
    const meta = { format: 'ib-csv', bankTemplate: 'interactive-brokers' };
    expect(batch.checkpoints).toEqual([
      {
        asset: catalog('USD'),
        at: asOf,
        amount: '10901.12',
        authority: 'statement',
        legacySource: 'statement-close',
        legacyMeta: meta,
      },
      {
        asset: {
          identity: { symbol: 'AAPL', name: 'AAPL' },
          typeCode: 'stock',
          lookup: 'catalog-symbol-of-type',
        },
        at: asOf,
        amount: '10.0545',
        authority: 'statement',
        legacySource: 'statement-close',
        legacyMeta: meta,
      },
    ]);
    expect(batch.entries).toEqual([]);
    expect(batch.window).toMatchObject({ from: asOf, to: asOf });
  });

  test('a statement with no row at all has no window to declare', () => {
    expect(() => batchOf(statement({ lines: [], closes: [] }))).toThrow(
      'a statement-upload needs at least one date'
    );
  });
});
