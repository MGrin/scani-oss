import { describe, expect, it } from 'bun:test';
import { parseCamt053Statement } from '../src/camt053-parser';

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
// A closing balance is what the account held when its day ended.
const endOf = (iso: string) => new Date(`${iso}T23:59:59.999Z`);

describe('parseCamt053Statement — mBank PL example (camt.053.001.08)', () => {
  it('reads each booked entry, signed by its credit/debit indicator', async () => {
    const result = await parseCamt053Statement(await fixture('camt053-mbank-pl.xml'));

    expect(result.format).toBe('camt053');
    expect(result.detectedCurrency).toBe('PLN');
    expect(result.transactions.map((t) => [t.amount, t.currency, t.date])).toEqual([
      [-94.69, 'PLN', day('2024-05-15')],
      [94.69, 'PLN', day('2024-05-15')],
    ]);
  });

  it('describes an entry by the counterparty name, then the remittance text', async () => {
    const [outgoing, incoming] = (
      await parseCamt053Statement(await fixture('camt053-mbank-pl.xml'))
    ).transactions;

    // Version 08 nests the name under <Pty>, and mBank pads it with blanks.
    expect(outgoing?.description).toBe(
      'COUNTERPARTY STREET NAME 1 APT. 12 58-304 CITY 10909990008773'
    );
    expect(incoming?.description).toBe('COUNTERPARTY NAME POSTAL CODE ADDRESS PL 10111110234847');
  });

  it("builds the natural id on the bank's own entry reference", async () => {
    const result = await parseCamt053Statement(await fixture('camt053-mbank-pl.xml'));
    expect(result.transactions.map((t) => t.raw?.id)).toEqual([
      'MB2405150194044:DBIT:94.69',
      'SP24136999003377:CRDT:94.69',
    ]);
    expect(result.transactions[0]?.raw?.reference).toBe('MB2405150194044');
  });

  it('takes the closing booked balance, and CONTROL: entries that reach it raise no warning', async () => {
    const result = await parseCamt053Statement(await fixture('camt053-mbank-pl.xml'));

    expect(result.positions).toEqual({
      asOf: endOf('2024-05-15'),
      cash: [{ currency: 'PLN', balance: '0' }],
      securities: [],
    });
    expect(result.warnings).toEqual([]);
  });
});

describe('parseCamt053Statement — ING NL sample (camt.053.001.02)', () => {
  it('reads a batch entry as the one movement the account saw', async () => {
    const result = await parseCamt053Statement(await fixture('camt053-ing-nl.xml'));

    expect(result.detectedCurrency).toBe('EUR');
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      amount: 270,
      currency: 'EUR',
      date: day('2014-01-03'),
      // No party and no remittance text: the batch's own id is all it has.
      description: 'SCTBtchId20140103A2PSTN',
    });
    expect(result.transactions[0]?.raw?.id).toBe('3102766686999:CRDT:270');
  });

  it('opens on OPBD rather than the previous close, and says the entries do not reach CLBD', async () => {
    // ING cut its sample to one entry and left the closing balance at 1605.
    const result = await parseCamt053Statement(await fixture('camt053-ing-nl.xml'));

    expect(result.positions?.cash).toEqual([{ currency: 'EUR', balance: '1605' }]);
    expect(result.positions?.asOf).toEqual(endOf('2014-01-03'));
    // The one entry is 270: the figure that misses is the opening 1000 with
    // it on top.
    expect(result.warnings).toEqual([
      "This statement's opening balance and lines add up to 1,270 EUR, but it states a closing balance of 1,605 EUR",
    ]);
  });
});

