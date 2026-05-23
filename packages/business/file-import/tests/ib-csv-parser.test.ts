import { describe, expect, it } from 'bun:test';
import { parseIbCsvStatement } from '../src/ib-csv-parser';

const IB_CSV_SAMPLE = `Statement,Header,Field Name,Field Value
Statement,Data,BrokerName,Interactive Brokers LLC
Statement,Data,BrokerAddress,"Two Pickwick Plaza, Greenwich, CT 06830"
Statement,Data,Title,Activity Statement
Statement,Data,Period,"April 15, 2026"
Account Information,Header,Field Name,Field Value
Account Information,Data,Name,Test User
Account Information,Data,Account,U1234567
Account Information,Data,Base Currency,USD
Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code
Open Positions,Data,Summary,Stocks,CAD,XEQT,205.2935,1,32.403637665,6652.256189,42.31,8685.97,2033.713815,
Open Positions,Data,Summary,Stocks,CAD,XUU,123.4416,1,57.015892122,7038.132949,70.49,8701.4,1663.26705,
Open Positions,Total,,Stocks,CAD,,,,,13690.389138,,17387.37,3696.980865,
Open Positions,Data,Summary,Stocks,USD,AAPL,10.0545,1,239.191336715,2404.949295,266.43,2678.82,273.870705,
Open Positions,Data,Summary,Stocks,USD,AMZN,2,1,171.468619,342.937238,248.5,497,154.062762,
Open Positions,Data,Summary,Stocks,USD,VOO,9.9394,1,513.287041673,5101.765222,643.45,6395.51,1293.744777,
Open Positions,Total,,Stocks,USD,,,,,26423.956681,,26837.12,413.163316,
Cash Report,Header,Currency Summary,Currency,Total,Securities,Futures,Month to Date,Year to Date,
Cash Report,Data,Ending Cash,Base Currency Summary,10922.372709939,10922.372709939,0,,,
Cash Report,Data,Ending Cash,CAD,29.209999525,29.209999525,0,,,
Cash Report,Data,Ending Cash,USD,10901.116301185,10901.116301185,0,,,`;

describe('parseIbCsvStatement', () => {
  it('should extract stock positions from Open Positions section', () => {
    const result = parseIbCsvStatement(IB_CSV_SAMPLE);
    expect(result.format).toBe('ib-csv');

    const xeqt = result.holdings.find((h) => h.symbol === 'XEQT');
    expect(xeqt).toBeDefined();
    expect(xeqt!.balance).toBe('205.2935');

    const aapl = result.holdings.find((h) => h.symbol === 'AAPL');
    expect(aapl).toBeDefined();
    expect(aapl!.balance).toBe('10.0545');
  });

  it('should extract all stock symbols', () => {
    const result = parseIbCsvStatement(IB_CSV_SAMPLE);
    const symbols = result.holdings
      .filter((h) => !h.notes?.includes('cash'))
      .map((h) => h.symbol)
      .sort();
    expect(symbols).toEqual(['AAPL', 'AMZN', 'VOO', 'XEQT', 'XUU']);
  });

  it('should extract cash balances per currency', () => {
    const result = parseIbCsvStatement(IB_CSV_SAMPLE);

    const usdCash = result.holdings.find((h) => h.symbol === 'USD');
    expect(usdCash).toBeDefined();
    expect(Number(usdCash!.balance)).toBeCloseTo(10901.116, 2);

    const cadCash = result.holdings.find((h) => h.symbol === 'CAD');
    expect(cadCash).toBeDefined();
    expect(Number(cadCash!.balance)).toBeCloseTo(29.21, 2);
  });

  it('should skip Total and Base Currency Summary rows', () => {
    const result = parseIbCsvStatement(IB_CSV_SAMPLE);
    // Should not have "Base Currency Summary" as a holding
    const baseSummary = result.holdings.find((h) => h.symbol === 'Base Currency Summary');
    expect(baseSummary).toBeUndefined();
  });

  it('should set confidence to 1.0 for all holdings', () => {
    const result = parseIbCsvStatement(IB_CSV_SAMPLE);
    for (const h of result.holdings) {
      expect(h.confidence).toBe(1.0);
    }
  });

  it('should have no transactions (IB CSV is not a transaction log)', () => {
    const result = parseIbCsvStatement(IB_CSV_SAMPLE);
    expect(result.transactions).toHaveLength(0);
  });

  it('should handle empty content', () => {
    const result = parseIbCsvStatement('');
    expect(result.holdings).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
