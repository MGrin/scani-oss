import { Decimal, isValidDecimalString } from '@scani/shared';
// @ts-expect-error — xml2js (CommonJS) ships no type declarations
import xml2js from 'xml2js';
import {
  type BalancedStatement,
  balancedStatementResult,
  type StatedBalance,
  utcDay,
} from './stated-balances';
import type { ParsedTransaction, ParseResult } from './types';

// The other two cash-management messages share the entry layout, but neither
// is a statement: a report is intraday and a notification states no balance.
const OTHER_MESSAGES: Record<string, string> = {
  BkToCstmrAcctRpt: 'camt.052',
  BkToCstmrDbtCdtNtfctn: 'camt.054',
};

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Every `name` child of a parsed element. xml2js makes each child an array. */
function children(node: unknown, name: string): unknown[] {
  if (typeof node !== 'object' || node === null) return [];
  const found = (node as Record<string, unknown>)[name];
  return Array.isArray(found) ? found : [];
}

function at(node: unknown, ...path: string[]): unknown[] {
  return path.reduce<unknown[]>(
    (nodes, name) => nodes.flatMap((each) => children(each, name)),
    [node]
  );
}

/** An element's text. One with attributes keeps its text under `_`. */
function text(node: unknown): string {
  if (typeof node === 'string') return node.trim();
  const inner = typeof node === 'object' && node !== null ? (node as { _?: unknown })._ : null;
  return typeof inner === 'string' ? inner.trim() : '';
}

const first = (node: unknown, ...path: string[]) => text(at(node, ...path)[0]);

function currencyOf(amount: unknown): string {
  const attributes =
    typeof amount === 'object' && amount !== null ? (amount as { $?: unknown }).$ : null;
  const currency = (attributes as { Ccy?: unknown } | null)?.Ccy;
  return typeof currency === 'string' ? currency : '';
}