describe('parseCamt053Statement — field rules', () => {
  const NS = 'urn:iso:std:iso:20022:tech:xsd:camt.053.001.02';
  const balance = (code: string, amount: string, indicator: string, date: string) =>
    `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>${indicator}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
  const statement = (body: string, account = 'NL00BANK0000000001') =>
    `<Stmt><Id>S</Id><Acct><Id><IBAN>${account}</IBAN></Id><Ccy>EUR</Ccy><Ownr><Nm>Account Owner BV</Nm></Ownr></Acct>${body}</Stmt>`;
  const document = (statements: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="${NS}"><BkToCstmrStmt>${statements}</BkToCstmrStmt></Document>`;
  const entry = (amount: string, indicator: string, extra = '', status = '<Sts>BOOK</Sts>') =>
    `<Ntry><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>${indicator}</CdtDbtInd>${status}<BookgDt><Dt>2025-01-02</Dt></BookgDt>${extra}</Ntry>`;

  it('a DBIT closing balance is negative', async () => {
    const result = await parseCamt053Statement(
      document(
        statement(
          balance('OPBD', '10.00', 'CRDT', '2025-01-02') +
            balance('CLBD', '15.00', 'DBIT', '2025-01-02') +
            entry('25.00', 'DBIT')
        )
      )
    );
    expect(result.positions?.cash).toEqual([{ currency: 'EUR', balance: '-15' }]);
    expect(result.warnings).toEqual([]);
  });

  it('skips an entry that is not booked, and says how many', async () => {
    const result = await parseCamt053Statement(
      document(
        statement(
          balance('OPBD', '10.00', 'CRDT', '2025-01-02') +
            balance('CLBD', '15.00', 'CRDT', '2025-01-02') +
            entry('5.00', 'CRDT') +
            entry('99.00', 'DBIT', '', '<Sts>PDNG</Sts>')
        )
      )
    );
    expect(result.transactions.map((t) => t.amount)).toEqual([5]);
    expect(result.warnings).toEqual(['1 entry not yet booked was skipped']);
  });

  it('names the other side of a payment, never the account owner', async () => {
    const parties = (debtor: string, creditor: string) =>
      `<NtryDtls><TxDtls><RltdPties><Dbtr><Nm>${debtor}</Nm></Dbtr><Cdtr><Nm>${creditor}</Nm></Cdtr></RltdPties><RmtInf><Ustrd>Invoice 12</Ustrd><Ustrd>March</Ustrd></RmtInf></TxDtls></NtryDtls>`;
    const result = await parseCamt053Statement(
      document(
        statement(
          entry('5.00', 'CRDT', parties('Payer &amp; Sons', 'Account Owner BV')) +
            entry('7.00', 'DBIT', parties('Account Owner BV', 'Landlord Ltd')) +
            // Only the owner is named: the remittance text alone.
            entry(
              '1.00',
              'DBIT',
              '<NtryDtls><TxDtls><RltdPties><Dbtr><Nm>Account Owner BV</Nm></Dbtr></RltdPties><RmtInf><Ustrd>Card fee</Ustrd></RmtInf></TxDtls></NtryDtls>'
            )
        )
      )
    );
    expect(result.transactions.map((t) => t.description)).toEqual([
      'Payer & Sons Invoice 12 March',
      'Landlord Ltd Invoice 12 March',
      'Card fee',
    ]);
  });

  it('falls back to the additional entry text, and to the value day without a booking date', async () => {
    const result = await parseCamt053Statement(
      document(
        statement(
          '<Ntry><Amt Ccy="EUR">3.00</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts>BOOK</Sts><ValDt><DtTm>2025-01-03T10:15:00+01:00</DtTm></ValDt><AddtlNtryInf>Account fee Q4</AddtlNtryInf></Ntry>'
        )
      )
    );
    // The calendar day the bank wrote, not the instant: a closing balance is
    // stated per day, and a line must sort on the right side of it.
    expect(result.transactions[0]).toMatchObject({
      description: 'Account fee Q4',
      date: day('2025-01-03'),
    });
    // No AcctSvcrRef: nothing to offer as a natural id.
    expect(result.transactions[0]?.raw?.id).toBeUndefined();
  });

  it('keeps a reversal apart from the entry it reverses when both carry one reference', async () => {
    const result = await parseCamt053Statement(
      document(
        statement(
          entry('40.00', 'DBIT', '<AcctSvcrRef>REF-1</AcctSvcrRef>') +
            entry('40.00', 'CRDT', '<RvslInd>true</RvslInd><AcctSvcrRef>REF-1</AcctSvcrRef>')
        )
      )
    );
    expect(result.transactions.map((t) => t.amount)).toEqual([-40, 40]);
    expect(result.transactions.map((t) => t.raw?.id)).toEqual(['REF-1:DBIT:40', 'REF-1:CRDT:40']);
  });

  it('opens on the previous close where a bank states no OPBD, and reads a structured reference', async () => {
    const result = await parseCamt053Statement(
      document(
        statement(
          balance('PRCD', '100.00', 'CRDT', '2025-01-01') +
            balance('CLBD', '90.00', 'CRDT', '2025-01-02') +
            entry(
              '9.00',
              'DBIT',
              '<NtryDtls><TxDtls><RmtInf><Strd><CdtrRefInf><Ref>RF18539007547034</Ref></CdtrRefInf></Strd></RmtInf></TxDtls></NtryDtls>'
            )
        )
      )
    );
    expect(result.transactions[0]?.description).toBe('RF18539007547034');
    // 100 less 9 is 91, and the statement says 90.
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('91');
  });

  it("orders an entry valued after the close on the close day, says so, and keeps the bank's date", async () => {
    // The closing balance of 2 Jan already holds the entry. Dated 6 Jan it
    // would be counted again on top of that balance.
    const result = await parseCamt053Statement(
      document(
        statement(
          balance('OPBD', '10.00', 'CRDT', '2025-01-02') +
            balance('CLBD', '15.00', 'CRDT', '2025-01-02') +
            '<Ntry><Amt Ccy="EUR">5.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><ValDt><Dt>2025-01-06</Dt></ValDt></Ntry>'
        )
      )
    );
    expect(result.transactions[0]?.date).toEqual(day('2025-01-02'));
    expect(result.transactions[0]?.raw).toEqual({ bankDate: '2025-01-06' });
    expect(result.warnings).toEqual([
      '1 line is dated after the statement closed on 2 Jan 2025, so it is placed on that day: 6 Jan 2025, 5 EUR',
    ]);
  });

  it('does the same for an entry booked after the close, beside its reference', async () => {
    const result = await parseCamt053Statement(
      document(
        statement(
          balance('OPBD', '10.00', 'CRDT', '2025-01-02') +
            balance('CLBD', '15.00', 'CRDT', '2025-01-02') +
            '<Ntry><Amt Ccy="EUR">5.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2025-01-06</Dt></BookgDt><AcctSvcrRef>REF1</AcctSvcrRef></Ntry>'
        )
      )
    );
    expect(result.transactions[0]?.date).toEqual(day('2025-01-02'));
    expect(result.transactions[0]?.raw).toEqual({
      id: 'REF1:CRDT:5',
      reference: 'REF1',
      bankDate: '2025-01-06',
    });
    expect(result.warnings).toEqual([
      '1 line is dated after the statement closed on 2 Jan 2025, so it is placed on that day: 6 Jan 2025, 5 EUR',
    ]);
  });

  it('reads a document whose elements carry a namespace prefix', async () => {
    const prefixed = document(statement(entry('5.00', 'CRDT')))
      .replace(/<(\/?)(?!\?)/g, '<$1ns2:')
      .replace('xmlns=', 'xmlns:ns2=');
    const result = await parseCamt053Statement(prefixed);
    expect(result.transactions.map((t) => t.amount)).toEqual([5]);
  });

  it('follows one account across several statements and takes the last closing balance', async () => {
    const result = await parseCamt053Statement(
      document(
        // `entry` books on 2 Jan, so neither statement may close before it.
        statement(
          balance('OPBD', '100.00', 'CRDT', '2025-01-02') +
            balance('CLBD', '110.00', 'CRDT', '2025-01-02') +
            entry('10.00', 'CRDT')
        ) +
          statement(
            balance('OPBD', '110.00', 'CRDT', '2025-01-03') +
              balance('CLBD', '80.00', 'CRDT', '2025-01-03') +
              entry('30.00', 'DBIT')
          )
      )
    );
    expect(result.transactions.map((t) => t.amount)).toEqual([10, -30]);
    expect(result.positions).toEqual({
      asOf: endOf('2025-01-03'),
      cash: [{ currency: 'EUR', balance: '80' }],
      securities: [],
    });
    expect(result.warnings).toEqual([]);
  });

  it('refuses a file that holds more than one account, because an import goes to one', async () => {
    const result = await parseCamt053Statement(
      document(
        statement(balance('CLBD', '110.00', 'CRDT', '2025-01-01') + entry('10.00', 'CRDT')) +
          statement(
            balance('CLBD', '4.00', 'CRDT', '2025-01-01') + entry('1.00', 'DBIT'),
            'NL00BANK0000000002'
          )
      )
    );
    expect(result.transactions).toEqual([]);
    expect(result.positions).toBeUndefined();
    expect(result.holdings).toEqual([]);
    expect(result.warnings).toEqual([
      'This file holds statements for 2 accounts, so nothing was imported. Export one account per file',
    ]);
  });

  it('refuses a camt.052 report by name instead of importing interim figures', async () => {
    const report =
      '<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.052.001.02"><BkToCstmrAcctRpt><Rpt><Ntry><Amt Ccy="EUR">5.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>2025-01-02</Dt></BookgDt></Ntry></Rpt></BkToCstmrAcctRpt></Document>';
    const result = await parseCamt053Statement(report);
    expect(result.transactions).toEqual([]);
    expect(result.warnings).toEqual([
      'This is a camt.052 file, not a camt.053 statement, so nothing was imported',
    ]);

    const notification = await parseCamt053Statement(
      report.replace(/BkToCstmrAcctRpt/g, 'BkToCstmrDbtCdtNtfctn')
    );
    expect(notification.warnings).toEqual([
      'This is a camt.054 file, not a camt.053 statement, so nothing was imported',
    ]);
  });

  it('reports XML it cannot read, and a file that is not CAMT at all', async () => {
    const broken = await parseCamt053Statement('<Document><BkToCstmrStmt>');
    expect(broken.transactions).toEqual([]);
    expect(broken.warnings).toHaveLength(1);
    expect(broken.warnings[0]).toStartWith('Failed to parse CAMT.053:');

    const other = await parseCamt053Statement('<?xml version="1.0"?><html><body/></html>');
    expect(other.warnings).toEqual(['No CAMT.053 statement found in the file']);
  });
});
