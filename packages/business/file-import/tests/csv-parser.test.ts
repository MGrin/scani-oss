import { describe, expect, it } from 'bun:test';
import { parseCsvStatement } from '../src/csv-parser';

describe('parseCsvStatement', () => {
  // SC-137: the tester's exact fixture. Wise used to win this header on a
  // partial match and map balances to a column that is not there, so every
  // row parsed with `balance: undefined`, no closing anchor was written and
  // the import created a 0-balance holding while reporting success.
  describe('generic broker CSV (no bank template)', () => {
    const brokerCsv = `Date,Description,Amount,Currency,Balance
2026-06-01,Opening cash,1000.00,USD,1000.00
2026-06-09,Dividend AAPL,32.40,USD,1032.40
2026-06-21,Buy 2 AAPL,-402.00,USD,630.40`;

    it('falls through to auto-detection instead of claiming Wise', () => {
      expect(parseCsvStatement(brokerCsv).bankTemplate).toBe('auto');
    });

    it('reads the closing balance the file actually carries', () => {
      const result = parseCsvStatement(brokerCsv);
      expect(result.transactions).toHaveLength(3);
      expect(result.transactions.at(-1)!.balance).toBe(630.4);
    });

    it('keeps the currency and amounts intact', () => {
      const result = parseCsvStatement(brokerCsv);
      expect(result.detectedCurrency).toBe('USD');
      expect(result.transactions[0]!.amount).toBe(1000);
      expect(result.transactions[2]!.amount).toBe(-402);
    });
  });
  describe('Revolut CSV format', () => {
    const revolutCsv = `Started Date,Description,Amount,Currency,Balance
2024-03-15 10:30:00,Salary Deposit,5000.00,EUR,5000.00
2024-03-16 14:22:00,Coffee Shop,-4.50,EUR,4995.50
2024-03-17 09:00:00,Transfer to Savings,-1000.00,EUR,3995.50`;

    it('should auto-detect Revolut template', () => {
      const result = parseCsvStatement(revolutCsv);
      expect(result.bankTemplate).toBe('revolut');
      expect(result.transactions).toHaveLength(3);
    });

    it('should parse amounts correctly', () => {
      const result = parseCsvStatement(revolutCsv);
      expect(result.transactions[0]!.amount).toBe(5000);
      expect(result.transactions[1]!.amount).toBe(-4.5);
      expect(result.transactions[2]!.amount).toBe(-1000);
    });

    it('should parse descriptions', () => {
      const result = parseCsvStatement(revolutCsv);
      expect(result.transactions[0]!.description).toBe('Salary Deposit');
      expect(result.transactions[1]!.description).toBe('Coffee Shop');
    });

    it('should detect EUR currency', () => {
      const result = parseCsvStatement(revolutCsv);
      expect(result.detectedCurrency).toBe('EUR');
    });

    it('should parse balances', () => {
      const result = parseCsvStatement(revolutCsv);
      expect(result.transactions[0]!.balance).toBe(5000);
      expect(result.transactions[2]!.balance).toBe(3995.5);
    });
  });

  describe('Tinkoff CSV format', () => {
    const tinkoffCsv = `Дата операции,Описание,Сумма операции,Валюта операции,Остаток после операции
15.03.2024 10:30:00,Зарплата,150000.00,RUB,150000.00
16.03.2024 14:22:00,Кофейня,-350.00,RUB,149650.00`;

    it('should auto-detect Tinkoff template', () => {
      const result = parseCsvStatement(tinkoffCsv);
      expect(result.bankTemplate).toBe('tinkoff');
      expect(result.transactions).toHaveLength(2);
    });

    it('should parse Russian date format (dd.MM.yyyy)', () => {
      const result = parseCsvStatement(tinkoffCsv);
      const date = result.transactions[0]!.date;
      expect(date.getFullYear()).toBe(2024);
      expect(date.getMonth()).toBe(2); // March = 2 (0-indexed)
      expect(date.getDate()).toBe(15);
    });

    it('should parse RUB currency', () => {
      const result = parseCsvStatement(tinkoffCsv);
      expect(result.detectedCurrency).toBe('RUB');
    });
  });

  describe('Sberbank CSV format (semicolon delimiter)', () => {
    const sberbankCsv = `Дата;Описание операции;Сумма;Валюта;Остаток
15.03.2024;Зарплата;150000.00;RUB;150000.00
16.03.2024;Перевод;-50000.00;RUB;100000.00`;

    it('should auto-detect Sberbank template', () => {
      const result = parseCsvStatement(sberbankCsv);
      expect(result.bankTemplate).toBe('sberbank');
    });

    it('should handle semicolon delimiter', () => {
      const result = parseCsvStatement(sberbankCsv);
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions[0]!.amount).toBe(150000);
    });
  });

  describe('Wise CSV format', () => {
    const wiseCsv = `Date,Description,Amount,Currency,Running Balance
15-03-2024,International Transfer,1000.00,USD,1000.00
16-03-2024,Card Payment,-50.00,USD,950.00`;

    it('should auto-detect Wise template', () => {
      const result = parseCsvStatement(wiseCsv);
      expect(result.bankTemplate).toBe('wise');
      expect(result.transactions).toHaveLength(2);
    });

    it('should parse dd-MM-yyyy dates', () => {
      const result = parseCsvStatement(wiseCsv);
      const date = result.transactions[0]!.date;
      expect(date.getFullYear()).toBe(2024);
      expect(date.getMonth()).toBe(2); // March
    });
  });

  describe('Generic / unknown CSV', () => {
    const genericCsv = `date,description,amount,currency,balance
2024-03-15,Payment,100.00,SGD,100.00
2024-03-16,Withdrawal,-20.00,SGD,80.00`;

    it('should fall back to auto-detect template', () => {
      const result = parseCsvStatement(genericCsv);
      expect(result.bankTemplate).toBe('auto');
      expect(result.transactions).toHaveLength(2);
    });

    it('should parse generic CSV correctly', () => {
      const result = parseCsvStatement(genericCsv);
      expect(result.transactions[0]!.amount).toBe(100);
    });
  });

  describe('Custom column mapping', () => {
    const customCsv = `Fecha,Concepto,Ingreso,Gasto,Moneda
15/03/2024,Nomina,3000.00,,EUR
16/03/2024,Compra,,45.50,EUR`;

    it('should use custom credit/debit column mapping', () => {
      const result = parseCsvStatement(customCsv, undefined, {
        date: 'Fecha',
        description: 'Concepto',
        amount: '',
        credit: 'Ingreso',
        debit: 'Gasto',
        currency: 'Moneda',
      });
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions[0]!.amount).toBe(3000);
      expect(result.transactions[1]!.amount).toBe(-45.5);
    });
  });

  describe('European number formats', () => {
    const europeanCsv = `date,description,amount,currency
2024-03-15,Payment,"1.234,56",EUR
2024-03-16,Payment2,"999,99",EUR`;

    it('should parse European decimal format (1.234,56)', () => {
      const result = parseCsvStatement(europeanCsv);
      expect(result.transactions[0]!.amount).toBe(1234.56);
    });

    it('should parse comma decimal separator (999,99)', () => {
      const result = parseCsvStatement(europeanCsv);
      expect(result.transactions[1]!.amount).toBe(999.99);
    });
  });

  describe('US thousands separator format', () => {
    const usCsv = `Date,Product name,Description,Money in,Money out,Balance
1 Apr 2026,,Money brought forward,,,"$12,896.83"
2 Apr 2026,Savings,Withdrawal,,$398.78,"$12,500.00"
3 Apr 2026,Savings,Deposit,"$1,000.00",,"$13,500.00"`;

    it('should parse US thousands format ($12,896.83)', () => {
      const result = parseCsvStatement(usCsv);
      expect(result.transactions[0]!.balance).toBe(12896.83);
    });

    it('should parse negative debit with US format', () => {
      const result = parseCsvStatement(usCsv);
      // Withdrawal row: credit=0, debit=398.78 → amount = -398.78
      expect(result.transactions[1]!.amount).toBe(-398.78);
    });

    it('should parse credit with US thousands format ($1,000.00)', () => {
      const result = parseCsvStatement(usCsv);
      // Deposit row: credit=1000, debit=0 → amount = 1000
      expect(result.transactions[2]!.amount).toBe(1000);
    });

    it('should parse balance with US thousands format ($13,500.00)', () => {
      const result = parseCsvStatement(usCsv);
      expect(result.transactions[2]!.balance).toBe(13500);
    });
  });

  describe('Monzo CSV format', () => {
    const monzoCsv = `Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount,Local currency,Notes and #tags,Address,Receipt,Description,Category split,Money Out,Money In
tx_001,12/03/2026,11:26:03,Card payment,Coffee Shop,☕,Eating out,-13.03,GBP,-13.03,GBP,,,,,,-13.03,
tx_002,13/03/2026,07:09:51,Faster payment,Employer,,Income,2000.00,GBP,2000.00,GBP,,,,,,2000.00`;

    it('should auto-detect Monzo template', () => {
      const result = parseCsvStatement(monzoCsv);
      expect(result.bankTemplate).toBe('monzo');
    });

    it('should parse amounts correctly (using Amount column)', () => {
      const result = parseCsvStatement(monzoCsv);
      expect(result.transactions[0]!.amount).toBe(-13.03);
      expect(result.transactions[1]!.amount).toBe(2000);
    });

    it('should detect GBP currency', () => {
      const result = parseCsvStatement(monzoCsv);
      expect(result.detectedCurrency).toBe('GBP');
    });
  });

  describe('Negative debit values (credit/debit split)', () => {
    const negativeCsv = `Date,Description,Money in,Money out,Balance
2024-01-01,Deposit,100.00,,100.00
2024-01-02,Payment,,-50.00,50.00`;

    it('should handle negative values in debit column via Math.abs', () => {
      const result = parseCsvStatement(negativeCsv);
      // Money out = -50.00 → Math.abs(-50) = 50 → amount = 0 - 50 = -50
      expect(result.transactions[1]!.amount).toBe(-50);
    });

    it('should handle positive credit correctly', () => {
      const result = parseCsvStatement(negativeCsv);
      expect(result.transactions[0]!.amount).toBe(100);
    });
  });

  describe('Edge cases', () => {
    it('should return empty for empty content', () => {
      const result = parseCsvStatement('');
      expect(result.transactions).toHaveLength(0);
    });

    it('should handle header-only CSV', () => {
      const result = parseCsvStatement('date,description,amount\n');
      expect(result.transactions).toHaveLength(0);
    });

    it('should skip rows with missing date', () => {
      const csv = `date,description,amount
2024-03-15,Good Row,100
,Missing Date,50`;
      const result = parseCsvStatement(csv);
      expect(result.transactions).toHaveLength(1);
    });
  });
});

