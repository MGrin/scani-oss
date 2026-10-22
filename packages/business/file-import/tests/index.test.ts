import { describe, expect, it } from 'bun:test';
import { parseStatement } from '../src/index';

describe('parseStatement (unified entry point)', () => {
  it('should auto-detect and parse CSV by filename', async () => {
    const csv = 'date,description,amount\n2024-03-15,Test,100.00';
    const result = await parseStatement(csv, 'statement.csv');
    expect(result.format).toBe('csv');
    expect(result.transactions).toHaveLength(1);
  });

  it('should auto-detect and parse OFX by filename', async () => {
    const ofx = 'OFXHEADER:100\nDATA:OFXSGML\n<OFX></OFX>';
    const result = await parseStatement(ofx, 'bank.ofx');
    expect(result.format).toBe('ofx');
  });

  it('should parse MT940 under the name the worker gives an upload', async () => {
    const mt940 = await Bun.file(`${import.meta.dir}/fixtures/mt940-raiffeisenbank-cz.sta`).text();
    const result = await parseStatement(mt940, 'import.mt940');
    expect(result.format).toBe('mt940');
    expect(result.transactions).toHaveLength(12);
    expect(result.positions?.cash).toEqual([{ currency: 'CZK', balance: '22176896.1' }]);
  });

  it('should parse CAMT.053 under the name the worker gives an upload', async () => {
    const camt = await Bun.file(`${import.meta.dir}/fixtures/camt053-mbank-pl.xml`).text();
    const result = await parseStatement(camt, 'import.camt053');
    expect(result.format).toBe('camt053');
    expect(result.transactions).toHaveLength(2);
    expect(result.positions?.cash).toEqual([{ currency: 'PLN', balance: '0' }]);
  });

  it('should return warning for undetectable format', async () => {
    const result = await parseStatement('just plain text');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('should pass bank template to CSV parser', async () => {
    const csv =
      'Started Date,Description,Amount,Currency,Balance\n2024-03-15 10:00:00,Test,50,EUR,50';
    const result = await parseStatement(csv, 'revolut.csv', { bankTemplate: 'revolut' });
    expect(result.bankTemplate).toBe('revolut');
    expect(result.transactions).toHaveLength(1);
  });

  it('should pass custom mapping to CSV parser', async () => {
    const csv = 'Fecha,Concepto,Monto\n15/03/2024,Pago,100';
    const result = await parseStatement(csv, 'banco.csv', {
      customMapping: {
        date: 'Fecha',
        description: 'Concepto',
        amount: 'Monto',
      },
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.description).toBe('Pago');
  });

  it('passes the caller-supplied date order through to the CSV and QIF parsers (SC-1291)', async () => {
    const csv = 'Date,Description,Amount,Currency\n03/04/2026,A,-1,EUR\n05/06/2026,B,-1,EUR';
    expect((await parseStatement(csv, 'x.csv')).ambiguousDateOrder?.rowCount).toBe(2);
    const csvDay = await parseStatement(csv, 'x.csv', { dateOrder: 'day-first' });
    expect(csvDay.transactions[0]!.date.toISOString().slice(0, 10)).toBe('2026-04-03');

    const qif = '!Type:Bank\nD03/04/2026\nT-1\nPA\n^';
    const qifMonth = await parseStatement(qif, 'x.qif', { dateOrder: 'month-first' });
    expect(qifMonth.transactions[0]!.date.toISOString().slice(0, 10)).toBe('2026-03-04');
  });
});

describe('parseStatement: a currency the file names is suggested, never applied (SC-1735)', () => {
  const bytesOf = async (name: string) =>
    new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer());

  it('a CSV whose amounts carry € suggests EUR and leaves the rows without a currency', async () => {
    const csv = 'Date,Description,Amount\n2026-01-02,Coffee,€ -3.50\n2026-01-03,Salary,€ 1200.00\n';
    const result = await parseStatement(csv, 'statement.csv');
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions.every((t) => !t.currency)).toBe(true);
    expect(result.detectedCurrency).toBeUndefined();
    expect(result.suggestedCurrency).toBe('EUR');
  });

  it('the Webank sheet names no currency, so nothing is suggested', async () => {
    const result = await parseStatement(await bytesOf('xls-html-webank-it.xls'), 'import.xls', {
      customMapping: {
        date: 'Data Contabile',
        description: 'Causale / Descrizione',
        amount: 'Importo',
      },
      dateOrder: 'day-first',
    });
    expect(result.transactions).toHaveLength(26);
    expect(result.suggestedCurrency).toBeUndefined();
  });

  it('Intesa, mapped without its currency column, suggests the EUR that column holds', async () => {
    const result = await parseStatement(await bytesOf('xlsx-intesa-it.xlsx'), 'import.xlsx', {
      customMapping: { date: 'Data', description: 'Dettagli', amount: 'Importo' },
    });
    expect(result.transactions).toHaveLength(179);
    expect(result.suggestedCurrency).toBe('EUR');
  });

  it('a sheet whose preamble says USD while its amounts carry € suggests nothing', async () => {
    const html = [
      '<html><body><table>',
      '<tr><td>Conto</td><td>12345</td></tr>',
      '<tr><td>Divisa</td><td>USD</td></tr>',
      '<tr><td>Date</td><td>Description</td><td>Amount</td><td>Balance</td></tr>',
      '<tr><td>2026-01-02</td><td>Coffee</td><td>€ -3.50</td><td>96.50</td></tr>',
      '</table></body></html>',
    ].join('');
    const result = await parseStatement(new TextEncoder().encode(html), 'import.xls');
    expect(result.transactions).toHaveLength(1);
    expect(result.suggestedCurrency).toBeUndefined();
  });

  it('a sheet whose preamble names the currency suggests it', async () => {
    const html = [
      '<html><body><table>',
      '<tr><td>Conto</td><td>12345</td></tr>',
      '<tr><td>Divisa</td><td>CHF</td></tr>',
      '<tr><td>Date</td><td>Description</td><td>Amount</td><td>Balance</td></tr>',
      '<tr><td>2026-01-02</td><td>Coffee</td><td>-3.50</td><td>96.50</td></tr>',
      '</table></body></html>',
    ].join('');
    const result = await parseStatement(new TextEncoder().encode(html), 'import.xls');
    expect(result.transactions).toHaveLength(1);
    expect(result.suggestedCurrency).toBe('CHF');
  });
});

describe('parseStatement: spreadsheets go through the CSV mapping (SC-1734)', () => {
  const bytesOf = async (name: string) =>
    new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer());

  it('an XLSX with headers no template knows asks for a column mapping, under its own format', async () => {
    const result = await parseStatement(await bytesOf('xlsx-intesa-it.xlsx'), 'import.xlsx');
    expect(result.format).toBe('xlsx');
    expect(result.transactions).toHaveLength(0);
    expect(result.needsColumnMapping?.headers).toEqual([
      'Data',
      'Operazione',
      'Dettagli',
      'Categoria',
      'Valuta',
      'Importo',
    ]);
    expect(result.needsColumnMapping?.rowCount).toBe(179);
  });

  it('the same XLSX imports once the columns are mapped', async () => {
    const result = await parseStatement(await bytesOf('xlsx-intesa-it.xlsx'), 'import.xlsx', {
      customMapping: {
        date: 'Data',
        description: 'Dettagli',
        amount: 'Importo',
        currency: 'Valuta',
      },
    });
    expect(result.format).toBe('xlsx');
    expect(result.transactions).toHaveLength(179);
    expect(result.transactions[0]?.date.toISOString()).toBe('2025-06-01T00:00:00.000Z');
    expect(result.transactions[0]?.amount).toBe(-850);
    expect(result.transactions[0]?.currency).toBe('EUR');
  });

  it('an HTML table served as .xls imports through the same mapping, decimal commas and all', async () => {
    const result = await parseStatement(await bytesOf('xls-html-webank-it.xls'), 'import.xls', {
      customMapping: {
        date: 'Data Contabile',
        description: 'Causale / Descrizione',
        amount: 'Importo',
      },
      dateOrder: 'day-first',
    });
    expect(result.format).toBe('xls');
    expect(result.transactions).toHaveLength(26);
    expect(result.transactions[0]?.amount).toBe(-131.88);
  });

  it('English headers map themselves, balance and all', async () => {
    const result = await parseStatement(
      await bytesOf('xls-spreadsheetml-synthetic.xls'),
      'import.xls'
    );
    expect(result.format).toBe('xls');
    expect(result.transactions.map((t) => t.amount)).toEqual([-12.5, 200, 0.75]);
    expect(result.holdings).toEqual([
      expect.objectContaining({ symbol: 'UNKNOWN', balance: '1188.25' }),
    ]);
  });

  it('a binary .xls comes back refused, with nothing parsed', async () => {
    const ole = new Uint8Array([
      0xd0,
      0xcf,
      0x11,
      0xe0,
      0xa1,
      0xb1,
      0x1a,
      0xe1,
      ...new Uint8Array(504),
    ]);
    const result = await parseStatement(ole, 'import.xls');
    expect(result.refusal).toBe('binary-xls');
    expect(result.transactions).toHaveLength(0);
  });

  it('CONTROL: CSV bytes parse exactly as the same CSV text does', async () => {
    const csv = '﻿date,description,amount\n2024-03-15,Test,100.00\n';
    const fromText = await parseStatement(csv, 'import.csv');
    const fromBytes = await parseStatement(new TextEncoder().encode(csv), 'import.csv');
    expect(fromBytes).toEqual(fromText);
    expect(fromBytes.transactions).toHaveLength(1);
  });
});
