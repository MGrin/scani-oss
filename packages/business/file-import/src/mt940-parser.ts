import { Decimal } from '@scani/shared';
import {
  type BalancedStatement,
  balancedStatementResult,
  type StatedBalance,
  utcDay,
} from './stated-balances';
import type { ParseResult } from './types';

interface Field {
  tag: string;
  lines: string[];
}

interface StatementLine {
  valueDay: Date;
  /** `MMDD`, where the bank gives an entry date. It names no year. */
  entry: string | null;
  amount: number;
  typeCode: string;
  reference: string;
  bankReference: string;
  details?: string[];
}

const FIELD = /^:(\d{2}[A-Z]?):(.*)$/;
const BALANCE = /^([CD])(\d{6})([A-Z]{3})(\d+,\d*)$/;
// Value date, entry date, debit/credit mark, funds code, amount, type code,
// then the account owner's reference and the bank's, split by `//`.
const STATEMENT_LINE =
  /^(\d{6})(\d{4})?(R?[CD])([A-Z])?(\d+,\d*)([A-Z][A-Z0-9]{3})(.*?)(?:\/\/(.*))?$/;

// A `?NN` subfield holds 27 characters. One that is full was cut there.
const SUBFIELD_WIDTH = 27;
const PURPOSE_SUBFIELDS = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 60, 61, 62, 63];
const SEPA_KEYWORD = /^(EREF|KREF|MREF|CRED|DEBT|SVWZ|ABWA|ABWE|IBAN|BIC|COAM|OAMT|PURP|RREF)\+/;
const SLASH_CODE =
  /\/(EREF|MARF|CSID|CNTP|REMI|PURP|ULTC|ULTD|PREF|IREF|RTRN|EXCH|CHGS|TRTP|IBAN|BIC|NAME|ORDP|BENM|ADDR|ISDT|CDTRREFTP|CDTRREF|SVCL|ID)\//g;

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Parse a SWIFT MT940 customer statement into normalized transactions.
 *
 * A line is dated by its entry (booking) date where the bank gives one, and
 * described by the counterparty's name and the remittance text out of its
 * `:86:`, whichever of the three `:86:` layouts the bank writes.
 */
export function parseMt940Statement(content: string): ParseResult {
  const warnings: string[] = [];
  const statements = fieldsByStatement(content).map((fields) => readStatement(fields, warnings));
  if (statements.length === 0) {
    return {
      transactions: [],
      holdings: [],
      format: 'mt940',
      warnings: ['No MT940 statement found in the file'],
    };
  }
  return balancedStatementResult('mt940', statements, warnings);
}

