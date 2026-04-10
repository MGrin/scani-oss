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
