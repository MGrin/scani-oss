import { describe, expect, it } from 'bun:test';
import { preambleCurrency, suggestStatementCurrency } from '../src/currency-hint';

const table = (headers: string[], rows: string[][]) => ({
  headers,
  rows: rows.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']))),
});

describe('suggestStatementCurrency (SC-1735)', () => {
  it('reads an unambiguous symbol in the amount cells', () => {
    const t = table(
      ['Date', 'Amount'],
      [
        ['2026-01-02', '€ -3,50'],
        ['2026-01-03', '€ 1.200,00'],
      ]
    );
    expect(
      suggestStatementCurrency({
        ...t,
        amountColumns: ['Amount'],
        mappedColumns: ['Date', 'Amount'],
      })
    ).toBe('EUR');
  });

  it('reads an ISO code beside the number', () => {
    const t = table(
      ['Date', 'Amount'],
      [
        ['2026-01-02', '-3.50 GBP'],
        ['2026-01-03', 'GBP 10.00'],
      ]
    );
    expect(
      suggestStatementCurrency({
        ...t,
        amountColumns: ['Amount'],
        mappedColumns: ['Date', 'Amount'],
      })
    ).toBe('GBP');
  });

  it('reads a code in the amount header', () => {
    const t = table(['Date', 'Importo (EUR)'], [['2026-01-02', '-3,50']]);
    expect(
      suggestStatementCurrency({
        ...t,
        amountColumns: ['Importo (EUR)'],
        mappedColumns: ['Date', 'Importo (EUR)'],
      })
    ).toBe('EUR');
  });

  it('reads an unmapped column that holds one code on every row', () => {
    const t = table(
      ['Data', 'Valuta', 'Importo'],
      [
        ['2026-01-02', 'EUR', '-850'],
        ['2026-01-03', 'EUR', '12'],
      ]
    );
    expect(
      suggestStatementCurrency({
        ...t,
        amountColumns: ['Importo'],
        mappedColumns: ['Data', 'Importo'],
      })
    ).toBe('EUR');
  });

  it('suggests nothing for a dollar sign, which names several currencies', () => {
    const t = table(['Date', 'Amount'], [['2026-01-02', '$3.50']]);
    expect(
      suggestStatementCurrency({
        ...t,
        amountColumns: ['Amount'],
        mappedColumns: ['Date', 'Amount'],
      })
    ).toBeUndefined();
  });

  it('suggests nothing when the file names two currencies', () => {
    const t = table(
      ['Date', 'Amount'],
      [
        ['2026-01-02', '€ 3,50'],
        ['2026-01-03', '£ 2.00'],
      ]
    );
    expect(
      suggestStatementCurrency({
        ...t,
        amountColumns: ['Amount'],
        mappedColumns: ['Date', 'Amount'],
      })
    ).toBeUndefined();
  });

  it('suggests nothing when two sources disagree: € in the amounts, USD in a column', () => {
    const t = table(['Date', 'Ccy', 'Amount'], [['2026-01-02', 'USD', '€ 3,50']]);
    expect(
      suggestStatementCurrency({
        ...t,
        amountColumns: ['Amount'],
        mappedColumns: ['Date', 'Amount'],
      })
    ).toBeUndefined();
  });

  it('CONTROL: plain numbers and words suggest nothing', () => {
    const t = table(
      ['Date', 'Description', 'Amount'],
      [['2026-01-02', 'ATM ALL TOP UP', '-1.234,56']]
    );
    expect(
      suggestStatementCurrency({
        ...t,
        amountColumns: ['Amount'],
        mappedColumns: ['Date', 'Description', 'Amount'],
      })
    ).toBeUndefined();
  });
});

describe('preambleCurrency (SC-1735)', () => {
  it('reads a cell that is a code, or a label and a code', () => {
    expect(preambleCurrency(['Divisa', 'EUR'])).toBe('EUR');
    expect(preambleCurrency(['Currency: GBP'])).toBe('GBP');
  });

  it('CONTROL: names, words and two codes suggest nothing', () => {
    expect(
      preambleCurrency(['Intestatario: Bianchi Mario', 'Periodo: 01.06.2025 - 30.06.2026'])
    ).toBeUndefined();
    expect(preambleCurrency(['ALL TRANSACTIONS'])).toBeUndefined();
    expect(preambleCurrency(['EUR', 'USD'])).toBeUndefined();
  });
});
