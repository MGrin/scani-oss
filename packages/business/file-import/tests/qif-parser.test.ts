import { describe, expect, it } from 'bun:test';
import { parseQifStatement } from '../src/qif-parser';

describe('parseQifStatement', () => {
  it('parses a basic Bank-type QIF with date, amount, payee', () => {
    const qif = `!Type:Bank
D03/15/2024
T-50.00
PCoffee Shop
^
D03/16/2024
T1000.00
PSalary
^`;
    const result = parseQifStatement(qif);
    expect(result.format).toBe('qif');
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]?.amount).toBe(-50);
    expect(result.transactions[0]?.description).toBe('Coffee Shop');
    expect(result.transactions[1]?.amount).toBe(1000);
    expect(result.transactions[1]?.description).toBe('Salary');
  });

  it('falls back to memo when payee is missing', () => {
    const qif = `!Type:Bank
D03/15/2024
T-25.00
MTaxi ride
^`;
    const result = parseQifStatement(qif);
    expect(result.transactions[0]?.description).toBe('Taxi ride');
  });

  it('uses "Unknown" when neither payee nor memo is present', () => {
    const qif = `!Type:Bank
D03/15/2024
T-10.00
^`;
    const result = parseQifStatement(qif);
    expect(result.transactions[0]?.description).toBe('Unknown');
  });

  it('strips thousands separators from amounts', () => {
    const qif = `!Type:Bank
D03/15/2024
T1,250.50
PRefund
^`;
    const result = parseQifStatement(qif);
    expect(result.transactions[0]?.amount).toBe(1250.5);
  });

  it('disambiguates dd/MM/yyyy when the first part is > 12', () => {
    const qif = `!Type:Bank
D15/03/2024
T-50.00
PEU date format
^`;
    const result = parseQifStatement(qif);
    const date = result.transactions[0]?.date;
    expect(date?.getUTCFullYear()).toBe(2024);
    expect(date?.getUTCMonth()).toBe(2); // March = 2
    expect(date?.getUTCDate()).toBe(15);
  });

  it('warns about QIF balance limitations', () => {
    const qif = `!Type:Bank
D03/15/2024
T-50.00
PTest
^`;
    const result = parseQifStatement(qif);
    const balanceWarning = result.warnings.find((w) => w.toLowerCase().includes('balance'));
    expect(balanceWarning).toBeDefined();
  });

  it('skips records with missing date or amount', () => {
    const qif = `!Type:Bank
D03/15/2024
T-50.00
PValid
^
PNo date and no amount
^
D03/16/2024
PNo amount
^`;
    const result = parseQifStatement(qif);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.description).toBe('Valid');
  });

  it('warns when the file has no transactions', () => {
    const qif = '!Type:Bank\n^';
    const result = parseQifStatement(qif);
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('No transactions'))).toBe(true);
  });

  it('ignores non-essential prefixes (L, A, N)', () => {
    const qif = `!Type:Bank
D03/15/2024
T-50.00
PSupermarket
LGroceries
NCheck#1234
A123 Main St
^`;
    const result = parseQifStatement(qif);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.description).toBe('Supermarket');
  });

  // SC-1291: the ambiguous branch assumed US order and `new Date()` got there
  // first anyway, so a UK export's 3 April was imported as 4 March.
  describe('date order (SC-1291)', () => {
    const qif = (...dates: string[]) =>
      `!Type:Bank\n${dates.map((d) => `D${d}\nT-1.00\nPRow\n^`).join('\n')}`;
    const isoDays = (result: ReturnType<typeof parseQifStatement>) =>
      result.transactions.map((t) => t.date.toISOString().slice(0, 10));

    it('reads a day-first file as day-first, including its days 1-12', () => {
      expect(isoDays(parseQifStatement(qif('03/04/2026', '25/04/2026')))).toEqual([
        '2026-04-03',
        '2026-04-25',
      ]);
    });

    it('reads a month-first file as month-first', () => {
      expect(isoDays(parseQifStatement(qif('03/04/2026', '04/25/2026')))).toEqual([
        '2026-03-04',
        '2026-04-25',
      ]);
    });

    it('reads the Quicken apostrophe year', () => {
      expect(isoDays(parseQifStatement(qif("1/ 5'04", "1/25'04")))).toEqual([
        '2004-01-05',
        '2004-01-25',
      ]);
    });

    it('flags an all-ambiguous file instead of guessing', () => {
      const result = parseQifStatement(qif('03/04/2026', '05/06/2026'));
      expect(result.transactions).toEqual([]);
      expect(result.ambiguousDateOrder).toEqual({
        rowCount: 2,
        samples: ['03/04/2026', '05/06/2026'],
      });
    });

    it('reads an ambiguous file in the order the caller supplies', () => {
      const result = parseQifStatement(qif('03/04/2026', '05/06/2026'), {
        dateOrder: 'day-first',
      });
      expect(isoDays(result)).toEqual(['2026-04-03', '2026-06-05']);
    });
  });
});
