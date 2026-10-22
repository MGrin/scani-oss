import { describe, expect, it } from 'bun:test';
import { parseMt940Statement } from '../src/mt940-parser';

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
// A closing balance is what the account held when its day ended.
const endOf = (iso: string) => new Date(`${iso}T23:59:59.999Z`);

describe('parseMt940Statement — Raiffeisenbank CZ example (`?NN` subfields)', () => {
  it('reads every statement line, signed by its debit/credit mark', async () => {
    const result = parseMt940Statement(await fixture('mt940-raiffeisenbank-cz.sta'));

    expect(result.format).toBe('mt940');
    expect(result.detectedCurrency).toBe('CZK');
    expect(result.transactions.map((t) => t.amount)).toEqual([
      -1, 50000, -11.33, -37, -113.37, -47, -252, -12003, 12000, -17100, -100000, -0.24,
    ]);
    expect(new Set(result.transactions.map((t) => t.currency))).toEqual(new Set(['CZK']));
    expect(result.transactions.every((t) => t.date.getTime() === day('2019-02-28').getTime())).toBe(
      true
    );
  });

  it('takes the closing balance the statement states, dated as the statement dates it', async () => {
    const result = parseMt940Statement(await fixture('mt940-raiffeisenbank-cz.sta'));

    expect(result.positions).toEqual({
      asOf: endOf('2019-02-28'),
      cash: [{ currency: 'CZK', balance: '22176896.1' }],
      securities: [],
    });
    expect(result.holdings).toEqual([
      expect.objectContaining({ symbol: 'CZK', balance: '22176896.1', confidence: 1 }),
    ]);
  });

  it('CONTROL: lines that reach the stated closing balance raise no warning', async () => {
    const result = parseMt940Statement(await fixture('mt940-raiffeisenbank-cz.sta'));
    expect(result.warnings).toEqual([]);
  });

  it('describes a line by the counterparty name, then the purpose text', async () => {
    const [first, deposit, , fee] = parseMt940Statement(
      await fixture('mt940-raiffeisenbank-cz.sta')
    ).transactions;

    // ?32 is the name. ?60..?62 split one text across three 27-character
    // subfields, mid-word; they rejoin with no blank where the bank cut.
    expect(first?.description).toBe(
      'JMENO PRIJEMCE DOMACI PLATBA KS0000000308 VS4513578426 SS0123457895 BANKOVNI VYPIS 000 POPL.TRN 0,00 ULICE PRIJEM UCEL UHRADY1 UCEL UHRADY2 UCEL UHRADY3 UCEL UHRADY4'
    );
    expect(deposit?.description).toStartWith('Přev.úč.OVA Rudná HOTOVOSTNI TRANSAKCE');
    // ?28 is full, so ?60 picks the word up where it was cut: "Rudn" + "á".
    expect(deposit?.description).toEndWith(
      'Pobočka Ostrava, Rudná, Avion Shopping Park, Rudná 114/3114'
    );
    // No ?32: the purpose text alone.
    expect(fee?.description).toBe(
      'POPLATEK ZAHR. PLATBY 3588425491 EKV CZK 1000,00/27,03000000 POPL.TRN 1000,00 CZK'
    );
  });

  it('keeps the references of a line for debugging, and offers none as a natural id', async () => {
    const [first] = parseMt940Statement(await fixture('mt940-raiffeisenbank-cz.sta')).transactions;

    expect(first?.raw).toMatchObject({
      reference: '3538323671',
      bankReference: 'O-GE-CC',
      typeCode: 'NMSC',
    });
    // MT940 references are not unique per line ("NONREF" is common), so the
    // ingester must fall back to its synthetic id.
    expect(first?.raw?.id).toBeUndefined();
  });
});

