import { describe, expect, it } from 'bun:test';
import {
  readSpreadsheetTable,
  SPREADSHEET_UNPACKED_MAX_BYTES,
  SpreadsheetRefusal,
  sniffSpreadsheet,
} from '../src/spreadsheet';

const fixture = async (name: string) =>
  new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer());

const text = (value: string) => new TextEncoder().encode(value);

/** The eight bytes every OLE compound file, and so every binary `.xls`, starts with. */
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

async function refusalOf(bytes: Uint8Array): Promise<string | null> {
  try {
    await readSpreadsheetTable(bytes);
    return null;
  } catch (error) {
    if (error instanceof SpreadsheetRefusal) return error.reason;
    throw error;
  }
}

describe('sniffSpreadsheet', () => {
  it('names a zip as XLSX and an OLE compound file as binary XLS', async () => {
    expect(sniffSpreadsheet(await fixture('xlsx-intesa-it.xlsx'))).toBe('xlsx');
    expect(sniffSpreadsheet(new Uint8Array([...OLE_SIGNATURE, 0, 0, 0, 0]))).toBe('xls-binary');
  });

  it('reads past the extension: an HTML table and XML Spreadsheet 2003 are text', async () => {
    expect(sniffSpreadsheet(await fixture('xls-html-webank-it.xls'))).toBe('xls-html');
    expect(sniffSpreadsheet(await fixture('xls-spreadsheetml-synthetic.xls'))).toBe('xls-xml');
    expect(sniffSpreadsheet(text('Date\tAmount\n2026-01-02\t5\n'))).toBe('xls-text');
  });
});

describe('readSpreadsheetTable', () => {
  it('XLSX: starts at the header under the metadata rows, and writes dates as ISO days', async () => {
    const table = await readSpreadsheetTable(await fixture('xlsx-intesa-it.xlsx'));
    expect(table.kind).toBe('xlsx');
    expect(table.rows[0]).toEqual([
      'Data',
      'Operazione',
      'Dettagli',
      'Categoria',
      'Valuta',
      'Importo',
    ]);
    expect(table.rows[1]).toEqual([
      '2025-06-01',
      'Bonifico disposto',
      'Rossi Immobiliare canone locazione',
      'Casa',
      'EUR',
      '-850',
    ]);
    expect(table.rows).toHaveLength(180);
  });

  it('XLSX stored as text: keeps the bank strings and turns empty cells into empty strings', async () => {
    const table = await readSpreadsheetTable(await fixture('xlsx-cib-cn.xlsx'));
    expect(table.rows[0]).toHaveLength(12);
    expect(table.rows[0]?.slice(0, 5)).toEqual(['交易时间', '记账日', '支出', '收入', '账户余额']);
    expect(table.rows[1]?.slice(0, 5)).toEqual([
      '2024-01-01 00:00:00',
      '2024-01-01',
      '',
      '10.00',
      '10.00',
    ]);
  });

  it('an HTML table served as .xls: the header row and every row under it', async () => {
    const table = await readSpreadsheetTable(await fixture('xls-html-webank-it.xls'));
    expect(table.kind).toBe('xls-html');
    expect(table.rows[0]).toEqual(['Data Contabile', 'Causale / Descrizione', 'Importo']);
    expect(table.rows[1]).toEqual(['16/06/2026', 'Prelievo Atm Milano Via Manzoni', '-131,88']);
    expect(table.rows).toHaveLength(27);
  });

  it('XML Spreadsheet 2003: skips an empty sheet, honours ss:Index, and types each cell', async () => {
    const table = await readSpreadsheetTable(await fixture('xls-spreadsheetml-synthetic.xls'));
    expect(table.kind).toBe('xls-xml');
    expect(table.rows).toEqual([
      ['Date', 'Description', 'Amount', 'Balance'],
      ['2026-03-02', 'Card payment Example Store & Co', '-12.5', '987.5'],
      ['2026-03-03', '', '200', '1187.5'],
      ['2026-03-05', 'Interest', '0.75', '1188.25'],
    ]);
  });

  it('an HTML table finds its encoding: a UTF-16 BOM, or a meta charset', async () => {
    const html =
      '<table><tr><th>Date</th><th>Libellé</th></tr><tr><td>02/01/2026</td><td>Café</td></tr></table>';
    const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(Buffer.from(html, 'utf16le'))]);
    expect((await readSpreadsheetTable(utf16)).rows[1]).toEqual(['02/01/2026', 'Café']);

    const latin1 = new Uint8Array(
      Buffer.from(
        `<html><head><meta charset="windows-1252"></head><body>${html}</body></html>`,
        'latin1'
      )
    );
    expect((await readSpreadsheetTable(latin1)).rows[0]).toEqual(['Date', 'Libellé']);
  });

  it('pads a short row to the header width, so every row has the same columns', async () => {
    const html =
      '<table><tr><td>Date</td><td>Text</td><td>Amount</td></tr><tr><td>2026-01-02</td><td>x</td></tr></table>';
    expect((await readSpreadsheetTable(text(html))).rows[1]).toEqual(['2026-01-02', 'x', '']);
  });

  it('refuses a binary .xls, which no reader here opens', async () => {
    expect(await refusalOf(new Uint8Array([...OLE_SIGNATURE, ...new Uint8Array(504)]))).toBe(
      'binary-xls'
    );
  });

  it('refuses an XLSX that says it unpacks past the limit, before unpacking it', async () => {
    const bytes = await fixture('xlsx-intesa-it.xlsx');
    expect(await refusalOf(bytes)).toBeNull();

    const swollen = withDeclaredUncompressedSize(bytes, SPREADSHEET_UNPACKED_MAX_BYTES + 1);
    expect(await refusalOf(swollen)).toBe('too-large');
  });

  it('refuses a zip that is not a workbook', async () => {
    expect(await refusalOf(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]))).toBe(
      'unreadable'
    );
  });
});

/** The fixture with its first central-directory entry claiming `size` unpacked bytes. */
function withDeclaredUncompressedSize(bytes: Uint8Array, size: number): Uint8Array {
  const copy = new Uint8Array(bytes);
  const view = new DataView(copy.buffer);
  for (let i = copy.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      const centralDirectory = view.getUint32(i + 16, true);
      view.setUint32(centralDirectory + 24, size, true);
      return copy;
    }
  }
  throw new Error('no end-of-central-directory record');
}
