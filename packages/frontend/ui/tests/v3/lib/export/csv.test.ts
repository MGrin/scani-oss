import { describe, expect, it } from 'bun:test';
import { exportMoney, exportPercent } from '../../../../src/v3/lib/export/cell';
import { defaultCsvSeparator, toCsv, toCsvBlob } from '../../../../src/v3/lib/export/csv';
import { buildSheet, type ExportSheet } from '../../../../src/v3/lib/export/workbook';

function sheet(headers: string[], rows: ExportSheet['rows']): ExportSheet {
  return { name: 'Test', headers, rows, numericColumns: headers.map(() => false) };
}

describe('toCsv', () => {
  it('writes a header row and CRLF-terminated records', () => {
    const csv = toCsv(
      sheet(
        ['Vendor', 'Value'],
        [
          [
            { kind: 'text', value: 'Netflix' },
            { kind: 'number', value: '12.99' },
          ],
        ]
      )
    );
    expect(csv).toBe('Vendor,Value\r\nNetflix,12.99\r\n');
  });

  it('never localises the decimal mark, whatever the separator', () => {
    const row = sheet(['Value'], [[{ kind: 'number', value: '1234.56', style: 'money' }]]);
    expect(toCsv(row, ',')).toContain('1234.56');
    expect(toCsv(row, ';')).toContain('1234.56');
    // The bug SC-75 fixed on input, not reintroduced on output: no field in
    // either file can be read as two.
    expect(toCsv(row, ',')).not.toContain('1234,56');
    expect(toCsv(row, ';')).not.toContain('1234,56');
  });

  it('quotes a field containing the separator, and only that separator', () => {
    const row = sheet(['Name'], [[{ kind: 'text', value: 'Müller, Ltd' }]]);
    expect(toCsv(row, ',')).toBe('Name\r\n"Müller, Ltd"\r\n');
    expect(toCsv(row, ';')).toBe('Name\r\nMüller, Ltd\r\n');
  });

  it('doubles an embedded quote and quotes the field', () => {
    const row = sheet(['Name'], [[{ kind: 'text', value: 'The "Best" Bank' }]]);
    expect(toCsv(row)).toBe('Name\r\n"The ""Best"" Bank"\r\n');
  });

  it('quotes a field carrying a newline so the record stays one record', () => {
    const row = sheet(['Note'], [[{ kind: 'text', value: 'line one\nline two' }]]);
    expect(toCsv(row)).toBe('Note\r\n"line one\nline two"\r\n');
  });

  it('neutralises a text cell that would be read as a formula', () => {
    const row = sheet(
      ['Name'],
      [
        [{ kind: 'text', value: '=1+1' }],
        [{ kind: 'text', value: '@SUM(A1)' }],
        [{ kind: 'text', value: '-4 Rent' }],
      ]
    );
    const lines = toCsv(row).split('\r\n');
    expect(lines[1]).toBe("'=1+1");
    expect(lines[2]).toBe("'@SUM(A1)");
    // A leading minus is ordinary content and is left alone.
    expect(lines[3]).toBe('-4 Rent');
  });

  it('writes a blank cell as an empty field rather than as a zero', () => {
    const row = sheet(
      ['A', 'B'],
      [[{ kind: 'blank' }, { kind: 'number', value: '0', style: 'money' }]]
    );
    expect(toCsv(row)).toBe('A,B\r\n,0\r\n');
  });

  it('writes a date-only cell without a time', () => {
    const row = sheet(
      ['When', 'At'],
      [
        [
          { kind: 'date', value: '2026-08-14', withTime: false },
          { kind: 'date', value: '2026-08-14T09:30:00.000Z', withTime: true },
        ],
      ]
    );
    expect(toCsv(row)).toBe('When,At\r\n2026-08-14,2026-08-14T09:30:00.000Z\r\n');
  });
});

/**
 * SC-174. The three writers are fed one resolved sheet precisely so they cannot
 * present the same figure differently; the CSV was the one that did.
 */
