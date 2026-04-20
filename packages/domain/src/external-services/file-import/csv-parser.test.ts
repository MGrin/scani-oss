import { describe, expect, it } from 'bun:test';
import { parseCsvStatement } from './csv-parser';

describe('parseCsvStatement', () => {
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