describe('parseMt940Statement — ING NL sample (SWIFT envelope, `/CODE/` subfields)', () => {
  it('reads the statement inside its {1:}{2:}{4: envelope', async () => {
    const result = parseMt940Statement(await fixture('mt940-ing-nl.sta'));

    expect(result.detectedCurrency).toBe('EUR');
    expect(result.transactions.map((t) => t.amount)).toEqual([350, 125]);
  });

  it("reads an entry date in the statement's year when the value date would put it past the close", async () => {
    // ING writes `:61:2502040103…`: value date 4 Feb 2025, entry date 03 Jan,
    // under a closing balance of 3 Jan 2014. Read beside the value date the
    // entry is 3 Jan 2025, eleven years after the balance that holds it.
    const result = parseMt940Statement(await fixture('mt940-ing-nl.sta'));
    expect(result.transactions.map((t) => t.date)).toEqual([day('2014-01-03'), day('2014-01-03')]);
    // Nothing was moved, so no row carries a second date and nothing says one was.
    expect(result.transactions.map((t) => t.raw?.bankDate)).toEqual([undefined, undefined]);
    expect(result.warnings.some((warning) => warning.includes('dated after'))).toBe(false);
  });

  it('names the counterparty and the remittance text out of the /CODE/ fields', async () => {
    const [first, second] = parseMt940Statement(await fixture('mt940-ing-nl.sta')).transactions;

    // The bank wraps `:86:` at 65 characters, mid-word: "ING T" + "estrekening".
    expect(first?.description).toBe('ING Testrekening 5200150700013379');
    expect(second?.description).toBe('ING Testrekening UstrdRemInf5878992110');
  });

  it('does not take the statement-level :86: after :62F: for a line', async () => {
    const result = parseMt940Statement(await fixture('mt940-ing-nl.sta'));
    expect(result.transactions.some((t) => t.description.includes('ING BANK N.V.'))).toBe(false);
  });

  it('says so when the lines do not reach the closing balance, and still takes that balance', async () => {
    // ING cut its sample to two entries and left the closing balance at 1605.
    const result = parseMt940Statement(await fixture('mt940-ing-nl.sta'));

    expect(result.positions?.cash).toEqual([{ currency: 'EUR', balance: '1605' }]);
    expect(result.positions?.asOf).toEqual(endOf('2014-01-03'));
    // The lines alone add up to 475: the figure that misses is the opening
    // 1000 with them on top.
    expect(result.warnings).toEqual([
      "This statement's opening balance and lines add up to 1,475 EUR, but it states a closing balance of 1,605 EUR",
    ]);
  });

  it('reads the same file with CRLF line ends', async () => {
    const crlf = (await fixture('mt940-ing-nl.sta')).replace(/\n/g, '\r\n');
    const result = parseMt940Statement(crlf);
    expect(result.transactions.map((t) => t.amount)).toEqual([350, 125]);
    expect(result.transactions[1]?.description).toBe('ING Testrekening UstrdRemInf5878992110');
  });
});

