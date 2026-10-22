import { Parser as HtmlParser } from 'htmlparser2';
import Papa from 'papaparse';
import readXlsxFile from 'read-excel-file/node';
// @ts-expect-error — xml2js (CommonJS) ships no type declarations
import xml2js from 'xml2js';

/**
 * A spreadsheet statement as a table of text, header row first, so it can go
 * through the CSV column mapping rather than a second mapper (SC-1734).
 *
 * Banks name several things `.xls`: a real binary workbook, an HTML table, XML
 * Spreadsheet 2003, or plain delimited text. The bytes decide which.
 */
export type SpreadsheetKind = 'xlsx' | 'xls-binary' | 'xls-html' | 'xls-xml' | 'xls-text';

export type SpreadsheetRefusalReason = 'binary-xls' | 'too-large' | 'unreadable';

export class SpreadsheetRefusal extends Error {
  constructor(readonly reason: SpreadsheetRefusalReason) {
    super(`spreadsheet refused: ${reason}`);
    this.name = 'SpreadsheetRefusal';
  }
}

export interface SpreadsheetTable {
  kind: SpreadsheetKind;
  rows: string[][];
  /** Non-empty cells above the header row: account details, period, sometimes the currency. */
  preamble: string[];
}

/**
 * Uploads stop at 8 MB, and a zip can unpack far past that. A workbook whose
 * central directory declares more than this is refused before anything is
 * unpacked: no statement needs it, and a zip bomb is exactly that shape.
 */
export const SPREADSHEET_UNPACKED_MAX_BYTES = 64 * 1024 * 1024;

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const SPREADSHEET_ML = 'urn:schemas-microsoft-com:office:spreadsheet';

const startsWith = (bytes: Uint8Array, signature: number[]) =>
  signature.every((byte, i) => bytes[i] === byte);

export function isSpreadsheetBinary(bytes: Uint8Array): boolean {
  return startsWith(bytes, ZIP_SIGNATURE) || startsWith(bytes, OLE_SIGNATURE);
}

export function sniffSpreadsheet(bytes: Uint8Array): SpreadsheetKind {
  if (startsWith(bytes, ZIP_SIGNATURE)) return 'xlsx';
  if (startsWith(bytes, OLE_SIGNATURE)) return 'xls-binary';
  const head = decodeText(bytes.subarray(0, 8192)).toLowerCase();
  if (head.includes(SPREADSHEET_ML) && head.includes('<workbook')) return 'xls-xml';
  if (head.includes('<table')) return 'xls-html';
  return 'xls-text';
}

export async function readSpreadsheetTable(bytes: Uint8Array): Promise<SpreadsheetTable> {
  const kind = sniffSpreadsheet(bytes);
  const cells = await readCells(kind, bytes);
  return { kind, ...tableFrom(cells) };
}

type Cell = string | number | boolean | Date | null | undefined;

async function readCells(kind: SpreadsheetKind, bytes: Uint8Array): Promise<Cell[][]> {
  switch (kind) {
    case 'xls-binary':
      throw new SpreadsheetRefusal('binary-xls');
    case 'xlsx':
      return readXlsx(bytes);
    case 'xls-html':
      return readHtmlTable(decodeText(bytes));
    case 'xls-xml':
      return readSpreadsheetMl(decodeText(bytes));
    case 'xls-text':
      return Papa.parse<string[]>(decodeText(bytes), { skipEmptyLines: true }).data;
  }
}

