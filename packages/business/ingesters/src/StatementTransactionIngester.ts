import type { NewHoldingTransaction } from '@scani/db/schema';
import { type ParsedTransaction, type ParseResult, statementPayee } from '@scani/file-import';
import { createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import { Service } from 'typedi';

interface StatementIngesterInput {
  accountId: string;
  parseResult: ParseResult;
  defaultCurrency?: string;
}

/**
 * A ledger row as the statement states it. It names no holding and no token:
 * the write path resolves both from the currency of the line it sits in.
 */
export type StatementRow = Pick<
  NewHoldingTransaction,
  'kind' | 'source' | 'sourceMetadata' | 'rawPayload'
> & {
  quantity: string;
  occurredAt: Date;
  externalId: string;
  counterparty: string | null;
};

/** One parsed transaction: its row, then its fee row when it has one. */
export interface StatementLine {
  currency: string;
  rows: StatementRow[];
}

/** One parsed transaction with no currency to import it under: the warning that says so, and its date. */
interface SkippedStatementLine {
  skipped: string;
  at: Date;
}

export interface StatementClose {
  currency: string;
  at: Date;
  balance: string;
}

export interface StatementIngesterResult {
  format: ParseResult['format'];
  bankTemplate: string | null;
  /** Every parsed transaction, in file order. */
  lines: Array<StatementLine | SkippedStatementLine>;
  /** The balance the statement ends on, when its last row carries one. */
  closes: StatementClose[];
  /** The parser's own warnings. */
  warnings: string[];
}

const unknownCurrency = (currency: string) =>
  `Unknown currency '${currency}' — statement rows for this currency skipped`;

/**
 * The warnings an import reports, once the write path has said which
 * currencies it could not place: the parser's, then each transaction's in file
 * order, then the close's. An unknown currency warns once per transaction in
 * it, and once more for a close in it.
 */
export function statementWarnings(
  result: StatementIngesterResult,
  unknownCurrencies: ReadonlySet<string>
): string[] {
  return [
    ...result.warnings,
    ...result.lines.flatMap((line) => {
      if ('skipped' in line) return [line.skipped];
      return unknownCurrencies.has(line.currency) ? [unknownCurrency(line.currency)] : [];
    }),
    ...result.closes
      .filter((close) => unknownCurrencies.has(close.currency))
      .map((close) => unknownCurrency(close.currency)),
  ];
}

@Service()
export class StatementTransactionIngester {
  private readonly logger = createComponentLogger('ingester:statement');

  readonly source = 'statement';

  ingest(input: StatementIngesterInput): StatementIngesterResult {
    const { parseResult } = input;
    const lines: StatementIngesterResult['lines'] = [];
    const closes: StatementClose[] = [];
    const currencyOf = (tx: ParsedTransaction) =>
      (tx.currency || input.defaultCurrency || parseResult.detectedCurrency || '')
        .trim()
        .toUpperCase();

    const sourceTag = `statement-${parseResult.format}`;

    // Row ordinals guarantee a deterministic external_id for formats
    // (CSV, QIF) that lack a natural one — keeps re-uploads idempotent
    // while distinguishing genuinely-different lines within one file.
    let ordinal = 0;

    for (const tx of parseResult.transactions) {
      ordinal += 1;
      const currency = currencyOf(tx);
      if (!currency) {
        lines.push({
          skipped: `Transaction without currency at ${tx.date.toISOString()} — skipped (consider setting defaultCurrency on the account)`,
          at: tx.date,
        });
        continue;
      }

      // Bank-statement amounts are signed money flow (positive = credit,
      // negative = debit). Store as-is and derive `kind` from sign —
      // fiat rows have no "swap" concept.
      const amt = new Decimal(tx.amount);
      const kind = amt.isPositive() ? 'deposit' : amt.isNegative() ? 'withdraw' : 'unknown';

      const occurredAt = tx.date;
      const externalId = this.buildExternalId(tx, ordinal);
      // Marked, because elsewhere `counterparty` is an address or an account
      // identifier and this is a best reading of free text (SC-1325).
      const payee = statementPayee(tx.description);
      const rawPayload = (tx.raw ?? null) as Record<string, unknown> | null;

      const rows: StatementRow[] = [
        {
          kind,
          quantity: amt.toFixed(),
          occurredAt,
          externalId,
          source: sourceTag,
          counterparty: payee,
          sourceMetadata: {
            description: tx.description,
            bankTemplate: parseResult.bankTemplate ?? null,
            format: parseResult.format,
            ...(payee === null ? {} : { counterpartyFrom: 'description' }),
          },
          rawPayload,
        },
      ];

      // A statement fee is its OWN ledger row, not `fee_quantity` on the one
      // above.
      //
      // `fee_quantity` is a sidecar: nothing sums it. Balance-at-time and the
      // opening-balance reconciler both add up `quantity` alone, which is why
      // the schema's own note on that column reads "negative for outflows
      // (sell, withdraw, fee)". So writing the £1.50 into `fee_quantity` would
      // have made it visible in the export and left the arithmetic exactly as
      // wrong as dropping it: the reconciler derived a 1898.00 opening for a
      // statement whose own first row proves 1899.50, and buried the £1.50 in
      // a synthetic row the user never sees (SC-136).
      //
      // A bank fee is also a real, separately-priced movement of the same
      // currency — the statement's Balance column has already moved by it —
      // which is precisely what a `kind='fee'` row means here. Cost basis
      // skips that kind by name, so this adds nothing to the lot pool.
      if (tx.fee !== undefined && tx.fee !== 0) {
        rows.push({
          kind: 'fee',
          quantity: new Decimal(tx.fee).abs().neg().toFixed(),
          // Same instant as its parent. The ledger is ordered by
          // `occurred_at` and a fee that sorts away from the movement that
          // incurred it reads as an unexplained charge.
          occurredAt,
          // Suffixed from the parent's id rather than given its own ordinal,
          // so a re-upload dedups against the same row — `bulkUpsert` keys on
          // (holding_id, source, external_id).
          externalId: `${externalId}:fee`,
          source: sourceTag,
          counterparty: null,
          sourceMetadata: {
            description: tx.description ? `Fee — ${tx.description}` : 'Fee',
            bankTemplate: parseResult.bankTemplate ?? null,
            format: parseResult.format,
            feeForExternalId: externalId,
          },
          rawPayload,
        });
      }
      lines.push({ currency, rows });
    }

    // Anchor balance-at-time at the statement's period end via a single
    // closing balance. Intra-statement running balances are ignored — one
    // anchor per upload is enough.
    const sorted = [...parseResult.transactions].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );
    const last = sorted[sorted.length - 1];
    if (last?.balance !== undefined && last.balance !== null) {
      const currency = currencyOf(last);
      if (currency) {
        closes.push({ currency, at: last.date, balance: new Decimal(last.balance).toFixed() });
      }
    }

    this.logger.info(
      {
        accountId: input.accountId,
        format: parseResult.format,
        lineCount: lines.length,
        closeCount: closes.length,
      },
      'Statement ingestion complete'
    );

    return {
      format: parseResult.format,
      bankTemplate: parseResult.bankTemplate ?? null,
      lines,
      closes,
      warnings: [...parseResult.warnings],
    };
  }

  // Prefer source-native ids (`raw.id` / `fitid` / `txid`) so identical
  // re-uploads dedup; synthesize from (date, amount, description, ordinal)
  // only when nothing natural exists.
  private buildExternalId(tx: ParsedTransaction, ordinal: number): string {
    const natural =
      tx.raw?.id ?? tx.raw?.fitid ?? tx.raw?.FITID ?? tx.raw?.txid ?? tx.raw?.transactionId;
    if (natural) return `natural:${natural}`;
    const desc = (tx.description || '').replace(/\s+/g, ' ').slice(0, 40);
    const date = tx.date.toISOString().slice(0, 19);
    return `synthetic:${date}:${tx.amount}:${desc}:${ordinal}`;
  }
}
