import { describe, expect, it } from 'bun:test';
import { parseOfxStatement } from '../src/ofx-parser';

const BANK_OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>USD</CURDEF>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT</TRNTYPE>
<DTPOSTED>20240315120000</DTPOSTED>
<TRNAMT>-50.00</TRNAMT>
<NAME>Coffee shop</NAME>
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT</TRNTYPE>
<DTPOSTED>20240316</DTPOSTED>
<TRNAMT>1000.00</TRNAMT>
<NAME>Salary</NAME>
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

const CC_OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX>
<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<CCSTMTRS>
<CURDEF>EUR</CURDEF>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT</TRNTYPE>
<DTPOSTED>20240301</DTPOSTED>
<TRNAMT>-29.99</TRNAMT>
<NAME>Streaming service</NAME>
</STMTTRN>
</BANKTRANLIST>
</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>`;

describe('parseOfxStatement', () => {
  it('extracts bank-statement transactions', async () => {
    const result = await parseOfxStatement(BANK_OFX);
    expect(result.format).toBe('ofx');
    expect(result.detectedCurrency).toBe('USD');
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0]?.amount).toBe(-50);
    expect(result.transactions[0]?.description).toBe('Coffee shop');
    expect(result.transactions[0]?.currency).toBe('USD');
    expect(result.transactions[1]?.amount).toBe(1000);
  });

  it('parses dates with and without time portion', async () => {
    const result = await parseOfxStatement(BANK_OFX);
    expect(result.transactions[0]?.date.getUTCFullYear()).toBe(2024);
    expect(result.transactions[0]?.date.getUTCMonth()).toBe(2); // March = 2
    expect(result.transactions[0]?.date.getUTCDate()).toBe(15);
    expect(result.transactions[1]?.date.getUTCDate()).toBe(16);
  });

  it('extracts credit-card transactions from CCSTMTRS', async () => {
    const result = await parseOfxStatement(CC_OFX);
    expect(result.format).toBe('ofx');
    expect(result.detectedCurrency).toBe('EUR');
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]?.amount).toBeCloseTo(-29.99);
    expect(result.transactions[0]?.description).toBe('Streaming service');
  });

  it('warns when no transactions are found', async () => {
    const empty = `OFXHEADER:100
DATA:OFXSGML
<OFX></OFX>`;
    const result = await parseOfxStatement(empty);
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns a warning instead of throwing on malformed content', async () => {
    const result = await parseOfxStatement('not an ofx file at all');
    expect(result.format).toBe('ofx');
    expect(result.transactions).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('falls back to MEMO when NAME is missing', async () => {
    const memoOnly = `OFXHEADER:100
DATA:OFXSGML
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>GBP</CURDEF>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT</TRNTYPE>
<DTPOSTED>20240401</DTPOSTED>
<TRNAMT>-10.00</TRNAMT>
<MEMO>Bus fare</MEMO>
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
    const result = await parseOfxStatement(memoOnly);
    expect(result.transactions[0]?.description).toBe('Bus fare');
  });
});