describe('the CSV writes what the sheet resolved, at the precision it declared', () => {
  interface Row {
    value: string;
    gain: string;
  }

  const build = (row: Row) =>
    buildSheet<Row>(
      'Holdings',
      [
        { header: 'Value', value: (r) => exportMoney(r.value, 'EUR') },
        { header: 'Gain / loss', value: (r) => exportPercent(r.gain) },
      ],
      [row]
    );

  it('rounds money to the cents it declares rather than writing the float tail', () => {
    const csv = toCsv(build({ value: '130017.64836043886', gain: '35.13513513513512' }));
    expect(csv).toBe('Value (EUR),Gain / loss (%)\r\n130017.65,35.14\r\n');
  });

  it('names percent in the header, so a bare figure cannot be read as euros', () => {
    expect(toCsv(build({ value: '1.00', gain: '12' }))).toContain('Gain / loss (%)');
  });

  it('writes a sub-cent price in full rather than as a rounded-away zero', () => {
    const csv = toCsv(build({ value: '0.00007714915547392611', gain: '15.84' }));
    expect(csv).toContain('0.00007715');
  });
});

describe('toCsvBlob', () => {
  it('prefixes a UTF-8 BOM so Excel does not mangle accented names', async () => {
    const blob = toCsvBlob(sheet(['Name'], [[{ kind: 'text', value: 'Société' }]]));
    // The raw bytes, not `blob.text()`: the Blob decoder strips the BOM on the
    // way out, which is exactly the thing under test.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(await blob.text()).toContain('Société');
    expect(blob.type).toBe('text/csv;charset=utf-8');
  });
});

describe('defaultCsvSeparator', () => {
  it('picks a semicolon for a locale whose decimal mark is a comma', () => {
    expect(defaultCsvSeparator('de-DE')).toBe(';');
    expect(defaultCsvSeparator('fr-FR')).toBe(';');
  });

  it('picks a comma for a locale whose decimal mark is a full stop', () => {
    expect(defaultCsvSeparator('en-US')).toBe(',');
    expect(defaultCsvSeparator('en-GB')).toBe(',');
  });
});

describe('provenance preamble (SC-93 item 2)', () => {
  const provenance = {
    subject: 'Holdings',
    scope: 'Filtered — 7 of 19 holdings',
    generatedAt: new Date('2026-08-14T10:00:00.000Z'),
    rowCount: 7,
    details: [{ label: 'Type', value: 'Cryptocurrency' }],
  };

  it('states what the file is, above the header', () => {
    const csv = toCsv(sheet(['Holding'], [[{ kind: 'text', value: 'BTC' }]]), ',', provenance);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('# Exported from: Scani');
    expect(lines).toContain('# Subject: Holdings');
    expect(lines).toContain('# Scope: Filtered — 7 of 19 holdings');
    expect(lines).toContain('# Generated: 2026-08-14T10:00:00.000Z');
    expect(lines).toContain('# Rows: 7');
    expect(lines).toContain('# Type: Cryptocurrency');
    // A bare marker separates the block from the table, so nothing reads as a
    // header continuation.
    expect(lines).toContain('#');
  });

  it('leaves the header row and the data untouched below it', () => {
    const csv = toCsv(sheet(['Holding'], [[{ kind: 'text', value: 'BTC' }]]), ',', provenance);
    const table = csv.split('\r\n').filter((line) => !line.startsWith('#'));
    expect(table[0]).toBe('Holding');
    expect(table[1]).toBe('BTC');
  });

  it('says when the amounts were withheld', () => {
    const csv = toCsv(sheet(['Holding'], []), ',', { ...provenance, amountsWithheld: true });
    expect(csv).toContain('# Amounts: Withheld');
  });

  it('cannot inject a row through a filter value containing a newline', () => {
    const csv = toCsv(sheet(['Holding'], []), ',', {
      ...provenance,
      details: [{ label: 'Search', value: 'btc\r\nEVIL,ROW' }],
    });
    for (const line of csv.split('\r\n')) {
      expect(line === '' || line.startsWith('#') || line === 'Holding').toBe(true);
    }
  });

  it('keeps the BOM first, ahead of the preamble', async () => {
    // Excel only honours a BOM at offset zero — the `Société` case verified in
    // SC-89 regresses the moment anything gets in front of it.
    const blob = toCsvBlob(
      sheet(['Name'], [[{ kind: 'text', value: 'Société' }]]),
      ',',
      provenance
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(await blob.text()).toContain('# Subject: Holdings');
    expect(await blob.text()).toContain('Société');
  });

  it('writes no preamble when it has nothing to describe', () => {
    const csv = toCsv(sheet(['Holding'], []));
    expect(csv.startsWith('Holding')).toBe(true);
  });
});