describe('parseCsvStatement — fee columns (SC-136)', () => {
  // A real Revolut export: one ATM withdrawal with a separate charge, and the
  // Balance column proving the account moved by both.
  const revolut = [
    'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance',
    'ATM,Current,2026-07-15 09:12:00,2026-07-15 09:12:00,Cash at Barclays ATM,-120.00,1.50,GBP,COMPLETED,3551.43',
    'CARD_PAYMENT,Current,2026-07-16 12:00:00,2026-07-16 12:00:00,Tesco,-12.40,0.00,GBP,COMPLETED,3539.03',
  ].join('\n');

  it('reads the Fee column on the Revolut template', () => {
    const result = parseCsvStatement(revolut, 'revolut');
    expect(result.transactions[0]?.amount).toBe(-120);
    expect(result.transactions[0]?.fee).toBe(1.5);
  });

  // Every row of a Revolut export carries the column; almost all are 0.00, and
  // a ledger full of zero-value fee rows is noise the reader skips past.
  it('normalises a zero fee to absent', () => {
    const result = parseCsvStatement(revolut, 'revolut');
    expect(result.transactions[1]?.fee).toBeUndefined();
  });

  // The statement states a charge, not a signed movement — the ingester owns
  // the sign, so a bank that writes `-1.50` must not invert it.
  it('reads a fee as a magnitude whichever sign the bank wrote', () => {
    const negative = revolut.replace(',1.50,', ',-1.50,');
    expect(parseCsvStatement(negative, 'revolut').transactions[0]?.fee).toBe(1.5);
  });

  it('auto-detects a fee column on an untemplated statement', () => {
    const generic = [
      'date,description,amount,currency,fee',
      '2026-07-15,ATM,-120.00,GBP,1.50',
    ].join('\n');
    expect(parseCsvStatement(generic).transactions[0]?.fee).toBe(1.5);
  });

  it('a statement with no fee column parses unchanged', () => {
    const noFee = ['date,description,amount,currency', '2026-07-15,ATM,-120.00,GBP'].join('\n');
    const tx = parseCsvStatement(noFee).transactions[0];
    expect(tx?.amount).toBe(-120);
    expect(tx?.fee).toBeUndefined();
  });
});