async function readXlsx(bytes: Uint8Array): Promise<Cell[][]> {
  const unpacked = declaredUnpackedBytes(bytes);
  if (unpacked === null) throw new SpreadsheetRefusal('unreadable');
  if (unpacked > SPREADSHEET_UNPACKED_MAX_BYTES) throw new SpreadsheetRefusal('too-large');

  let sheets: Awaited<ReturnType<typeof readXlsxFile>>;
  try {
    // A string would be read as a file PATH by this library, so only bytes go in.
    sheets = await readXlsxFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch {
    throw new SpreadsheetRefusal('unreadable');
  }
  const sheet = sheets.find((s) => s.data.some((row) => row.some((cell) => cell !== null)));
  return (sheet?.data ?? []) as Cell[][];
}

/**
 * The unpacked size every central-directory entry declares, summed. Null when
 * there is no readable directory, or when an entry needs ZIP64 to say its size:
 * a workbook that large is refused either way.
 */
function declaredUnpackedBytes(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchFrom = Math.max(0, bytes.length - 22 - 0xffff);
  for (let end = bytes.length - 22; end >= searchFrom; end--) {
    if (view.getUint32(end, true) !== 0x06054b50) continue;
    const entries = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    let total = 0;
    for (let i = 0; i < entries; i++) {
      if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null;
      const size = view.getUint32(at + 24, true);
      if (size === 0xffffffff) return null;
      total += size;
      at +=
        46 +
        view.getUint16(at + 28, true) +
        view.getUint16(at + 30, true) +
        view.getUint16(at + 32, true);
    }
    return total;
  }
  return null;
}

/** The table with the most rows; a bank page can wrap its statement in a layout table. */
function readHtmlTable(html: string): Cell[][] {
  const tables: string[][][] = [];
  const open: { rows: string[][]; cell: string | null }[] = [];
  const parser = new HtmlParser(
    {
      onopentag(name) {
        const table = open.at(-1);
        if (name === 'table') open.push({ rows: [], cell: null });
        else if (!table) return;
        else if (name === 'tr') table.rows.push([]);
        else if (name === 'td' || name === 'th') {
          if (table.rows.length === 0) table.rows.push([]);
          table.cell = '';
        } else if (name === 'br' && table.cell !== null) table.cell += ' ';
      },
      ontext(value) {
        const table = open.at(-1);
        if (table && table.cell !== null) table.cell += value;
      },
      onclosetag(name) {
        const table = open.at(-1);
        if (!table) return;
        if ((name === 'td' || name === 'th') && table.cell !== null) {
          table.rows.at(-1)?.push(table.cell.replace(/\s+/g, ' ').trim());
          table.cell = null;
        } else if (name === 'table') {
          tables.push(table.rows);
          open.pop();
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true }
  );
  parser.write(html);
  parser.end();
  for (const table of open) tables.push(table.rows);
  return tables.reduce<string[][]>((best, rows) => (rows.length > best.length ? rows : best), []);
}

type XmlNode = { $?: Record<string, string>; _?: string; [child: string]: unknown };

async function readSpreadsheetMl(xml: string): Promise<Cell[][]> {
  let doc: { Workbook?: { Worksheet?: XmlNode[] } };
  try {
    doc = await xml2js.parseStringPromise(xml, {
      tagNameProcessors: [xml2js.processors.stripPrefix],
      attrNameProcessors: [xml2js.processors.stripPrefix],
    });
  } catch {
    throw new SpreadsheetRefusal('unreadable');
  }
  for (const sheet of doc.Workbook?.Worksheet ?? []) {
    const table = (sheet.Table as XmlNode[] | undefined)?.[0];
    const rows: Cell[][] = [];
    for (const row of (table?.Row as XmlNode[] | undefined) ?? []) {
      const index = Number(row.$?.Index);
      while (index > rows.length + 1) rows.push([]);
      const cells: Cell[] = [];
      for (const cell of (row.Cell as XmlNode[] | undefined) ?? []) {
        const at = Number(cell.$?.Index);
        while (at > cells.length + 1) cells.push(null);
        cells.push(spreadsheetMlValue((cell.Data as (XmlNode | string)[] | undefined)?.[0]));
      }
      rows.push(cells);
    }
    if (rows.some((row) => row.some((cell) => cell !== null && cell !== ''))) return rows;
  }
  return [];
}

function spreadsheetMlValue(data: XmlNode | string | undefined): Cell {
  if (data === undefined) return null;
  const value = typeof data === 'string' ? data : (data._ ?? '');
  const type = typeof data === 'string' ? 'String' : data.$?.Type;
  if (type === 'Number') return Number(value);
  if (type === 'Boolean') return value === '1';
  if (type === 'DateTime') {
    const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  return value;
}

/** Header first: the earliest row within one cell of the widest, then everything under it. */
function tableFrom(cells: Cell[][]): { rows: string[][]; preamble: string[] } {
  const rows = cells.map((row) => row.map(cellText));
  const filled = rows.map((row) => row.filter((cell) => cell !== '').length);
  const widest = Math.max(0, ...filled);
  const header = filled.findIndex((count) => count > 0 && count >= Math.max(1, widest - 1));
  if (header === -1) return { rows: [], preamble: [] };
  const preamble = rows
    .slice(0, header)
    .flat()
    .filter((cell) => cell !== '');

  const headerRow = rows[header]!;
  const width = headerRow.reduce((last, cell, i) => (cell === '' ? last : i + 1), 0);
  const table = rows
    .slice(header)
    .filter((row, i) => i === 0 || row.some((cell) => cell !== ''))
    .map((row, i) =>
      Array.from({ length: width }, (_, column) => {
        const cell = row[column] ?? '';
        return i === 0 && cell === '' ? `Column ${column + 1}` : cell;
      })
    );
  return { rows: table, preamble };
}

function cellText(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) {
    const iso = cell.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : `${iso.slice(0, 19)}Z`;
  }
  if (typeof cell === 'number') {
    const plain = String(cell);
    return plain.includes('e') ? cell.toFixed(10).replace(/\.?0+$/, '') : plain;
  }
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  return String(cell).trim();
}

/** A BOM decides; otherwise a declared charset; otherwise UTF-8. */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  const declared = head.match(/(?:charset|encoding)\s*=\s*["']?([\w-]+)/i)?.[1];
  if (declared) {
    try {
      return new TextDecoder(declared as ConstructorParameters<typeof TextDecoder>[0]).decode(
        bytes
      );
    } catch {
      // An encoding the runtime does not know: read it as UTF-8 below.
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}