/** The calendar day a `Dt` or `DtTm` names, as the bank wrote it. */
function readDay(node: unknown): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(first(node, 'Dt') || first(node, 'DtTm'));
  return match ? utcDay(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/**
 * Parse an ISO 20022 camt.053 bank-to-customer statement, any version, into
 * normalized transactions.
 *
 * One transaction per booked entry, which is one movement of the account: a
 * batch entry is not split into the payments inside it.
 */
export async function parseCamt053Statement(content: string): Promise<ParseResult> {
  const refusal = (warning: string): ParseResult => ({
    transactions: [],
    holdings: [],
    format: 'camt053',
    warnings: [warning],
  });

  let document: unknown;
  try {
    const parsed: { Document?: unknown } | null = await xml2js.parseStringPromise(content, {
      // `<ns2:Stmt>` and `<Stmt>` are the same element.
      tagNameProcessors: [(name: string) => name.replace(/^.*:/, '')],
    });
    document = parsed?.Document;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refusal(`Failed to parse CAMT.053: ${message.split('\n')[0]}`);
  }

  const found = at(document, 'BkToCstmrStmt', 'Stmt');
  if (found.length === 0) {
    const other = Object.keys(OTHER_MESSAGES).find((element) => at(document, element).length > 0);
    return refusal(
      other
        ? `This is a ${OTHER_MESSAGES[other]} file, not a camt.053 statement, so nothing was imported`
        : 'No CAMT.053 statement found in the file'
    );
  }

  const warnings: string[] = [];
  const unbooked = { count: 0 };
  const statements = found.map((statement) => readStatement(statement, warnings, unbooked));
  if (unbooked.count > 0) {
    warnings.push(
      unbooked.count === 1
        ? '1 entry not yet booked was skipped'
        : `${unbooked.count} entries not yet booked were skipped`
    );
  }
  return balancedStatementResult('camt053', statements, warnings);
}

function readStatement(
  statement: unknown,
  warnings: string[],
  unbooked: { count: number }
): BalancedStatement {
  const balances = (code: string) =>
    at(statement, 'Bal')
      .filter((balance) => first(balance, 'Tp', 'CdOrPrtry', 'Cd') === code)
      .flatMap((balance) => readBalance(balance) ?? []);
  // `PRCD` is the previous statement's close, which is where this one opens.
  const opening = balances('OPBD')[0] ?? balances('PRCD')[0];
  const closing = balances('CLBD').at(-1);
  const currency = first(statement, 'Acct', 'Ccy') || (closing ?? opening)?.currency || '';
  const account =
    first(statement, 'Acct', 'Id', 'IBAN') || first(statement, 'Acct', 'Id', 'Othr', 'Id');
  const owner = clean(first(statement, 'Acct', 'Ownr', 'Nm'));

  const transactions: ParsedTransaction[] = [];
  for (const entry of at(statement, 'Ntry')) {
    // Version 02 writes `<Sts>BOOK</Sts>`, later ones `<Sts><Cd>BOOK</Cd></Sts>`.
    if ((first(entry, 'Sts', 'Cd') || first(entry, 'Sts')) !== 'BOOK') {
      unbooked.count += 1;
      continue;
    }
    const amountNode = at(entry, 'Amt')[0];
    const magnitude = text(amountNode);
    const indicator = first(entry, 'CdtDbtInd');
    const date = readDay(at(entry, 'BookgDt')[0]) ?? readDay(at(entry, 'ValDt')[0]);
    const entryCurrency = currencyOf(amountNode) || currency;
    const credit = indicator === 'CRDT';
    if (
      !date ||
      !entryCurrency ||
      !isValidDecimalString(magnitude) ||
      !(credit || indicator === 'DBIT')
    ) {
      warnings.push('Statement entry not understood, skipped');
      continue;
    }

    const amount = new Decimal(magnitude);
    const reference = first(entry, 'AcctSvcrRef');
    transactions.push({
      date,
      description: describe(entry, credit, owner),
      amount: (credit ? amount : amount.neg()).toNumber() + 0,
      currency: entryCurrency,
      // A bank may give a reversal its original's reference, so the reference
      // alone would merge the two rows. Direction and amount tell them apart.
      ...(reference
        ? { raw: { id: `${reference}:${indicator}:${amount.toFixed()}`, reference } }
        : {}),
    });
  }

  return { account: `${account} ${currency}`, opening, closing, transactions };
}

function readBalance(balance: unknown): StatedBalance | null {
  const amountNode = at(balance, 'Amt')[0];
  const magnitude = text(amountNode);
  const day = readDay(at(balance, 'Dt')[0]);
  const currency = currencyOf(amountNode);
  if (!day || !currency || !isValidDecimalString(magnitude)) return null;
  const amount = new Decimal(magnitude);
  return {
    currency,
    day,
    amount: first(balance, 'CdtDbtInd') === 'DBIT' ? amount.neg() : amount,
  };
}

/** The counterparty's name, then the remittance text; failing both, what the bank says of the entry. */
function describe(entry: unknown, credit: boolean, owner: string): string {
  const details = at(entry, 'NtryDtls', 'TxDtls');
  const only = details.length === 1 ? details[0] : null;
  const remittance = [
    ...at(only, 'RmtInf', 'Ustrd'),
    ...at(only, 'RmtInf', 'Strd', 'CdtrRefInf', 'Ref'),
  ].map(text);
  return (
    clean([counterparty(only, credit, owner), ...remittance].join(' ')) ||
    clean(first(entry, 'AddtlNtryInf')) ||
    clean(first(only, 'AddtlTxInf')) ||
    first(entry, 'NtryDtls', 'Btch', 'PmtInfId') ||
    'Unknown'
  );
}

/**
 * A credit comes from the debtor and a debit goes to the creditor. Where a
 * bank names only one party, it is the other side unless it is the account
 * owner. Version 08 nests the name under `Pty`.
 */
function counterparty(details: unknown, credit: boolean, owner: string): string {
  const named = (role: string) =>
    clean(
      first(details, 'RltdPties', role, 'Nm') || first(details, 'RltdPties', role, 'Pty', 'Nm')
    );
  const sides = credit ? ['Dbtr', 'Cdtr'] : ['Cdtr', 'Dbtr'];
  return (
    sides.map(named).find((name) => name !== '' && name.toUpperCase() !== owner.toUpperCase()) ?? ''
  );
}