// SC-483. `parseNumber`'s European-format probe was `/\d+\.\d{3},\d{2}$/`:
// unanchored, so the engine restarted `\d+` at every digit and the whole match
// went quadratic in the cell's length. An uploaded CSV is library input by any
// reading, so a 200 KB cell of digits was ~15 s of blocked event loop.
// `\d+` -> `\d` accepts exactly the same strings — the extra digits only ever
// moved where the match STARTED — and is linear.
describe('number parsing is linear in the cell length (SC-483)', () => {
  const amountCsv = (cell: string) =>
    `Date,Description,Amount,Currency\n2026-06-01,X,"${cell}",USD`;
  const amountOf = (cell: string) => parseCsvStatement(amountCsv(cell)).transactions[0]?.amount;

  // The accepted/rejected set the rewrite must not move.
  const cases: [string, number | undefined][] = [
    ['1.234,56', 1234.56],
    ['12.345.678,90', 12345678.9],
    ['999.999,99', 999999.99],
    ['1,234', 1234],
    ['12,896.83', 12896.83],
    ['-1,234,567.89', -1234567.89],
    ['1234,56', 1234.56],
    ['1.234', 1.234],
    ['99', 99],
    ['-4.50', -4.5],
    ['1.234,5', undefined],
    ['1.2345,67', undefined],
  ];
  for (const [cell, expected] of cases) {
    it(`parses ${cell || '<empty>'} as ${expected}`, () => {
      expect(amountOf(cell)).toBe(expected as number);
    });
  }

  it('a cell of 80k digits parses in well under a second', () => {
    const started = performance.now();
    expect(amountOf('0'.repeat(80_000))).toBe(0);
    const elapsed = performance.now() - started;
    // Quadratic, this input took ~2.4 s; linear it is under a millisecond.
    expect(elapsed).toBeLessThan(250);
  });
});
