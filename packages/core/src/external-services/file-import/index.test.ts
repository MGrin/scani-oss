import { describe, expect, it } from 'bun:test';
import { parseStatement } from './index';

describe('parseStatement (unified entry point)', () => {
  it('should auto-detect and parse CSV by filename', async () => {
    const csv = 'date,description,amount\n2024-03-15,Test,100.00';
    const result = await parseStatement(csv, 'statement.csv');
    expect(result.format).toBe('csv');
    expect(result.transactions).toHaveLength(1);
  });

  it('should auto-detect and parse OFX by filename', async () => {
    // Minimal OFX that won't parse but should be detected
    const ofx = 'OFXHEADER:100\nDATA:OFXSGML\n<OFX></OFX>';
    const result = await parseStatement(ofx, 'bank.ofx');
    expect(result.format).toBe('ofx');
  });

  it('should return warning for MT940 (not yet supported)', async () => {
    const mt940 = ':20:TRANSREF\n:25:ACCOUNT';
    const result = await parseStatement(mt940, 'statement.sta');
    expect(result.format).toBe('mt940');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('MT940');
  });

  it('should return warning for undetectable format', async () => {
    const result = await parseStatement('just plain text');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('should pass bank template to CSV parser', async () => {
    const csv =
      'Started Date,Description,Amount,Currency,Balance\n2024-03-15 10:00:00,Test,50,EUR,50';
    const result = await parseStatement(csv, 'revolut.csv', 'revolut');
    expect(result.bankTemplate).toBe('revolut');
    expect(result.transactions).toHaveLength(1);
  });

  it('should pass custom mapping to CSV parser', async () => {
    const csv = 'Fecha,Concepto,Monto\n15/03/2024,Pago,100';
    const result = await parseStatement(csv, 'banco.csv', undefined, {
      date: 'Fecha',
      description: 'Concepto',
      amount: 'Monto',
    });
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]!.description).toBe('Pago');
  });
});