describe('parseMt940Statement — field rules', () => {
  const statement = (lines: string[]) =>
    [':20:REF', ':25:DE00123456780000000001', ':28C:1/1', ...lines].join('\n');

  it('reads an amount with no decimals after the comma, and a reversal mark', () => {
    // ING's sample writes 289 as `289,`. RC reverses a credit, RD a debit.
    const result = parseMt940Statement(
      statement([
        ':60F:C250101EUR1000,',
        ':61:250102D289,NDDTEREF//1',
        ':61:250102RC10,5NTRFNONREF',
        ':61:250102RD2,NTRFNONREF',
        ':62F:C250102EUR702,5',
      ])
    );

    expect(result.transactions.map((t) => t.amount)).toEqual([-289, -10.5, 2]);
    expect(result.warnings).toEqual([]);
  });

  it('skips the funds code between the mark and the amount', () => {
    // `DR50,00` is a debit with funds code R (EUR), not a reversal.
    const result = parseMt940Statement(
      statement([
        ':60F:C250101EUR100,00',
        ':61:2501020102DR50,00NMSCNONREF',
        ':62F:C250102EUR50,00',
      ])
    );
    expect(result.transactions.map((t) => t.amount)).toEqual([-50]);
  });

  it('a debit closing balance is negative', () => {
    const result = parseMt940Statement(
      statement([':60F:C250101EUR10,00', ':61:250102D25,00NMSCNONREF', ':62F:D250102EUR15,00'])
    );
    expect(result.positions?.cash).toEqual([{ currency: 'EUR', balance: '-15' }]);
    expect(result.warnings).toEqual([]);
  });

  it('keeps only the SVWZ+ text of a German :86:, joined across subfields', () => {
    // BNP Paribas DE's MT940 details: a keyword starts a subfield, and a
    // subfield without one continues the text before it.
    const result = parseMt940Statement(
      statement([
        ':60F:C250101EUR100,00',
        ':61:2501020102D40,00NDDTNONREF',
        ':86:105?00FOLGELASTSCHRIFT?109075?20EREF+NOTPROVIDED?21MREF+M-4711?22SVWZ+Rechnung 4711 vom 1. Jan?23uar, danke?30DEUTDEFFXXX?31DE00500700100000000001?32Stadtwerke Musterstadt?33GmbH',
        ':62F:C250102EUR60,00',
      ])
    );

    expect(result.transactions[0]?.description).toBe(
      'Stadtwerke Musterstadt GmbH Rechnung 4711 vom 1. Januar, danke'
    );
  });

  it('falls back to the booking text when a structured :86: names nothing else', () => {
    const result = parseMt940Statement(
      statement([
        ':60F:C250101EUR100,00',
        ':61:250102D1,00NCHGNONREF',
        ':86:808?00ENTGELT',
        ':62F:C250102EUR99,00',
      ])
    );
    expect(result.transactions[0]?.description).toBe('ENTGELT');
  });

  it('joins an unstructured :86: with blanks, and a line with no :86: says its type', () => {
    const result = parseMt940Statement(
      statement([
        ':60F:C250101EUR100,00',
        ':61:250102C5,00NTRFNONREF',
        ':86:Rent January',
        'Flat 12',
        ':61:250102D1,00NCHGNONREF',
        ':62F:C250102EUR104,00',
      ])
    );
    expect(result.transactions.map((t) => t.description)).toEqual(['Rent January Flat 12', 'NCHG']);
  });

  it('names the counterparty out of /NAME/ where a bank writes it that way', () => {
    const result = parseMt940Statement(
      statement([
        ':60F:C250101EUR100,00',
        ':61:2501020102C5,00NTRFNONREF',
        ':86:/TRTP/SEPA OVERBOEKING/IBAN/NL00BANK0000000002/BIC/BANKNL2A/NAME/J. Jansen/REMI/Rent J',
        'anuary/EREF/NOTPROVIDED',
        ':62F:C250102EUR105,00',
      ])
    );
    expect(result.transactions[0]?.description).toBe('J. Jansen Rent January');
  });

  it("orders a line dated after the close on the close day, says so, and keeps the bank's date", () => {
    // No entry date, so the value date is all the second line has: 5 Jan,
    // under a closing balance of 2 Jan that already holds it.
    const result = parseMt940Statement(
      statement([
        ':60F:C250101EUR100,00',
        ':61:241230D10,00NMSCNONREF',
        ':61:250105C5,00NMSCNONREF',
        ':62F:C250102EUR95,00',
      ])
    );
    expect(result.transactions.map((t) => t.date)).toEqual([day('2024-12-30'), day('2025-01-02')]);
    expect(result.transactions.map((t) => t.raw?.bankDate)).toEqual([undefined, '2025-01-05']);
    expect(result.warnings).toEqual([
      '1 line is dated after the statement closed on 2 Jan 2025, so it is placed on that day: 5 Jan 2025, 5 EUR',
    ]);
  });

  it('does the same for an entry date that no year puts on or before the close', () => {
    // Entry date 5 Jan, close 2 Jan: 5 Jan 2025 is the nearest it gets.
    const result = parseMt940Statement(
      statement([':60F:C250101EUR100,00', ':61:2501020105C5,00NMSCNONREF', ':62F:C250102EUR105,00'])
    );
    expect(result.transactions[0]?.date).toEqual(day('2025-01-02'));
    expect(result.transactions[0]?.raw?.bankDate).toBe('2025-01-05');
    expect(result.warnings).toEqual([
      '1 line is dated after the statement closed on 2 Jan 2025, so it is placed on that day: 5 Jan 2025, 5 EUR',
    ]);
  });

  it('counts the lines dated after the close and names the first five', () => {
    const result = parseMt940Statement(
      statement([
        ':60F:C250101EUR100,00',
        ...[1, 2, 3, 4, 5, 6].map((euros) => `:61:250105C${euros},00NMSCNONREF`),
        ':62F:C250102EUR121,00',
      ])
    );
    expect(result.warnings).toEqual([
      '6 lines are dated after the statement closed on 2 Jan 2025, so they are placed on that day: 5 Jan 2025, 1 EUR; 5 Jan 2025, 2 EUR; 5 Jan 2025, 3 EUR; 5 Jan 2025, 4 EUR; 5 Jan 2025, 5 EUR; and 1 more',
    ]);
  });

  it('prints a late line as the result card prints a figure: digits grouped, at the decimals it carries', () => {
    const result = parseMt940Statement(
      statement([
        ':60F:C250101EUR5000,00',
        ':61:250105D1234,50NMSCNONREF',
        ':62F:C250102EUR3765,50',
      ])
    );
    expect(result.warnings).toEqual([
      '1 line is dated after the statement closed on 2 Jan 2025, so it is placed on that day: 5 Jan 2025, -1,234.5 EUR',
    ]);
  });

  it('dates a line by its entry date, in the year nearest its value date', () => {
    // Value date 2 Jan 2025, entry date `1231`: 31 Dec 2024, not 31 Dec 2025.
    const result = parseMt940Statement(
      statement([':60F:C241230EUR100,00', ':61:2501021231C5,00NMSCNONREF', ':62F:C250102EUR105,00'])
    );
    expect(result.transactions[0]?.date).toEqual(day('2024-12-31'));
    expect(result.warnings).toEqual([]);
  });

  it('CONTROL: a January entry in a statement that closes in December keeps its own year', () => {
    // Nearest the close it would be 5 Jan 2026. Its value date says 2025, which
    // is on the right side of the close, so the statement is not asked.
    const result = parseMt940Statement(
      statement([':60F:C250101EUR100,00', ':61:2501050105C5,00NMSCNONREF', ':62F:C251231EUR105,00'])
    );
    expect(result.transactions[0]?.date).toEqual(day('2025-01-05'));
    expect(result.transactions[0]?.raw?.bankDate).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('follows one account across several statements and takes the last closing balance', () => {
    const result = parseMt940Statement(
      [
        ':20:A',
        ':25:NL00BANK0000000001',
        ':28C:1/1',
        ':60F:C250101EUR100,00',
        ':61:250101C10,00NTRFNONREF',
        ':62F:C250101EUR110,00',
        '-',
        ':20:B',
        ':25:NL00BANK0000000001',
        ':28C:2/1',
        ':60F:C250102EUR110,00',
        ':61:250102D30,00NTRFNONREF',
        ':62F:C250102EUR80,00',
        '-',
      ].join('\n')
    );

    expect(result.transactions.map((t) => t.amount)).toEqual([10, -30]);
    expect(result.positions).toEqual({
      asOf: endOf('2025-01-02'),
      cash: [{ currency: 'EUR', balance: '80' }],
      securities: [],
    });
    expect(result.warnings).toEqual([]);
  });

  it('refuses a file that holds more than one account, because an import goes to one', () => {
    const result = parseMt940Statement(
      [
        ':20:A',
        ':25:NL00BANK0000000001',
        ':28C:1/1',
        ':60F:C250101EUR100,00',
        ':61:250101C10,00NTRFNONREF',
        ':62F:C250101EUR110,00',
        '-',
        ':20:B',
        ':25:NL00BANK0000000002',
        ':28C:1/1',
        ':60F:C250101EUR5,00',
        ':61:250101D1,00NTRFNONREF',
        ':62F:C250101EUR4,00',
        '-',
      ].join('\n')
    );

    expect(result.transactions).toEqual([]);
    expect(result.positions).toBeUndefined();
    expect(result.holdings).toEqual([]);
    expect(result.warnings).toEqual([
      'This file holds statements for 2 accounts, so nothing was imported. Export one account per file',
    ]);
  });

  it('warns about a :61: line it cannot read and keeps the rest', () => {
    const result = parseMt940Statement(
      statement([
        ':60F:C250101EUR100,00',
        ':61:not a statement line',
        ':61:250102C5,00NTRFNONREF',
        ':62F:C250102EUR105,00',
      ])
    );
    expect(result.transactions.map((t) => t.amount)).toEqual([5]);
    expect(result.warnings).toEqual([
      'Statement line not understood, skipped: not a statement line',
    ]);
  });

  it('says a file with no statement in it is not MT940', () => {
    const result = parseMt940Statement('date,amount\n2025-01-01,5');
    expect(result.transactions).toEqual([]);
    expect(result.warnings).toEqual(['No MT940 statement found in the file']);
  });
});