/** A `:20:` opens a statement; a line that opens no field continues the one above it. */
function fieldsByStatement(content: string): Field[][] {
  const statements: Field[][] = [];
  let field: Field | null = null;
  for (const raw of content.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    // A SWIFT envelope opens the text block on its header line: `{1:…}{2:…}{4:`.
    const line = raw.replace(/^\{.*\{4:/, '');
    const tagged = FIELD.exec(line);
    if (tagged) {
      if (tagged[1] === '20') statements.push([]);
      field = { tag: tagged[1]!, lines: [tagged[2]!] };
      statements.at(-1)?.push(field);
    } else if (line === '-' || line.startsWith('-}')) {
      field = null;
    } else if (line !== '') {
      field?.lines.push(line);
    }
  }
  return statements;
}

function readStatement(fields: Field[], warnings: string[]): BalancedStatement {
  let account = '';
  let opening: StatedBalance | undefined;
  let closing: StatedBalance | undefined;
  const lines: StatementLine[] = [];
  // Only a `:86:` directly under a `:61:` describes a line. The one after the
  // closing balance is the bank's note on the whole statement.
  let described: StatementLine | null = null;

  for (const { tag, lines: text } of fields) {
    const value = text[0] ?? '';
    const line = tag === '61' ? readLine(value) : null;
    if (tag === '25') account = value.trim();
    else if (tag === '60F' || tag === '60M') opening ??= readBalance(value);
    else if (tag === '62F' || tag === '62M') closing = readBalance(value) ?? closing;
    else if (tag === '61' && line) lines.push(line);
    else if (tag === '61') warnings.push(`Statement line not understood, skipped: ${value}`);
    else if (tag === '86' && described) described.details = text;
    described = line;
  }

  const currency = (opening ?? closing)?.currency;
  if (!currency) {
    if (lines.length > 0) {
      warnings.push(
        `A statement states no balance, so the currency of its ${lines.length} lines is unknown and they were skipped`
      );
    }
    return { account, transactions: [] };
  }

  return {
    account: `${account} ${currency}`,
    opening,
    closing,
    transactions: lines.map((line) => ({
      date: lineDay(line, closing),
      description: describe(line),
      amount: line.amount,
      currency,
      raw: {
        reference: line.reference,
        typeCode: line.typeCode,
        ...(line.bankReference ? { bankReference: line.bankReference } : {}),
      },
    })),
  };
}

function readBalance(value: string): StatedBalance | undefined {
  const match = BALANCE.exec(value.trim());
  const day = match && readDay(match[2]!);
  if (!match || !day) return undefined;
  const amount = new Decimal(match[4]!.replace(',', '.'));
  return { currency: match[3]!, day, amount: match[1] === 'D' ? amount.neg() : amount };
}

function readLine(value: string): StatementLine | null {
  const match = STATEMENT_LINE.exec(value);
  const valueDay = match && readDay(match[1]!);
  if (!match || !valueDay) return null;
  const entry = match[2] ?? null;
  if (entry && !readEntryDay(entry, valueDay)) return null;

  // `RC` reverses a credit and `RD` a debit, so each moves the other way.
  const credit = match[3] === 'C' || match[3] === 'RD';
  const amount = new Decimal(match[5]!.replace(',', '.'));
  return {
    valueDay,
    entry,
    amount: (credit ? amount : amount.neg()).toNumber() + 0,
    typeCode: match[6]!,
    reference: match[7]!.trim(),
    bankReference: (match[8] ?? '').trim(),
  };
}

function readDay(yymmdd: string): Date | null {
  const year = Number(yymmdd.slice(0, 2));
  return utcDay(
    year < 80 ? 2000 + year : 1900 + year,
    Number(yymmdd.slice(2, 4)),
    Number(yymmdd.slice(4, 6))
  );
}

/**
 * A line is dated by its entry (booking) date where the bank gives one. An
 * entry date names no year, and takes the one that puts it nearest the value
 * date. A line cannot be booked after its statement closes, so when that year
 * says it was, the entry date is read beside the close instead: ING's own
 * sample puts a 2025 value date in a statement that closes in 2014.
 */
function lineDay(line: StatementLine, closing: StatedBalance | undefined): Date {
  const besideValue = line.entry ? readEntryDay(line.entry, line.valueDay) : null;
  if (!line.entry || !besideValue) return line.valueDay;
  if (!closing || besideValue <= closing.day) return besideValue;
  return readEntryDay(line.entry, closing.day) ?? besideValue;
}

/** `MMDD` in the year that puts it nearest `near`. */
function readEntryDay(mmdd: string, near: Date): Date | null {
  const year = near.getUTCFullYear();
  const distance = (day: Date) => Math.abs(day.getTime() - near.getTime());
  return [year - 1, year, year + 1]
    .map((candidate) => utcDay(candidate, Number(mmdd.slice(0, 2)), Number(mmdd.slice(2, 4))))
    .reduce<Date | null>(
      (nearest, day) => (day && (!nearest || distance(day) < distance(nearest)) ? day : nearest),
      null
    );
}

function describe(line: StatementLine): string {
  if (!line.details) return line.typeCode;
  // A bank wraps `:86:` at 65 characters, mid-word, so a structured one
  // rejoins with nothing between its lines.
  const joined = line.details.join('');
  if (/^\d{3}\?\d{2}/.test(joined)) return describeSubfields(joined) || line.typeCode;
  if (/^\/[A-Z]{2,9}\//.test(joined)) return describeSlashCodes(joined);
  return clean(line.details.join(' '));
}

/** `?NN` subfields: `?00` booking text, `?20`–`?29` and `?60`–`?63` purpose, `?32`–`?33` name. */
function describeSubfields(text: string): string {
  const parts = text.split(/\?(\d{2})/);
  const fields = new Map<number, string>();
  for (let i = 1; i < parts.length; i += 2) fields.set(Number(parts[i]), parts[i + 1] ?? '');
  // Some banks fill an unused subfield with a dash.
  const subfield = (code: number) => {
    const value = fields.get(code) ?? '';
    return value.trim() === '-' ? '' : value;
  };

  const name = subfield(32) + (subfield(32).length === SUBFIELD_WIDTH ? '' : ' ') + subfield(33);
  const purpose = PURPOSE_SUBFIELDS.map(subfield).filter((value) => value !== '');
  const sepa = purpose.some((value) => SEPA_KEYWORD.test(value));
  return (
    clean(`${name} ${sepa ? sepaPurpose(purpose) : plainPurpose(fields, subfield)}`) ||
    clean(subfield(0))
  );
}

/**
 * A German SEPA `:86:` opens a subfield with a keyword (`EREF+`, `SVWZ+`), and
 * a subfield without one continues the text before it. Only `SVWZ+` is the
 * purpose; the rest are references.
 */
function sepaPurpose(purpose: string[]): string {
  let keyword = 'SVWZ';
  let text = '';
  for (const value of purpose) {
    const opened = SEPA_KEYWORD.exec(value);
    if (opened) keyword = opened[1]!;
    if (keyword === 'SVWZ') text += opened ? value.slice(opened[0].length) : value;
  }
  return text;
}

/**
 * Without keywords each `?2N` subfield is a value of its own. `?60`–`?63`
 * continue the purpose, with nothing between where the one before was cut.
 */
function plainPurpose(fields: Map<number, string>, subfield: (code: number) => string): string {
  let text = '';
  let previous = '';
  for (const code of PURPOSE_SUBFIELDS) {
    if (!fields.has(code)) continue;
    const value = subfield(code);
    if (value !== '') {
      text += code >= 60 && previous.length === SUBFIELD_WIDTH ? value : ` ${value}`;
    }
    previous = value;
  }
  return text;
}

/** `/CODE/value/` fields: `/CNTP/` or `/NAME/` names the counterparty, `/REMI/` is the text. */
function describeSlashCodes(text: string): string {
  const marks = [...text.matchAll(SLASH_CODE)];
  const values = new Map<string, string>();
  marks.forEach((mark, i) => {
    const value = text.slice(mark.index + mark[0].length, marks[i + 1]?.index ?? text.length);
    if (!values.has(mark[1]!)) values.set(mark[1]!, value.replace(/\/+$/, ''));
  });

  // `/CNTP/account/BIC/name/city/`.
  const name = values.get('CNTP')?.split('/')[2] ?? values.get('NAME') ?? '';
  // `/REMI/USTD//text/` or `/REMI/STRD/CUR/reference/`; some banks write the text alone.
  const remittance = (values.get('REMI') ?? '').replace(/^(USTD\/\/|STRD\/[A-Z]*\/)/, '');
  return clean(`${name} ${remittance}`) || clean(text);
}
